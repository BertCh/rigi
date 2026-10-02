// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Local adapter: luma gpu-raster edge operators as nodes of a Rigi ComputeGraph. gpu-raster ops still
// use the pre-#3258 `addToGraph(graph)` shape (no `getCommandNodes`), so ComputeGraph.add cannot take
// them; this adds them to the wrapped GPUCommandGraph and declares their buffer uses for the clear lint.
// The only importer of `@luma.gl/experimental/gpu-raster` (src/lib/gpu/core/luma.ts is not extended here).
import { GPURasterGradientMagnitude } from "@luma.gl/experimental/gpu-raster";
import type { ComputeGraph } from "#/lib/gpu/core/graph";
import type { GraphBufferHandle } from "#/lib/gpu/core/luma";

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
	}).addToGraph(g.graph);
	// the three nodes the op adds are `${id}-horizontal`, `-vertical` and `-magnitude`
	for (const part of ["horizontal", "vertical", "magnitude"])
		g.declareNode(`${id}-${part}`, {
			uses: [input],
			writes: [output, validity],
		});
	return g;
}
