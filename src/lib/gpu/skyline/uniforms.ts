// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// skyline.wgsl.ts struct P (32 B), packed through defineUniformBlock. Pure (no GPU).

import { defineUniformBlock } from "#/lib/gpu/core/uniform-block";

export const SKYLINE_P = defineUniformBlock({
	w: "u32",
	h: "u32",
	n: "u32",
	pad: "u32",
	sigma: "f32",
	p1: "f32",
	p2: "f32",
	p3: "f32",
});

export function packSkylineParams(
	w: number,
	h: number,
	sigma: number,
): ArrayBuffer {
	return SKYLINE_P.pack({ w, h, n: w * h, sigma });
}

/** detect.wgsl.ts struct S (64 B): sizes, Viterbi bands and costs, fit sample grid and workgroup count. */
export const SKYLINE_S = defineUniformBlock({
	w: "u32",
	h: "u32",
	n: "u32",
	ns: "u32",
	below: "u32",
	above: "u32",
	win: "u32",
	nsamp: "u32",
	nwg: "u32",
	nx: "u32",
	pad0: "u32",
	pad1: "u32",
	edgeW: "f32",
	jc: "f32",
	cap: "f32",
	pad2: "f32",
});

/** Fit sample grid step (fitSkyModel's `step`). */
export const SKYLINE_FIT_STEP = 4;

/** Truncated-L1 window of the Viterbi DP: farther predecessors never beat gmin + jumpCap. */
export const skylineDpWindow = (
	jumpCost: number,
	jumpCap: number,
	ns: number,
) =>
	Math.max(0, Math.min(ns - 1, Math.ceil(jumpCap / Math.max(jumpCost, 1e-6))));

export function packSkylineDetect(
	w: number,
	h: number,
	o: {
		belowBand: number;
		aboveBand: number;
		edgeWeight: number;
		jumpCost: number;
		jumpCap: number;
	},
): ArrayBuffer {
	const nx = Math.ceil(w / SKYLINE_FIT_STEP);
	const ny = Math.ceil(h / SKYLINE_FIT_STEP);
	const nsamp = nx * ny;
	return SKYLINE_S.pack({
		w,
		h,
		n: w * h,
		ns: h + 1,
		below: o.belowBand,
		above: o.aboveBand,
		win: skylineDpWindow(o.jumpCost, o.jumpCap, h + 1),
		nsamp,
		nwg: Math.ceil(nsamp / 64),
		nx,
		edgeW: o.edgeWeight,
		jc: o.jumpCost,
		cap: o.jumpCap,
	});
}
