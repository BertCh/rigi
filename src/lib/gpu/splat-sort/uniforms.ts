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

/** live.wgsl.ts struct Params, 32 B: row at 0, near at 16, capacity at 20, vertexCount at 24, pad0 at 28. */
export const LIVE_SPLAT_SORT_PARAMS = defineUniformBlock({
	row: "vec4<f32>",
	near: "f32",
	capacity: "u32",
	vertexCount: "u32",
	pad0: "u32",
});

/** Vertices per splat quad (deck-webgpu/layers/splats.ts: two triangles). */
export const SPLAT_QUAD_VERTICES = 6;

/** The 32 B Params block of one live sort over a buffer of `capacity` splats. */
export function packLiveSplatSortParams(
	row: readonly [number, number, number, number],
	capacity: number,
): ArrayBuffer {
	return LIVE_SPLAT_SORT_PARAMS.pack({
		row,
		near: 0,
		capacity,
		vertexCount: SPLAT_QUAD_VERTICES,
	});
}

/** Workgroups of a compute pass over `count` elements (the x of a dispatchWorkgroupsIndirect record). */
export function workgroupCount(count: number, workgroupSize: number): number {
	return Math.ceil(count / workgroupSize);
}

/**
 * The indirect dispatch record the live args kernel writes (LIVE_ARGS_WGSL): [x, 1, 1, count] where
 * x = ceil(min(counter, capacity) / TILE). Byte layout: 4 u32 = 16 B, dispatch reads words 0..2.
 */
export function liveDispatchArgs(
	counter: number,
	capacity: number,
	workgroupSize: number,
): Uint32Array {
	const n = Math.min(counter, capacity);
	return new Uint32Array([workgroupCount(n, workgroupSize), 1, 1, n]);
}

/**
 * The indirect draw record the live scan kernel writes: WebGPU drawIndirect's four u32
 * [vertexCount, instanceCount, firstVertex, firstInstance], instanceCount = kept splats.
 */
export function liveDrawArgs(kept: number): Uint32Array {
	return new Uint32Array([SPLAT_QUAD_VERTICES, kept, 0, 0]);
}

/** Byte size of both records (4 u32). */
export const LIVE_ARGS_BYTES = 16;
