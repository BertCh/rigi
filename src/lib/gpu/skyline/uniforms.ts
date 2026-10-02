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
