// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// luma GPUProgram → our ComputeGraph (WAG-4: GPUProgram lowerings for the scalar / vector stages).
//
// A GPUProgram describes vector / scalar work semantically (GPUProgramSpMV, GPUProgramDotProduct,
// GPUProgramVectorMADD, …) and GPUProgramCompiler lowers it onto a GPUCommandGraph it creates itself.
// Our kernels (look WGSL, texture gathers) are not program operations, so they join the program as
// GraphOperations: semantic operations of type "rigi-graph" whose lowering is a ComputeGraph builder
// callback. compileProgramGraph registers that lowering, compiles the program and returns ONE
// ComputeGraph that adopts the compiler's graph, so
// - our nodes and the program's nodes are scheduled together, in program order (a node that writes a
//   program vector must be lowered BEFORE the operation that reads it: a ComputeGraph node added after
//   compile() would be ordered after its readers by the hazard inference);
// - our nodes keep the clear lint, kernel cache, read nodes, leases and profiling of ComputeGraph; the
//   compiler's own nodes are outside the lint (declareNode them when a GPU-gated transient is involved);
// - the lowering report (compilation.lowering) names every node and the strategy the compiler picked.
//
//   const program = new GPUProgram({ id: "fold" });
//   const partial = program.vector("partial", "float32", n);           // compiler-owned transient
//   program.add(new GraphOperation("producer", (g, ctx) => g.addKernel({ …, bindings: { out: ctx.resolveVector(partial).data[0] } })));
//   program.add(new GPUProgramSpMV({ matrix, vector: partial, output: folded }));
//   const { graph, compilation } = compileProgramGraph(device, "fold", program, { vectors });
//   graph.readNode("folded", [compilation.vectors.get("folded").data[0]]);
//
// Program vectors are 1-D float32 / uint32 / sint32; a single-chunk vector's data[0] is a GraphDataView
// (a GraphBinding: bind it to a kernel directly). External vectors are bound at compile time (GPUData).
import type { Device } from "@luma.gl/core";
import { ComputeGraph } from "./graph";
import {
	type GPUOperation,
	type GPUOperationLoweringContext,
	type GPUOperationMetadata,
	type GPUProgram,
	type GPUProgramBindings,
	type GPUProgramCompilation,
	GPUProgramCompiler,
} from "./luma";

export const GRAPH_OPERATION = "rigi-graph";

/** A program operation lowered by a ComputeGraph builder (our kernels inside a GPUProgram). */
export class GraphOperation<P = void> implements GPUOperation {
	readonly type = GRAPH_OPERATION;
	constructor(
		readonly id: string,
		readonly build: (
			graph: ComputeGraph<P>,
			context: GPUOperationLoweringContext<P>,
		) => void,
		readonly metadata?: GPUOperationMetadata,
	) {}
}

/**
 * Compile `program` and wrap the compiler's graph in a ComputeGraph (`id`). GraphOperations are lowered
 * through their builders on that ComputeGraph; everything else through luma's core lowerings. The graph
 * is not compiled yet (add read nodes, then compile() / compileAsync()). Throws when the program does
 * not validate (validateGPUProgram) or an operation has no lowering.
 */
export function compileProgramGraph<P = void>(
	device: Device,
	id: string,
	program: GPUProgram,
	bindings: GPUProgramBindings = {},
): { graph: ComputeGraph<P>; compilation: GPUProgramCompilation<P> } {
	const compiler = new GPUProgramCompiler<P>(device);
	let graph: ComputeGraph<P> | null = null;
	compiler.lowerings.register<GraphOperation<P>>(
		GRAPH_OPERATION,
		(operation, context) => {
			// the compiler's graph exists only once compile() runs: adopt it at the first of our operations
			graph ??= new ComputeGraph<P>(device, id, { graph: context.graph });
			operation.build(graph, context);
			context.recordDecision({
				operationId: operation.id,
				operationType: operation.type,
				lowering: "rigi-compute-graph",
				reason: "Rigi kernel nodes built on the adopted ComputeGraph",
			});
		},
	);
	const compilation = compiler.compile(program, bindings);
	graph ??= new ComputeGraph<P>(device, id, { graph: compilation.graph });
	return { graph, compilation };
}
