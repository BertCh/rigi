// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * Per-column skyline from a soft sky mask: the topmost sky→non-sky
 * transition, sub-pixel from the 0.5 crossing of the soft mask, weighted by
 * how sharp and clean the boundary is. Output matches SkylineObservation in
 * geo/skyline.ts (and SkylineRows in geo/solve.ts).
 */
import type { SkylineObservation } from "../geo/skyline";
import { smoothstep } from "../math";
import { type RGBA, resamplePlanes, rgbPlanes } from "./core";

export interface SkyMaskLike {
	width: number;
	height: number;
	/** P(sky)*255, row 0 = top. */
	data: Uint8Array;
}

export interface SkylineFromSkyOptions {
	/**
	 * Non-sky runs shorter than this (px, default max(6, 1.5% of height)) are
	 * treated as thin occluders (cables, wires, birds) and scanned through.
	 */
	minOccluder?: number;
	/** Sky runs shorter than this (px, default max(4, 1% of height)) don't count as sky. */
	minSky?: number;
	/** Columns with weight below this are NaN (default 0.05). */
	minWeight?: number;
}

export function skylineFromSky(
	mask: SkyMaskLike,
	opts: SkylineFromSkyOptions = {},
): SkylineObservation {
	const { width: w, height: h, data } = mask;
	const minOcc = opts.minOccluder ?? Math.max(6, Math.round(0.015 * h));
	const minSky = opts.minSky ?? Math.max(4, Math.round(0.01 * h));
	const minWeight = opts.minWeight ?? 0.05;
	const rows = new Float32Array(w).fill(Number.NaN);
	const weight = new Float32Array(w);
	const band = Math.max(4, Math.round(0.01 * h));
	const col = new Float32Array(h);

	for (let x = 0; x < w; x++) {
		for (let y = 0; y < h; y++) col[y] = data[y * w + x] / 255;
		let y = 0;
		let skyStart = -1;
		let found = -1;
		let startsAtTop = true;
		while (y < h) {
			// Next sky run.
			while (y < h && col[y] < 0.5) y++;
			if (y >= h) break;
			const s0 = y;
			while (y < h && col[y] >= 0.5) y++;
			if (y >= h) break; // sky to the bottom: no boundary
			if (y - s0 < minSky && skyStart < 0) {
				startsAtTop = false;
				continue;
			}
			if (skyStart < 0) {
				skyStart = s0;
				if (s0 > 0) startsAtTop = false;
			}
			// Non-sky run below: long enough to be terrain?
			let e = y;
			while (e < h && col[e] < 0.5) e++;
			if (e - y >= minOcc || e >= h) {
				found = y;
				break;
			}
			y = e; // thin occluder: keep scanning within the same sky
		}
		if (found <= 0) continue;
		// Sub-pixel 0.5 crossing between pixel centres found-1 and found.
		const p0 = col[found - 1];
		const p1 = col[found];
		const t = p0 - p1 > 1e-6 ? (p0 - 0.5) / (p0 - p1) : 0.5;
		const yc = found - 0.5 + t;

		// Sharpness: steepest drop within ±3 px of the crossing.
		let slope = 0;
		for (let k = Math.max(1, found - 3); k <= Math.min(h - 1, found + 3); k++)
			slope = Math.max(slope, col[k - 1] - col[k]);
		// Cleanliness: sky just above, non-sky just below (skipping the soft edge).
		let above = 0;
		let na = 0;
		for (let k = found - 3; k > found - 3 - band && k >= 0; k--) {
			above += col[k];
			na++;
		}
		let below = 0;
		let nb = 0;
		for (let k = found + 2; k < found + 2 + band && k < h; k++) {
			below += 1 - col[k];
			nb++;
		}
		above = na ? above / na : 0.5;
		below = nb ? below / nb : 0.5;
		let wgt =
			smoothstep(0.05, 0.3, slope) *
			smoothstep(0.5, 0.9, above) *
			smoothstep(0.5, 0.9, below);
		// Sky that doesn't reach the top of the frame (window, branch) is
		// still usable but less certain.
		if (!startsAtTop || skyStart > 0) wgt *= 0.7;
		if (wgt < minWeight) continue;
		rows[x] = yc;
		weight[x] = wgt;
	}
	return { width: w, height: h, rows, weight };
}

