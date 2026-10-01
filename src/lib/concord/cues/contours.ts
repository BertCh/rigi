// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Interior occluding contours from a photo-space range buffer (WP-C).
//
// A contour pixel p is a non-sky DEM hit (range ≥ minRangeM) with a non-sky neighbour q that is
// farther by more than `ratio` (log-range jump > log ratio): p lies on the silhouette of a nearer ridge
// against farther terrain. Contours adjoining the sky within skyGapPx (the skyline and its slivers)
// are dropped. Components shorter than minLenPx are dropped (DEM noise), the rest are subsampled at
// stepPx and each sample is refined to the silhouette by bisecting rays between p and the far side
// (GeomBuffer.cast), so u,v is sub-pixel. Normals point from the occluder into the occluded
// (farther) side, in isotropic pixel units (x right, y down). Pixel lengths are @1600 (long side).
import { DEG } from "../../geodesy";
import { type CameraX, type Cue, projectX, type Vec3 } from "../core";
import type { EdgeCue, GeomBuffer } from "./types";

export type ContourOpts = {
	minRangeM?: number;
	ratio?: number;
	/** Sample spacing along contours, px @1600. Default 8. */
	stepPx?: number;
	/** Minimum component length (pixels of the buffer scaled to @1600). Default 24. */
	minLenPx?: number;
	/** Drop contours within this many px @1600 (along the normal) of sky. Default 6. */
	skyGapPx?: number;
	/** DEM vertical/silhouette σ (m) as a function of horizontal distance. */
	demSigmaM?: (d: number) => number;
	/** Bisection iterations of the silhouette refinement. Default 10. */
	refineIters?: number;
};

/** Focal length in px @1600 (long side 1600). */
export function focal1600(cam: CameraX): number {
	const H = cam.aspect >= 1 ? 1600 / cam.aspect : 1600;
	return (H / 2 / Math.tan((cam.pose.vfov * DEG) / 2)) * cam.intr.fScale;
}

export const defaultDemSigmaM = (d: number) => 3 + 0.001 * d;

export function occludingContourCues(
	g: GeomBuffer,
	cam: CameraX,
	opts: ContourOpts = {},
): Cue[] {
	return occludingContourCuesX(g, cam, opts).cues;
}

