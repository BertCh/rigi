// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The CPU twin of the WebGPU range hand-off (range-webgpu.ts), as pure functions over texel words.
// It is the rule of the WebGL2 hand-off (range-gpu.ts) and of the CPU path it replaces
// (GpuGeometrySource unpack -> rangeMapFrom -> DrapeAtlas.setRange / coarsen), stated on bit patterns:
//   a range texel is kept when 0 < r < +Infinity (sign clear, not +0, below +Infinity's bits, so NaNs
//   and +Infinity sit above), else it becomes +0 (sky = 0, negative, -0, +-Infinity, NaN);
//   the coarse grid is the max over each COARSE x COARSE block of the kept texels, from 0, the last
//   block column / row clipped to the map (ceil(w / COARSE) x ceil(h / COARSE) cells).
// A kept texel is a positive finite float, and for those the float order is the order of the bit
// patterns, so the WGSL kernels never do float arithmetic on a texel (a denormal can not be flushed).
import { COARSE } from "./drape-atlas";

/** The first bit pattern that is no longer a finite positive range: +Infinity. */
export const RANGE_KEEP_LIMIT_BITS = 0x7f800000;

/** The word a range texel becomes: its own bits when 0 < r < +Infinity, else +0. */
export const rangeKeepBits = (bits: number) =>
	bits > 0 && bits < RANGE_KEEP_LIMIT_BITS ? bits : 0;

/** The coarse grid size of a w x h range map. */
export const coarseSize = (w: number, h: number) => ({
	width: Math.ceil(w / COARSE),
	height: Math.ceil(h / COARSE),
});

/**
 * The range-atlas cell texels (row 0 = top) of a geometry target given as its `.w` words, row 0 =
 * top as well (WebGPU's rgba32float target; the 4th word of every texel of `texels`).
 */
export function rangeCellWords(
	texels: Uint32Array,
	w: number,
	h: number,
): Uint32Array {
	const out = new Uint32Array(w * h);
	for (let i = 0; i < out.length; i++)
		out[i] = rangeKeepBits(texels[i * 4 + 3]);
	return out;
}

/** The max-pooled coarse grid of cell words (drape-atlas.ts coarsen, on bits). */
export function coarseWords(
	cell: Uint32Array,
	w: number,
	h: number,
): Uint32Array {
	const { width: cw, height: ch } = coarseSize(w, h);
	const out = new Uint32Array(cw * ch);
	for (let y = 0; y < h; y++) {
		const row = Math.floor(y / COARSE) * cw;
		for (let x = 0; x < w; x++) {
			const i = row + Math.floor(x / COARSE);
			if (cell[y * w + x] > out[i]) out[i] = cell[y * w + x];
		}
	}
	return out;
}