export interface SkylineDPOptions {
	/** Rows above the boundary whose non-sky-ness is penalised (default 3% of H). */
	above?: number;
	/** Rows below the boundary whose sky-ness is penalised (default 3% of H). */
	below?: number;
	/** Weight of the above term (default 1). */
	alpha?: number;
	/** Weight of the below term (default 1). */
	beta?: number;
	/** Weight of the photo edge term, px-equivalents per unit colour step (default 0.5·above). */
	gamma?: number;
	/** Transition cost per px of row change between columns (default 1). */
	lambda?: number;
	/** Transition cost cap (default 30 px at 1024 wide, scaled with width). */
	tau?: number;
	/** Excursions narrower than this fraction of the width are zero-weighted (default 0.02). */
	spikeWidth?: number;
	/** Columns with weight below this are NaN (default 0.05). */
	minWeight?: number;
}

/**
 * Skyline from a soft sky mask by dynamic programming over columns (Lie et
 * al. 2005 style Viterbi; research_notes/analysis_algorithms_sota_2026.md
 * §1.2). State y ∈ [0, H] is the boundary row (rows < y are sky).
 *
 *   U(y,x) = α·Σ_{y−A..y−1}(1−p) + β·Σ_{y..y+B−1} p − γ·edge(y)·polarity
 *   D(x,y) = U(y,x) + min(min_y' D(x−1,y') + λ|y−y'|, min D(x−1) + τ)
 *
 * The min over y' is an O(H) two-pass L1 distance transform. `edge` is the
 * vertical colour step of `img` (resampled to the mask size), counted fully
 * when it gets darker going down and 30% otherwise; without `img` the term
 * is omitted. Rows are sub-pixel from a parabola through the mask's
 * per-row drop around the chosen boundary. Weight = sky-above minus
 * sky-below contrast; columns in excursions that jump by > τ/2 and come
 * back within `spikeWidth` of the width (posts, poles) get weight 0.
 * State 0 (no sky at the top) and H (all sky) give NaN.
 */
