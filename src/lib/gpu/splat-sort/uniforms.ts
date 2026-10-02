// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Uniform block of the splat-sort kernels (splat-sort.wgsl.ts struct Params, 32 B), packed through
// defineUniformBlock. Pure (no GPU).

import { defineUniformBlock } from "#/lib/gpu/core/uniform-block";

/** splat-sort.wgsl.ts struct Params: row at byte 0, near at 16, n at 20, blocks at 24, pad0 at 28. */
export const SPLAT_SORT_PARAMS = defineUniformBlock({
	row: "vec4<f32>",
	near: "f32",
	n: "u32",
	blocks: "u32",
	pad0: "u32",
});

/** The 32 B Params block for one sort of `count` splats over `blocks` sort blocks. */
export function packSplatSortParams(
	row: readonly [number, number, number, number],
	count: number,
	blocks: number,
): ArrayBuffer {
	return SPLAT_SORT_PARAMS.pack({
		row,
		near: 0, // near: the worker's default and what SplatsCore uses; depth keys need near >= 0
		n: count,
		blocks,
	});
}
