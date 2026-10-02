// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { mixHex as mixHexRaw } from "./ground";
import { LAYER_INKS } from "./inks";
import { ease, MOTION } from "./motion";
import { demToPx, type GipfelbuchPeak, type GipfelbuchPhotoData } from "./real";

// Pure logic of StoryMap (viz/StoryMap.tsx): which peaks the map names, the skyline footprint on the
// DEM patch, the ray draw-on, how the map follows its story, the cone fit for minis and the search
// loop clock. No React, so every rule is specced in __tests__/story-map.spec.ts.

/** DemPatch's square viewBox side. */
export const MAP_SIZE = 400;
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
export const wrap180 = (a: number) => ((((a + 180) % 360) + 360) % 360) - 180;

/** One implementation (ground.ts), behind a clamp on t. */
export const mixHex = (a: string, b: string, t: number) =>
	mixHexRaw(a, b, clamp01(t));

type Crop = [number, number, number, number];

/**
 * The peaks the map names: the photo's own label set (RealPhoto): labelled peaks with a solved pixel
 * inside `crop`, then those with a prior pixel inside it, each capped at `maxLabels`, deduped by name.
 * `context` is every other labelled peak within the patch, drawn as unnamed pencil ticks.
 */
export function mapPeakSet(
	d: GipfelbuchPhotoData,
	{ crop, maxLabels = 10 }: { crop?: Crop; maxLabels?: number } = {},
): { named: GipfelbuchPeak[]; context: GipfelbuchPeak[] } {
	const [x0, y0, x1, y1] = crop ?? [0, 0, d.photo.width, d.photo.height];
	const inCrop = (q: [number, number] | null) =>
		!!q && q[0] >= x0 && q[0] <= x1 && q[1] >= y0 && q[1] <= y1;
	const solved = d.peaks
		.filter((p) => p.labelled && inCrop(p.solved))
		.slice(0, maxLabels);
	const prior = d.peaks
		.filter((p) => p.labelled && inCrop(p.prior))
		.slice(0, maxLabels);
	const seen = new Set<string>();
	const named: GipfelbuchPeak[] = [];
	for (const p of [...solved, ...prior]) {
		if (seen.has(p.name)) continue;
		seen.add(p.name);
		named.push(p);
	}
	const reach = d.demPatch.halfKm * 1000 * 1.35;
	const context = d.peaks.filter(
		(p) => p.labelled && !seen.has(p.name) && p.distance < reach,
	);
	return { named, context };
}

export type FootprintRun = {
	pts: [number, number][];
	/** Azimuth of each point (same length as pts). */
	azs: number[];
	az0: number;
	az1: number;
};

/**
 * Where the photo's skyline stands on the map: the (az, d) of the skyline-forming ground from
 * `horizon.profile`, as runs of map points. A run breaks where the distance jumps by more than 12 %
 * (a different ridge), where the azimuth steps by more than two profile steps, or where the line
 * leaves the square.
 */
export function footprintRuns(
	d: GipfelbuchPhotoData,
	size = MAP_SIZE,
): FootprintRun[] {
	const margin = 4;
	const maxStep = 2 * d.horizon.step;
	const runs: FootprintRun[] = [];
	let cur: FootprintRun | null = null;
	let prev: { az: number; d: number } | null = null;
	const flush = () => {
		if (cur && cur.pts.length >= 2) runs.push(cur);
		cur = null;
	};
	for (const s of d.horizon.profile) {
		const q = demToPx(d.demPatch.halfKm, s.az, s.d, size);
		const inside =
			q[0] > margin &&
			q[1] > margin &&
			q[0] < size - margin &&
			q[1] < size - margin;
		if (!inside) {
			flush();
			prev = null;
			continue;
		}
		if (
			cur &&
			prev &&
			(Math.abs(s.d - prev.d) / Math.max(s.d, prev.d) > 0.12 ||
				Math.abs(wrap180(s.az - prev.az)) > maxStep)
		)
			flush();
		if (!cur) cur = { pts: [], azs: [], az0: s.az, az1: s.az };
		cur.pts.push(q);
		cur.azs.push(s.az);
		cur.az1 = s.az;
		prev = { az: s.az, d: s.d };
	}
	flush();
	return runs;
}

/** A named peak's ink inside the live cone: the guess layer's RM at t = 0, the solved layer's ink at 1. null = outside, pencil. */
export function peakInk(t: number, inside: boolean): string | null {
	return inside
		? mixHex(LAYER_INKS.priorPeaks.paperHex, LAYER_INKS.peaks.paperHex, t)
		: null;
}

/** How much of ray `rank` is drawn at story t: they draw on over the last stretch of the swing, by rank. */
export function rayDraw(t: number, rank: number, count: number): number {
	const start = 0.82 + (0.1 * rank) / Math.max(1, count - 1);
	return clamp01((t - start) / (1 - start));
}

/**
 * A stream of updates (a drag, a scrub, a sweep) is followed at once, whatever the step; a lone jump
 * of 0.08 or more settles over MOTION.settle.
 */
export function followMode(
	prev: { target: number; at: number },
	next: { target: number; at: number },
): "instant" | "settle" {
	if (next.at - prev.at < 90) return "instant";
	return Math.abs(next.target - prev.target) < 0.08 ? "instant" : "settle";
}

export type Placed = {
	p: GipfelbuchPeak;
	x: number;
	y: number;
	/** Beyond the patch: put on the rim along its bearing. */
	rim: boolean;
	km: number;
	/** The label is drawn (declutterRim may drop it). */
	label: boolean;
};

/**
 * Where each named peak is drawn: at its exact map pixel inside the square (4 px margin), else on a rim
 * circle at `size / 2 - 16` along its bearing, so the photo's named summits all show even when the patch
 * is smaller than the view.
 */
