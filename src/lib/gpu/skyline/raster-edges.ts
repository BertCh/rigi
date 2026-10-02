// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// luma gpu-raster edge operators as nodes of a Rigi ComputeGraph: ComputeGraph.add takes the op's
// `addToGraph(graph)` shape directly (core/README.md, "Composing with luma operators") and audits the
// nodes it adds for the clear lint.
import type { ComputeGraph } from "#/lib/gpu/core/graph";
import {
	GPURasterGradientMagnitude,
	type GraphBufferHandle,
} from "#/lib/gpu/core/luma";

/**
 * Sobel gradient magnitude of the float32 plane `input` (w × h) into `output`: `scale` multiplies the raw
 * stencil (a unit ramp gives 8, so 0.25 matches a central difference x[+1] - x[-1] up to the [1 2 1]
 * smoothing across the derivative). Borders clamp. Scratch (two derivative planes and their validity
 * flags) is graph-owned and fully written, so no clear is needed.
 */
export function addSobelMagnitude<P>(
	g: ComputeGraph<P>,
	id: string,
	w: number,
	h: number,
	input: GraphBufferHandle,
	output: GraphBufferHandle,
	scale: number,
) {
	const n = w * h;
	const validity = g.transientBuffer(`${id}-valid`, n * 4);
	g.add(
		new GPURasterGradientMagnitude({
			id,
			width: w,
			height: h,
			input: {
				id: `${id}-in`,
				format: "float32",
				storage: { kind: "buffer", values: g.view(input, "float32", n) },
			},
			output: g.view(output, "float32", n),
			outputValidity: g.view(validity, "uint32", n),
			operator: "sobel",
			scale,
		}),
	);
	return g;
}
