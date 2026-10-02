// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The all-ones, zero-boundary, direct-strategy GPUConvolution that the guided filter family uses for
// its window sums (one horizontal or one vertical pass over a plane stack).
import type { ComputeGraph } from "./graph";
import { GPUConvolution, type GraphBufferHandle } from "./luma";

export interface BoxSumOptions {
	id: string;
	width: number;
	/** Rows of the whole stack (planes × (h + r) for a gapped stack). */
	height: number;
	kernelWidth: number;
	kernelHeight: number;
	input: GraphBufferHandle;
	output: GraphBufferHandle;
	/** Float count of input and output (width · height). */
	count: number;
	/** An all-ones buffer of at least kernelWidth · kernelHeight floats. */
	ones: GraphBufferHandle;
}

/** Add one box-sum convolution node to `g`; returns the node id `g.add` returns. */
export function addBoxSum<P>(g: ComputeGraph<P>, o: BoxSumOptions) {
	return g.add(
		new GPUConvolution({
			id: o.id,
			width: o.width,
			height: o.height,
			kernelWidth: o.kernelWidth,
			kernelHeight: o.kernelHeight,
			strategy: "direct",
			boundary: "zero",
			input: g.view(o.input, "float32", o.count),
			kernel: g.view(o.ones, "float32", o.kernelWidth * o.kernelHeight),
			output: g.view(o.output, "float32", o.count),
		}),
	);
}