/** As occludingContourCues, plus the raw boundary mask (for audits). */
export function occludingContourCuesX(
	g: GeomBuffer,
	cam: CameraX,
	opts: ContourOpts = {},
): { cues: EdgeCue[]; boundary: Uint8Array } {
	const { w, h, range, sky } = g;
	const minRange = opts.minRangeM ?? 300;
	const logRatio = Math.log(opts.ratio ?? 1.3);
	const toBuf = Math.max(w, h) / 1600; // @1600 px → buffer px
	const stepBuf = Math.max(1, (opts.stepPx ?? 8) * toBuf);
	const minLen = Math.max(2, Math.round((opts.minLenPx ?? 24) * toBuf));
	const skyGap = Math.max(1, Math.ceil((opts.skyGapPx ?? 6) * toBuf));
	const demSigma = opts.demSigmaM ?? defaultDemSigmaM;
	const iters = opts.refineIters ?? 10;
	const fPx = focal1600(cam);
	const eye = g.eye ?? cam.eye;

	const N = w * h;
	const L = new Float32Array(N);
	for (let k = 0; k < N; k++) L[k] = sky[k] ? Infinity : Math.log(range[k]);
	const nx = new Float32Array(N);
	const ny = new Float32Array(N);
	const jump = new Float32Array(N);
	const mask = new Uint8Array(N);
	const nb8: [number, number][] = [
		[1, 0],
		[-1, 0],
		[0, 1],
		[0, -1],
		[1, 1],
		[1, -1],
		[-1, 1],
		[-1, -1],
	];
	for (let y = 1; y < h - 1; y++)
		for (let x = 1; x < w - 1; x++) {
			const k = y * w + x;
			if (sky[k] || range[k] < minRange) continue;
			let sx = 0;
			let sy = 0;
			let jm = 0;
			for (const [dx, dy] of nb8) {
				const q = k + dy * w + dx;
				if (sky[q]) continue;
				const dl = L[q] - L[k];
				if (dl > logRatio) {
					const inv = 1 / Math.hypot(dx, dy);
					sx += dx * inv * dl;
					sy += dy * inv * dl;
					if (dl > jm) jm = dl;
				}
			}
			if (jm > 0 && (sx !== 0 || sy !== 0)) {
				mask[k] = 1;
				nx[k] = sx;
				ny[k] = sy;
				jump[k] = jm;
			}
		}

	// connected components (8-conn); drop short ones
	const comp = new Int32Array(N).fill(-1);
	const keep: boolean[] = [];
	const stack: number[] = [];
	for (let k = 0; k < N; k++) {
		if (!mask[k] || comp[k] >= 0) continue;
		const id = keep.length;
		let n = 0;
		stack.push(k);
		comp[k] = id;
		while (stack.length) {
			const c = stack.pop() as number;
			n++;
			const cx = c % w;
			const cy = (c - cx) / w;
			for (const [dx, dy] of nb8) {
				const x2 = cx + dx;
				const y2 = cy + dy;
				if (x2 < 0 || y2 < 0 || x2 >= w || y2 >= h) continue;
				const q = y2 * w + x2;
				if (mask[q] && comp[q] < 0) {
					comp[q] = id;
					stack.push(q);
				}
			}
		}
		keep.push(n >= minLen);
	}

	// smoothed normals, skyline exclusion, one sample per stepBuf cell (strongest jump)
	const cellsX = Math.ceil(w / stepBuf);
	const best = new Map<number, number>();
	for (let y = 1; y < h - 1; y++)
		for (let x = 1; x < w - 1; x++) {
			const k = y * w + x;
			if (!mask[k] || !keep[comp[k]]) continue;
			let sx = 0;
			let sy = 0;
			for (let dy = -2; dy <= 2; dy++)
				for (let dx = -2; dx <= 2; dx++) {
					const x2 = x + dx;
					const y2 = y + dy;
					if (x2 < 0 || y2 < 0 || x2 >= w || y2 >= h) continue;
					const q = y2 * w + x2;
					if (mask[q] && comp[q] === comp[k]) {
						sx += nx[q];
						sy += ny[q];
					}
				}
			const nn = Math.hypot(sx, sy);
			if (nn === 0) continue;
			nx[k] = sx / nn;
			ny[k] = sy / nn;
			let nearSky = false;
			for (let s = 1; s <= skyGap + 1 && !nearSky; s++) {
				const x2 = Math.round(x + nx[k] * s);
				const y2 = Math.round(y + ny[k] * s);
				if (x2 < 0 || y2 < 0 || x2 >= w || y2 >= h) break;
				if (sky[y2 * w + x2]) nearSky = true;
			}
			if (nearSky) continue;
			const cell = Math.floor(y / stepBuf) * cellsX + Math.floor(x / stepBuf);
			const cur = best.get(cell);
			if (cur === undefined || jump[k] > jump[cur]) best.set(cell, k);
		}

	const cues: EdgeCue[] = [];
	for (const k of [...best.values()].sort((a, b) => a - b)) {
		const x = k % w;
		const y = (k - x) / w;
		const n0 = nx[k];
		const n1 = ny[k];
		let world: Vec3 = [g.xyz[3 * k], g.xyz[3 * k + 1], g.xyz[3 * k + 2]];
		if (g.cast) {
			// bisection between the near pixel centre and 1.5 px into the far side
			let au = (x + 0.5) / w;
			let av = (y + 0.5) / h;
			let bu = (x + 0.5 + 1.5 * n0) / w;
			let bv = (y + 0.5 + 1.5 * n1) / h;
			const ra = range[k];
			const hb = g.cast(bu, bv);
			if (!hb || hb.range < ra * Math.exp(logRatio * 0.5)) continue;
			const split = Math.sqrt(ra * hb.range);
			let hitA = g.cast(au, av);
			if (!hitA) continue;
			let rB = hb.range;
			for (let it = 0; it < iters; it++) {
				const mu = (au + bu) / 2;
				const mv = (av + bv) / 2;
				const hm = g.cast(mu, mv);
				if (hm && hm.range < split) {
					au = mu;
					av = mv;
					hitA = hm;
				} else {
					bu = mu;
					bv = mv;
					rB = hm ? hm.range : Infinity;
				}
			}
			// a real silhouette keeps its range jump at sub-pixel scale; a surface seen at grazing
			// incidence (lake plane, flat valley floor) is continuous and converges to ratio ≈ 1
			if (!(rB / hitA.range > Math.exp(logRatio * 0.5))) continue;
			world = hitA.world;
		}
		const p = projectX(cam, world);
		if (!p) continue;
		const d = Math.hypot(world[0] - eye[0], world[1] - eye[1]);
		const sd = (fPx * demSigma(d)) / Math.max(d, 1);
		cues.push({
			kind: "edge",
			u: p.u,
			v: p.v,
			nu: n0,
			nv: n1,
			world,
			depthM: d,
			sigmaPx: Math.hypot(1, sd),
			source: "contour",
		});
	}
	return { cues, boundary: mask };
}
