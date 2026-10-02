// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Uniform blocks of the sky kernels (WGSL `struct P` of prep.wgsl.ts and refine.wgsl.ts), packed
// through defineUniformBlock. Pure (no GPU): __tests__/uniforms.spec.ts proves each packer
// byte-identical to the former hand-packed words.

import { defineUniformBlock } from "#/lib/gpu/core/uniform-block";

/** prep.wgsl.ts struct P (32 B: 5 live words, 3 pad words). */
export const SKY_PREP_P = defineUniformBlock({
	W: "u32",
	H: "u32",
	lw: "u32",
	lh: "u32",
	rowWords: "u32",
	p0: "u32",
	p1: "u32",
	p2: "u32",
});

/** The prep params; rowWords = rowBytes / 4. */
export function packSkyPrepParams(
	W: number,
	H: number,
	lw: number,
	lh: number,
	rowBytes: number,
): ArrayBuffer {
	return SKY_PREP_P.pack({ W, H, lw, lh, rowWords: rowBytes / 4 });
}

/** refine.wgsl.ts struct P (32 B: 7 live words, 1 pad word). */
export const SKY_REFINE_P = defineUniformBlock({
	lw: "u32",
	lh: "u32",
	W: "u32",
	H: "u32",
	r: "u32",
	br: "u32",
	eps: "f32",
	pad: "u32",
});

/** The refine params (guided-filter radius r, band radius br, regulariser eps). */
export function packSkyRefineParams(args: {
	lw: number;
	lh: number;
	W: number;
	H: number;
	r: number;
	br: number;
	eps: number;
}): ArrayBuffer {
	return SKY_REFINE_P.pack(args);
}
