// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Pure CPU twins of the GPU skyline Viterbi kernels (detect.wgsl.ts SKYLINE_UNARY and SKYLINE_DP): the
// unary cost in the kernel's [x · ns + y] layout and the truncated-window DP. Specs prove the pair equals
// geo/skyline.ts viterbi, so the WGSL (a transcription of these loops) is checked against the reference.
import { FAR_ABOVE, type ResolvedSkylineOptions } from "#/lib/geo/skyline";
import { skylineDpWindow } from "./uniforms";

/** unary[x · ns + y] for y in [0, h], ns = h + 1 (the SKYLINE_UNARY kernel). */
export function skylineUnary(
	sky: Float32Array,
	edge: Float32Array,
	w: number,
	h: number,
	o: ResolvedSkylineOptions,
) {
	const ns = h + 1;
	const unary = new Float32Array(w * ns);
	const cumA = new Float32Array(ns);
	const cumB = new Float32Array(ns);
	for (let x = 0; x < w; x++) {
		for (let y = 0; y < h; y++) {
			const s = sky[y * w + x];
			cumA[y + 1] = cumA[y] + (1 - s);
			cumB[y + 1] = cumB[y] + s;
		}
		for (let y = 0; y <= h; y++) {
			const below = cumB[Math.min(h, y + o.belowBand)] - cumB[y];
			const e = y > 2 && y < h ? edge[y * w + x] : 0;
			const y0 = Math.max(0, y - o.aboveBand);
			const above = cumA[y] - cumA[y0] + FAR_ABOVE * cumA[y0];
			unary[x * ns + y] = above + below - o.edgeWeight * Math.min(e, 0.35);
		}
	}
	return unary;
}

/**
 * The SKYLINE_DP kernel: min over a window of ±skylineDpWindow rows (nearer first, left first on ties)
 * against the global-min truncation, then the backtrack. Returns the boundary row per column.
 */
export function viterbiWindowed(
	unary: Float32Array,
	w: number,
	ns: number,
	jumpCost: number,
	jumpCap: number,
) {
	const win = skylineDpWindow(jumpCost, jumpCap, ns);
	let prev = Float32Array.from(unary.subarray(0, ns));
	let cur = new Float32Array(ns);
	const back = new Int32Array(w * ns);
	for (let x = 1; x < w; x++) {
		let gmin = Number.POSITIVE_INFINITY;
		let garg = 0;
		for (let y = 0; y < ns; y++)
			if (prev[y] < gmin) {
				gmin = prev[y];
				garg = y;
			}
		for (let y = 0; y < ns; y++) {
			let best = prev[y];
			let arg = y;
			for (let d = 1; d <= win; d++) {
				const cost = jumpCost * d;
				if (y >= d && prev[y - d] + cost < best) {
					best = prev[y - d] + cost;
					arg = y - d;
				}
				if (y + d < ns && prev[y + d] + cost < best) {
					best = prev[y + d] + cost;
					arg = y + d;
				}
			}
			if (gmin + jumpCap < best) {
				best = gmin + jumpCap;
				arg = garg;
			}
			cur[y] = best + unary[x * ns + y];
			back[x * ns + y] = arg;
		}
		[prev, cur] = [cur, prev];
	}
	const bound = new Int32Array(w);
	let best = Number.POSITIVE_INFINITY;
	for (let y = 0; y < ns; y++)
		if (prev[y] < best) {
			best = prev[y];
			bound[w - 1] = y;
		}
	for (let x = w - 1; x > 0; x--) bound[x - 1] = back[x * ns + bound[x]];
	return bound;
}