export function skylineFromSkyDP(
	mask: SkyMaskLike,
	img?: RGBA,
	opts: SkylineDPOptions = {},
): SkylineObservation {
	const { width: w, height: h, data } = mask;
	const A = opts.above ?? Math.max(4, Math.round(0.03 * h));
	const B = opts.below ?? Math.max(4, Math.round(0.03 * h));
	const alpha = opts.alpha ?? 1;
	const beta = opts.beta ?? 1;
	const gamma = opts.gamma ?? 0.5 * A;
	const lambda = opts.lambda ?? 1;
	const tau = opts.tau ?? (30 * w) / 1024;
	const minWeight = opts.minWeight ?? 0.05;
	const ns = h + 1;

	// Photo edge (vertical colour step, ±k rows, 3-column smoothing).
	let edge: Float32Array | undefined;
	if (img) {
		const rgb0 = rgbPlanes(img);
		const rgb = resamplePlanes(rgb0, img.width, img.height, 3, w, h);
		const n = w * h;
		const k = 2;
		edge = new Float32Array(n);
		const sm = new Float32Array(3 * n);
		for (let c = 0; c < 3; c++)
			for (let y = 0; y < h; y++)
				for (let x = 0; x < w; x++) {
					const o = c * n + y * w;
					sm[o + x] =
						(rgb[o + Math.max(0, x - 1)] +
							rgb[o + x] +
							rgb[o + Math.min(w - 1, x + 1)]) /
						3;
				}
		for (let y = k; y < h - k; y++)
			for (let x = 0; x < w; x++) {
				let d2 = 0;
				let dl = 0;
				for (let c = 0; c < 3; c++) {
					let up = 0;
					let dn = 0;
					for (let j = 1; j <= k; j++) {
						up += sm[c * n + (y - j) * w + x];
						dn += sm[c * n + (y + j - 1) * w + x];
					}
					const d = (up - dn) / k;
					d2 += d * d;
					dl += [0.3, 0.59, 0.11][c] * d;
				}
				edge[y * w + x] = Math.min(0.35, Math.sqrt(d2)) * (dl > 0 ? 1 : 0.3);
			}
	}

	const cumNS = new Float32Array(ns); // Σ_{r<y} (1−p)
	const cumS = new Float32Array(ns); // Σ_{r<y} p
	const unary = new Float32Array(ns);
	let prev = new Float32Array(ns);
	let cur = new Float32Array(ns);
	const fwd = new Float32Array(ns);
	const arg = new Int32Array(ns);
	const back = new Int32Array(w * ns);

	for (let x = 0; x < w; x++) {
		for (let y = 0; y < h; y++) {
			const p = data[y * w + x] / 255;
			cumNS[y + 1] = cumNS[y] + (1 - p);
			cumS[y + 1] = cumS[y] + p;
		}
		for (let y = 0; y <= h; y++) {
			const ab = cumNS[y] - cumNS[Math.max(0, y - A)];
			const be = cumS[Math.min(h, y + B)] - cumS[y];
			const e = edge && y > 0 && y < h ? edge[y * w + x] : 0;
			unary[y] = alpha * ab + beta * be - gamma * e;
		}
		if (x === 0) {
			prev.set(unary);
			continue;
		}
		// Two-pass L1 distance transform with argmins, then truncation.
		for (let y = 0; y < ns; y++) {
			fwd[y] = prev[y];
			arg[y] = y;
		}
		for (let y = 1; y < ns; y++)
			if (fwd[y - 1] + lambda < fwd[y]) {
				fwd[y] = fwd[y - 1] + lambda;
				arg[y] = arg[y - 1];
			}
		for (let y = ns - 2; y >= 0; y--)
			if (fwd[y + 1] + lambda < fwd[y]) {
				fwd[y] = fwd[y + 1] + lambda;
				arg[y] = arg[y + 1];
			}
		let gmin = Infinity;
		let garg = 0;
		for (let y = 0; y < ns; y++)
			if (prev[y] < gmin) {
				gmin = prev[y];
				garg = y;
			}
		const off = x * ns;
		for (let y = 0; y < ns; y++) {
			let best = fwd[y];
			let a = arg[y];
			if (gmin + tau < best) {
				best = gmin + tau;
				a = garg;
			}
			cur[y] = best + unary[y];
			back[off + y] = a;
		}
		[prev, cur] = [cur, prev];
	}
	const bound = new Int32Array(w);
	let best = Infinity;
	for (let y = 0; y < ns; y++)
		if (prev[y] < best) {
			best = prev[y];
			bound[w - 1] = y;
		}
	for (let x = w - 1; x > 0; x--) bound[x - 1] = back[x * ns + bound[x]];

	const rows = new Float32Array(w).fill(Number.NaN);
	const weight = new Float32Array(w);
	const band = Math.max(4, Math.round(0.01 * h));
	const P = (x: number, y: number) =>
		data[Math.min(h - 1, Math.max(0, y)) * w + x] / 255;
	for (let x = 0; x < w; x++) {
		const y = bound[x];
		if (y <= 0 || y >= h) continue;
		// Sub-pixel: parabola through the per-row drop d(k) = p(k−1) − p(k).
		const d = (k: number) => P(x, k - 1) - P(x, k);
		const dm = d(y - 1);
		const d0 = d(y);
		const dp = d(y + 1);
		const den = dm - 2 * d0 + dp;
		const dy =
			den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (dm - dp)) / den)) : 0;
		// Contrast: sky just above minus sky just below (skipping the soft edge).
		let ab = 0;
		let be = 0;
		for (let k = 2; k < 2 + band; k++) {
			ab += P(x, y - k);
			be += P(x, y + k - 1);
		}
		const contrast = (ab - be) / band;
		let wgt = smoothstep(0.3, 0.9, contrast);
		if (P(x, 0) < 0.5) wgt *= 0.7; // sky doesn't reach the top
		rows[x] = y + dy;
		weight[x] = wgt;
	}
	// Excursions: jump > τ/2, then back within spikeWidth → posts, poles.
	const maxW = Math.max(2, Math.round((opts.spikeWidth ?? 0.02) * w));
	const jump = tau / 2;
	for (let x = 1; x < w; x++) {
		if (Math.abs(bound[x] - bound[x - 1]) <= jump) continue;
		const base = bound[x - 1];
		for (let e = x + 1; e <= Math.min(w, x + maxW); e++) {
			const back2 = e === w || Math.abs(bound[e] - base) <= jump;
			if (!back2) continue;
			// Excursion is [x, e): only if all of it sits off the base level.
			let off = true;
			for (let j = x; j < e; j++)
				if (Math.abs(bound[j] - base) <= jump) off = false;
			if (off) for (let j = x; j < e; j++) weight[j] = 0;
			break;
		}
	}
	for (let x = 0; x < w; x++)
		if (weight[x] < minWeight) {
			rows[x] = Number.NaN;
			weight[x] = 0;
		}
	return { width: w, height: h, rows, weight };
}
