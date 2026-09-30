// The ONE module that imports @luma.gl/gpgpu/gpu-core. That subpath is experimental in luma 9.4
// (no semver promise, WebGPU only), so everything else in the repo imports these names from here,
// and a luma bump touches this file only.
//
// luma 10 (10.0.0-alpha.2) notes:
// - npm 10.0.0-alpha.2 packaging is broken (yarn `patch:` @math.gl/core deps, ~9.4.0-alpha.1 peer
//   ranges): package.json pins @math.gl/core 5.0.0-alpha.9 with npm overrides, and .npmrc sets
//   legacy-peer-deps.
// - #3258: ops no longer have addToGraph(graph); GPUCommandGraph.add(node) takes any GPUNode (an op
//   with getCommandNodes(graph), a raw node, or a group). core/graph.ts GraphOp = GPUNode.
// - Workarounds retired on the bump: ComputePass.setBindings is abstract (core/kernel.ts no longer
//   duck-types it); Device.createComputePipelineAsync is native (#3204, core/kernel.ts kernelAsync);
//   each WebGPUComputePipeline owns its bindings (core/kernel.ts no longer resets them).
// - Still worked around: adapter limits are only raised with featureLevel "max" (which also
//   requests every feature), so core/device.ts still patches requestDevice on the adapter;
//   Buffer.readAsync on a non-MAP_READ buffer still stages per call, so core/readback.ts keeps its
//   own MAP_READ slots.
// - GPUReadbackRing has fixed-size slots; core/readback.ts implements the same ticket pattern with
//   grow-on-demand slots (re-exported here for callers with a fixed readback size).

export type {
	GPUCommandGraphComputeExecutable,
	GPUCommandGraphComputeNode,
	GPUCommandGraphEncodeContext,
	GPUCommandGraphEncodeOptions,
	GPUCommandGraphTimingReport,
	GPUHistogramProps,
	GPUNode,
	GPUReductionOperation,
	GPUReductionProps,
	GPUScalarFormat,
	GPUScanProps,
	GPUSortProps,
	GraphBufferDescriptor,
	GraphBufferUsage,
	GraphBufferUse,
	GraphImportedBuffer,
	GraphImportedTexture,
	GraphResourceUse,
	GraphTextureDescriptor,
	GraphTextureUsage,
} from "@luma.gl/gpgpu/gpu-core";
export {
	CompiledGPUCommandGraph,
	GPUCommandGraph,
	GPUCommandGraphEncoding,
	GPUFFT1D,
	GPUHistogram,
	GPUReadbackRing,
	GPUReadbackTicket,
	GPUReduction,
	GPUScan,
	GPUSort,
	GraphBufferHandle,
	GraphDataView,
	GraphTextureHandle,
	GraphTextureView,
} from "@luma.gl/gpgpu/gpu-core";
