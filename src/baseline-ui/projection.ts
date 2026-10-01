// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/** Overlay geometry (SVG paths, label placement) in working-image pixels. */
import {
	azimuthElevation,
	type Camera,
	directionENU,
	project,
	unproject,
} from "#/lib/geo/camera";
import type {
	BaselinePeakLabel,
	HorizonLite,
	SkylineObservation,
} from "./types";

const f1 = (v: number) => v.toFixed(1);

/** Azimuth interval (start, span; degrees) covering the image, with margin. */
export function viewAzimuthRange(cam: Camera): [number, number] {
	if (Math.abs(cam.pitch) > 60) return [0, 360];
	const rel: number[] = [];
	const N = 8;
	for (let i = 0; i <= N; i++) {
		const t = i / N;
		for (const [x, y] of [
			[t * cam.width, 0],
			[t * cam.width, cam.height],
			[0, t * cam.height],
			[cam.width, t * cam.height],
		]) {
			const [az] = azimuthElevation(unproject(cam, x, y));
			rel.push(((az - cam.yaw + 540) % 360) - 180);
		}
	}
	const lo = Math.min(...rel) - 3;
	const hi = Math.max(...rel) + 3;
	if (hi - lo >= 360) return [0, 360];
	return [cam.yaw + lo, hi - lo];
}

/** Polyline through (az, el(az)) for the in-view azimuths. */
function curvePath(
	cam: Camera,
	count: number,
	step: number,
	el: (i: number) => number,
) {
	const [start, span] = viewAzimuthRange(cam);
	const i0 = Math.floor(start / step);
	const i1 = Math.ceil((start + span) / step);
	const parts: string[] = [];
	let pen = false;
	let prevX = 0;
	const maxJump = cam.width / 4;
	for (let j = i0; j <= i1; j++) {
		const i = ((j % count) + count) % count;
		const e = el(i);
		const p = Number.isFinite(e)
			? project(cam, directionENU(i * step, e))
			: null;
		const ok =
			p &&
			p[0] > -cam.width * 0.1 &&
			p[0] < cam.width * 1.1 &&
			p[1] > -cam.height &&
			p[1] < cam.height * 2;
		if (!ok) {
			pen = false;
			continue;
		}
		if (pen && Math.abs(p[0] - prevX) > maxJump) pen = false;
		parts.push(`${pen ? "L" : "M"}${f1(p[0])} ${f1(p[1])}`);
		prevX = p[0];
		pen = true;
	}
	return parts.join("");
}

export const skylinePath = (cam: Camera, h: HorizonLite) =>
	curvePath(cam, h.elevation.length, h.step, (i) => h.elevation[i]);

export const geometricHorizonPath = (cam: Camera) =>
	curvePath(cam, 720, 0.5, () => 0);

/** Near = warm, far = cool (same scale as scripts/baseline.ts). */
export const RIDGE_BUCKETS = 8;
export function distanceBucket(d: number) {
	const t = Math.min(1, Math.log10(Math.max(d, 500) / 500) / Math.log10(200));
	return Math.min(RIDGE_BUCKETS - 1, Math.floor(t * RIDGE_BUCKETS));
}
export const bucketColor = (b: number) =>
	`hsl(${20 + ((b + 0.5) / RIDGE_BUCKETS) * 200} 95% 55%)`;

/** One path of zero-length segments (round caps → dots) per distance bucket. */
export function ridgePaths(cam: Camera, h: HorizonLite): string[] {
	const [start, span] = viewAzimuthRange(cam);
	const out: string[][] = Array.from({ length: RIDGE_BUCKETS }, () => []);
	for (let i = 0; i < h.ridgeAz.length; i++) {
		const rel = (((h.ridgeAz[i] - start) % 360) + 360) % 360;
		if (rel > span) continue;
		const p = project(cam, directionENU(h.ridgeAz[i], h.ridgeEl[i]));
		if (!p || p[0] < 0 || p[0] > cam.width || p[1] < 0 || p[1] > cam.height)
			continue;
		out[distanceBucket(h.ridgeDist[i])].push(`M${f1(p[0])} ${f1(p[1])}h0`);
	}
	return out.map((o) => o.join(""));
}

/** Detected photo skyline, rescaled from its analysis width to the working image. */
export function detectedSkylinePath(sky: SkylineObservation, width: number) {
	const s = width / sky.width;
	const parts: string[] = [];
	let pen = false;
	for (let c = 0; c < sky.rows.length; c++) {
		const r = sky.rows[c];
		if (!Number.isFinite(r)) {
			pen = false;
			continue;
		}
		parts.push(`${pen ? "L" : "M"}${f1((c + 0.5) * s)} ${f1(r * s)}`);
		pen = true;
	}
	return parts.join("");
}

/** Nearest predicted skyline sample to (x, y) within maxDist px. */
export function nearestSkylinePoint(
	cam: Camera,
	h: HorizonLite,
	x: number,
	y: number,
	maxDist: number,
) {
	const [start, span] = viewAzimuthRange(cam);
	const n = h.elevation.length;
	let best: { azimuth: number; elevation: number; d: number } | null = null;
	for (let j = Math.floor(start / h.step); j <= (start + span) / h.step; j++) {
		const i = ((j % n) + n) % n;
		const p = project(cam, directionENU(i * h.step, h.elevation[i]));
		if (!p) continue;
		const d = Math.hypot(p[0] - x, p[1] - y);
		if (d < maxDist && (!best || d < best.d))
			best = { azimuth: i * h.step, elevation: h.elevation[i], d };
	}
	return best;
}

export const labelText = (l: { name: string; ele?: number }) =>
	[l.name, l.ele !== undefined ? `${Math.round(l.ele)}` : ""]
		.filter(Boolean)
		.join(" ") || "peak";

/**
 * Greedy placement: biggest peaks first, each label stacked above its anchor
 * at the lowest level that does not overlap an already placed label.
 * `k` = working-image pixels per screen pixel (label sizing).
 */
export function placeLabels(
	cands: BaselinePeakLabel[],
	k: number,
	width: number,
	maxLabels = 30,
): BaselinePeakLabel[] {
	const sorted = [...cands].sort((a, b) => (b.ele ?? 0) - (a.ele ?? 0));
	const boxes: [number, number, number, number][] = [];
	const out: BaselinePeakLabel[] = [];
	const lineH = 15 * k;
	for (const c of sorted) {
		if (out.length >= maxLabels) break;
		const w = (labelText(c).length * 6.6 + 8) * k;
		// Keep the text inside the frame; the leader line still hits the anchor.
		const lx = Math.min(Math.max(c.x, w / 2), Math.max(w / 2, width - w / 2));
		for (let level = 0; level < 6; level++) {
			const ly = Math.max(lineH, c.y - (26 + level * 17) * k);
			const box: [number, number, number, number] = [
				lx - w / 2,
				ly - lineH,
				lx + w / 2,
				ly + 3 * k,
			];
			const hit = boxes.some(
				(b) => b[0] < box[2] && box[0] < b[2] && b[1] < box[3] && box[1] < b[3],
			);
			if (hit) continue;
			boxes.push(box);
			out.push({ ...c, lx, ly });
			break;
		}
	}
	return out;
}
