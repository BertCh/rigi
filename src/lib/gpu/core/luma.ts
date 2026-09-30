// The ONE module that imports @luma.gl/gpgpu/gpu-core. That subpath is experimental in luma 9.4
// (no semver promise, WebGPU only), so everything else in the repo imports these names from here,
// and a luma bump touches this file only.
//
// luma 10 migration notes (checked against 9.4.2 source, 10.0.0-alpha.2 on npm's beta tag):
// - 10.0.0-alpha.2 has broken packaging; stay on 9.4.2 until a working 10 beta ships with deck 10.
// - gpu-core is expected to be promoted (GPUCommandGraph / GPUReduction / GPUSort …). If a name
//   moves or is renamed, alias it here to keep the exported names below stable.
// - Things core/** works around that 10 may fix, to revisit on the bump:
//   · ComputePass.setBindings exists only on WebGPUComputePass (not on the abstract class):
//     core/kernel.ts duck-types it.
//   · No async pipeline creation in luma: core/kernel.ts creates the GPUComputePipeline with
//     createComputePipelineAsync and hands luma the `handle`.
//   · Adapter limits are only raised with featureLevel "max" (which also requests every feature):
//     core/device.ts patches requestDevice on the adapter instead.
//   · Buffer.readAsync on a non-MAP_READ buffer makes a temporary staging buffer per call:
//     core/readback.ts owns its own MAP_READ slots.
// - GPUReadbackRing has fixed-size slots; core/readback.ts implements the same ticket pattern with
//   grow-on-demand slots (re-exported here for callers with a fixed readback size).

export type {
	GPUCommandGraphComputeExecutable,
	GPUCommandGraphComputeNode,
	GPUCommandGraphEncodeContext,
	GPUCommandGraphEncodeOptions,
	GPUCommandGraphTimingReport,
	GPUHistogramProps,
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
