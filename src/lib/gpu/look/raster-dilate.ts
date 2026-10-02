// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Binary square dilation on a ComputeGraph, as luma gpu-raster GPURasterDilation passes
// (@luma.gl/experimental/gpu-raster). It replaces the hand-written separable HZ_DILH / HZ_BIN loops
// of the haze prep: a (2r+1)² square, zero outside the grid, exactly look/haze-fit.ts dilate.
//
// gpu-raster morphology is bounded to radius 8 per pass. A square dilation is its own composition
// (D_a ∘ D_b = D_{a+b}, also with a zero border: a window reaching a source pixel from a target
// inside the rectangle passes through the rectangle), so a larger radius is a chain of passes with
// radii summing to it.
// The ops are added with ComputeGraph.add (their addToGraph nodes join the clear lint).
import type { ComputeGraph } from "../core/graph";
import { GPURasterDilation, type GraphBufferHandle } from "../core/luma";
import { planeWords } from "./haze.wgsl";

/** gpu-raster's per-pass radius bound. */
export const RASTER_MAX_RADIUS = 8;

/** Radii of the passes that make a radius-`radius` square dilation (each 1..8, summing to it; 0 = one copy pass). */
export function dilationPasses(radius: number): number[] {
	if (radius <= 0) return [0];
	const passes: number[] = [];
	for (let left = radius; left > 0; left -= RASTER_MAX_RADIUS)
		passes.push(Math.min(RASTER_MAX_RADIUS, left));
	return passes;
}

/** One w·h plane of u32 flags inside a graph buffer (the offset is a multiple of 256 bytes). */
export type MaskPlane = { buffer: GraphBufferHandle; byteOffset?: number };

/**
 * Add the dilation of `input` (w × h u32 flags, nonzero = set) by a (2r+1)² square to `g`, writing
 * the 0 / 1 result into `output` (a different buffer). Radius 0 is one copy pass. `validity` is the
 * passes' (unused) output validity scratch, w·h words, shared by all passes of the chain and by
 * chains that run one after the other.
 */
export function addSquareDilation<P>(
	g: ComputeGraph<P>,
	o: {
		id: string;
		width: number;
		height: number;
		radius: number;
		input: MaskPlane;
		output: MaskPlane;
		validity: GraphBufferHandle;
	},
): void {
	const { id, width, height } = o;
	const n = width * height;
	const passes = dilationPasses(o.radius);
	let source = o.input;
	passes.forEach((radius, k) => {
		const last = k === passes.length - 1;
		const target: MaskPlane = last
			? o.output
			: { buffer: g.transientBuffer(`${id}-mid${k}`, n * 4) };
		const nodeId = `${id}-${k}`;
		const plane = (p: MaskPlane) =>
			g.view(p.buffer, "uint32", n, p.byteOffset ?? 0);
		const op = new GPURasterDilation({
			id: nodeId,
			mode: "binary",
			width,
			height,
			radius,
			structuringElement: "square",
			// outside the grid counts as unset: the CPU dilate clips its window
			borderMode: "constant",
			borderValue: 0,
			input: {
				id: `${nodeId}-in`,
				format: "uint32",
				storage: { kind: "buffer", values: plane(source) },
			},
			output: plane(target),
			outputValidity: g.view(o.validity, "uint32", n),
		});
		g.add(op);
		source = target;
	});
}

/**
 * The haze prep's two dilations on a `masks` buffer (edge plane, people plane; HZ_PREP's output) into
 * a different `near` buffer of the same layout (HZ_BIN's input): the edge mask by `rad`, the people
 * mask by `fgRad` (0 when no people mask was given: a copy of the all-zero plane).
 */
export function addHazeDilations<P>(
	g: ComputeGraph<P>,
	o: {
		width: number;
		height: number;
		rad: number;
		fgRad: number;
		masks: GraphBufferHandle;
		near: GraphBufferHandle;
		validity: GraphBufferHandle;
	},
): void {
	const stride = planeWords(o.width * o.height) * 4;
	const common = { width: o.width, height: o.height, validity: o.validity };
	addSquareDilation(g, {
		...common,
		id: "dil-edge",
		radius: o.rad,
		input: { buffer: o.masks },
		output: { buffer: o.near },
	});
	addSquareDilation(g, {
		...common,
		id: "dil-fg",
		radius: o.fgRad,
		input: { buffer: o.masks, byteOffset: stride },
		output: { buffer: o.near, byteOffset: stride },
	});
}
