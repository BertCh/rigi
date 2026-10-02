// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { LAYER_INKS } from "./inks";
import { demToPx, type GipfelbuchPeak, type GipfelbuchPhotoData } from "./real";

// Pure logic of StoryMap (viz/StoryMap.tsx): which peaks the map names, the skyline footprint on the
// DEM patch, the ray draw-on, how the map follows its story, the cone fit for minis and the search
// loop clock. No React, so every rule is specced in __tests__/story-map.spec.ts.

// Motion constants, named after the grammar tokens (reports/gipfelbuch-explainers-2026-10-02/grammar.md).
// Swap to imports from ./motion when it lands.
/** MOTION.settle */
export const SETTLE_MS = 620;
/** MOTION.sweep */
export const SWEEP_MS = 4200;
export const LEAD_MS = 80;
export const BEAT_MS = 2800;
export const RESULT_HOLD = 1.6;
export const REPLAY_FADE_MS = 450;
export const QUICK_MS = 160;
/** MOTION.draw */
export const DRAW_MS = 900;
/** ease.out */
export const easeOut = (t: number) => 1 - (1 - t) ** 3;

/** DemPatch's square viewBox side. */
export const MAP_SIZE = 400;
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
export const wrap180 = (a: number) => ((((a + 180) % 360) + 360) % 360) - 180;

export function mixHex(a: string, b: string, t: number): string {
	const c = (h: string, i: number) => Number.parseInt(h.slice(i, i + 2), 16);
	const u = clamp01(t);
	return `#${[1, 3, 5]
		.map((i) =>
			Math.round(c(a, i) + (c(b, i) - c(a, i)) * u)
				.toString(16)
				.padStart(2, "0"),
		)
		.join("")}`;
}

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

/** The parts of `runs` inside and outside the view cone; the boundary point is shared by both sides. */
export function splitByCone(
	runs: FootprintRun[],
	yaw: number,
	hfov: number,
): { inside: FootprintRun[]; outside: FootprintRun[] } {
	const inside: FootprintRun[] = [];
	const outside: FootprintRun[] = [];
	const isIn = (az: number) => Math.abs(wrap180(az - yaw)) <= hfov / 2;
	for (const run of runs) {
		let part: FootprintRun | null = null;
		let partIn = false;
		const close = () => {
			if (part && part.pts.length >= 2) (partIn ? inside : outside).push(part);
			part = null;
		};
		run.pts.forEach((pt, i) => {
			const az = run.azs[i];
			const here = isIn(az);
			if (part && here !== partIn) {
				part.pts.push(pt);
				part.azs.push(az);
				part.az1 = az;
				close();
				const last = run.pts[i - 1];
				part = {
					pts: [last],
					azs: [run.azs[i - 1]],
					az0: run.azs[i - 1],
					az1: run.azs[i - 1],
				};
				partIn = here;
			}
			if (!part) {
				part = { pts: [], azs: [], az0: az, az1: az };
				partIn = here;
			}
			part.pts.push(pt);
			part.azs.push(az);
			part.az1 = az;
		});
		close();
	}
	return { inside, outside };
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

/** Follow a drag-like run of small, fast steps at once; settle over SETTLE_MS otherwise. */
export function followMode(
	prev: { target: number; at: number },
	next: { target: number; at: number },
): "instant" | "settle" {
	return Math.abs(next.target - prev.target) < 0.08 && next.at - prev.at < 90
		? "instant"
		: "settle";
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
	const reach = halfKm * 1600;
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
		return aspect >= 1
			? { x: 0, y: (size - size / aspect) / 2, w: size, h: size / aspect }
			: { x: (size - size * aspect) / 2, y: 0, w: size * aspect, h: size };
	}
	return {
		x: Math.min(size - w, Math.max(0, cx - w / 2)),
		y: Math.min(size - h, Math.max(0, cy - h / 2)),
		w,
		h,
	};
}

/**
 * The search loop clock: lead (t = 0), a damped sweep either side of the guess that settles on the
 * solved pose, a hold with the rays drawn, then a fade (`fade` 0..1) before it repeats.
 */
export function searchT(ms: number): {
	t: number;
	phase: "lead" | "sweep" | "hold" | "fade";
	fade: number;
	/** Ray draw-on progress 0..1: only in the hold, so the sweep's overshoot never flickers them. */
	rays: number;
} {
	const hold = BEAT_MS * RESULT_HOLD;
	const total = LEAD_MS + SWEEP_MS + hold + REPLAY_FADE_MS;
	const m = ((ms % total) + total) % total;
	if (m < LEAD_MS) return { t: 0, phase: "lead", fade: 0, rays: 0 };
	if (m < LEAD_MS + SWEEP_MS) {
		const u = (m - LEAD_MS) / SWEEP_MS;
		return {
			t: 1 - Math.cos(3 * Math.PI * u) * (1 - u) ** 1.4,
			phase: "sweep",
			fade: 0,
			rays: 0,
		};
	}
	if (m < LEAD_MS + SWEEP_MS + hold)
		return {
			t: 1,
			phase: "hold",
			fade: 0,
			rays: easeOut(clamp01((m - LEAD_MS - SWEEP_MS) / DRAW_MS)),
		};
	return {
		t: 1,
		phase: "fade",
		fade: clamp01((m - LEAD_MS - SWEEP_MS - hold) / REPLAY_FADE_MS),
		rays: 1,
	};
}

/** Total length of one search loop, ms. */
export const SEARCH_LOOP_MS =
	LEAD_MS + SWEEP_MS + BEAT_MS * RESULT_HOLD + REPLAY_FADE_MS;