export function placeNamed(
	d: GipfelbuchPhotoData,
	named: GipfelbuchPeak[],
	size = MAP_SIZE,
): Placed[] {
	const margin = 4;
	const c = size / 2;
	return named.map((p) => {
		const [x, y] = demToPx(d.demPatch.halfKm, p.az, p.distance, size);
		const km = Math.round(p.distance / 1000);
		if (x > margin && y > margin && x < size - margin && y < size - margin)
			return { p, x, y, rim: false, km, label: true };
		const r = c - 16;
		const a = (p.az * Math.PI) / 180;
		return {
			p,
			x: c + Math.sin(a) * r,
			y: c - Math.cos(a) * r,
			rim: true,
			km,
			label: true,
		};
	});
}

/**
 * Walks the rim peaks by bearing and drops the label (the ray and the tick stay) of any whose rim
 * point lies within `minGap` of a label already kept.
 */
export function declutterRim(placed: Placed[], minGap = 16): Placed[] {
	const kept: Placed[] = [];
	const drop = new Set<Placed>();
	const byAz = placed
		.filter((q) => q.rim)
		.sort((a, b) => wrap180(a.p.az) - wrap180(b.p.az));
	for (const q of byAz) {
		if (kept.some((k) => Math.hypot(k.x - q.x, k.y - q.y) < minGap))
			drop.add(q);
		else kept.push(q);
	}
	return placed.map((q) => (drop.has(q) ? { ...q, label: false } : q));
}

/**
 * The viewBox box that shows the camera and both cones (guess and solved) with `pad` around it,
 * widened to `aspect` (w / h) and kept inside the square. When that cannot fit, the whole square
 * cropped centrally to the aspect.
 */
export function coneFitBox(
	d: GipfelbuchPhotoData,
	aspect: number,
	pad = 0.08,
	size = MAP_SIZE,
): { x: number; y: number; w: number; h: number } {
	const halfKm = d.demPatch.halfKm;
	// stay inside the patch: a cone drawn out to 1.6 half-widths is clipped by the square anyway
	const reach = Math.min(halfKm * 1600, 0.92 * halfKm * 1000);
	const c = size / 2;
	let x0 = c;
	let y0 = c;
	let x1 = c;
	let y1 = c;
	const add = (q: [number, number]) => {
		const x = Math.min(size, Math.max(0, q[0]));
		const y = Math.min(size, Math.max(0, q[1]));
		x0 = Math.min(x0, x);
		y0 = Math.min(y0, y);
		x1 = Math.max(x1, x);
		y1 = Math.max(y1, y);
	};
	for (const cam of [d.prior, d.solved]) {
		const a0 = cam.yaw - cam.hfov / 2;
		const steps = Math.max(1, Math.ceil(cam.hfov / 2));
		for (let i = 0; i <= steps; i++)
			add(demToPx(halfKm, a0 + (cam.hfov * i) / steps, reach, size));
	}
	let w = (x1 - x0) * (1 + 2 * pad);
	let h = (y1 - y0) * (1 + 2 * pad);
	const cx = (x0 + x1) / 2;
	const cy = (y0 + y1) / 2;
	if (w / h < aspect) w = h * aspect;
	else h = w / aspect;
	if (w > size || h > size) {
		// the widest box of this aspect that fits, centred on the cones' box, then clamped to the square
		if (aspect >= 1) {
			w = size;
			h = size / aspect;
		} else {
			h = size;
			w = size * aspect;
		}
	}
	return {
		x: Math.min(size - w, Math.max(0, cx - w / 2)),
		y: Math.min(size - h, Math.max(0, cy - h / 2)),
		w,
		h,
	};
}

/**
 * The search loop clock: fade in on the guess, a lead, a damped sweep either side of the guess that
 * settles on the solved pose, a hold with the rays drawing on, then a fade out before it repeats.
 * `opacity` is 0 at the loop's start and end, so the wrap never flashes.
 */
export function searchT(ms: number): {
	t: number;
	phase: "fadeIn" | "lead" | "sweep" | "hold" | "fadeOut";
	/** Live layer opacity 0..1. */
	opacity: number;
	/** Ray draw-on progress 0..1: only in the hold, so the sweep's overshoot never flickers them. */
	rays: number;
} {
	const { replayFade, lead, sweep, draw } = MOTION;
	const hold = MOTION.beat * MOTION.resultHold;
	const m = ((ms % SEARCH_LOOP_MS) + SEARCH_LOOP_MS) % SEARCH_LOOP_MS;
	if (m < replayFade)
		return { t: 0, phase: "fadeIn", opacity: m / replayFade, rays: 0 };
	let r = m - replayFade;
	if (r < lead) return { t: 0, phase: "lead", opacity: 1, rays: 0 };
	r -= lead;
	if (r < sweep) {
		const u = r / sweep;
		return {
			t: 1 - Math.cos(3 * Math.PI * u) * (1 - u) ** 1.4,
			phase: "sweep",
			opacity: 1,
			rays: 0,
		};
	}
	r -= sweep;
	if (r < hold)
		return {
			t: 1,
			phase: "hold",
			opacity: 1,
			rays: ease.out(clamp01(r / draw)),
		};
	r -= hold;
	return {
		t: 1,
		phase: "fadeOut",
		opacity: 1 - clamp01(r / replayFade),
		rays: 1,
	};
}

/** Total length of one search loop, ms. */
export const SEARCH_LOOP_MS =
	MOTION.replayFade * 2 +
	MOTION.lead +
	MOTION.sweep +
	MOTION.beat * MOTION.resultHold;
