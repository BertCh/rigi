// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

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
// - #3312 (props.requiredLimits) and #3313 (WebGPUAdapter.attach) retired the requestDevice patch:
//   core/device.ts requests the device itself (features + RAISED_LIMITS) and wraps it with
//   attachWebGPUDevice below; sky/model.ts attaches ORT's device the same way.
// - rigi.3 re-audit (LF7, vs luma master 7289d961 + #3313 #3302 #3287 #3328 #3333 #3334 #3330):
//   retired nothing, each item below was re-read in node_modules/@luma.gl/*/dist.
//   - Buffer.readAsync on a non-MAP_READ buffer: #3330 stages only the requested range, but it still
//     creates a temporary buffer, waits on onSubmittedWorkDone and submits its own encoder per call.
//     core/readback.ts keeps its own MAP_READ slots on the caller's encoder (one submit, no allocation).
//   - GPUReadbackRing has fixed-size slots (byteLength per ring) and its tickets go through
//     Buffer.readAsync; core/readback.ts implements the same ticket pattern with grow-on-demand slots
//     (the ring is re-exported here for callers with a fixed readback size).
//   - core/queue.ts submitWithDefault still calls WebGPUDevice._finalizeDefaultCommandEncoderForSubmit
//     and reads CommandEncoder._gpuTimeMs (both unchanged in rigi.3; Device.submit's transient upload
//     buffers are freed by commandBuffer.destroy(), which we also call). deck/device-lost.ts still
//     reads WebGLDevice._resolveContextLost/_isLost/_lossWasRequested/extensions, gl.lumaState and
//     the default PipelineFactory's _sharedRenderPipelineCache (unchanged by #3287).
//   - setGPUComputeDispatchWorkgroups is still not exported from @luma.gl/gpgpu/gpu-core, so
//     core/graph.ts applies its validation by hand.
// - GPUProgram / GPUProgramCompiler (semantic scalar ops, literals baked at compile, GPU predicates
//   lowered to indirect-dispatch gates) are used by look/haze-argmin.ts, with our kernels lowered
//   into the program's graph through a registered lowering (core/graph.ts ComputeGraph adopts it).
// - GPUCommandGraphInspector (bounded per-node CPU / GPU timing samples over compiled graphs) is used
//   only by core/inspector.ts (one inspector per device, opt-in; see core/inspect.ts).

import type { Device, DeviceProps } from "@luma.gl/core";
import { webgpuAdapter } from "@luma.gl/webgpu";

/**
 * Wraps an app-created GPUDevice as a luma Device (WebGPUAdapter.attach, luma #3313). Call the
 * adapter directly, not luma.attachDevice. `ownsHandle` makes Device.destroy() also destroy the
 * GPUDevice (releaseWhenIdle relies on it); false leaves it alive, for ORT's device. We do this
 * ourselves because #3313 dropped its `_ownsHandle` prop (b1728918): attached devices always
 * belong to the app upstream, so passing the prop would silently leak on the npm release.
 */
export const attachWebGPUDevice = async (
	handle: GPUDevice,
	props: DeviceProps = {},
	ownsHandle = false,
): Promise<Device> => {
	const device = await webgpuAdapter.attach(handle, props);
	if (ownsHandle) {
		const destroy = device.destroy.bind(device);
		device.destroy = () => {
			destroy();
			handle.destroy();
		};
	}
	return device;
};

export type {
	GPUCommandGraphComputeExecutable,
	GPUCommandGraphComputeNode,
	GPUCommandGraphCopyNode,
	GPUCommandGraphCPUCondition,
	GPUCommandGraphEncodeContext,
	GPUCommandGraphEncodeOptions,
	GPUCommandGraphGPUIndirectCondition,
	GPUCommandGraphInspectorDurationSnapshot,
	GPUCommandGraphInspectorGraphSnapshot,
	GPUCommandGraphInspectorNodeSnapshot,
	GPUCommandGraphInspectorObservation,
	GPUCommandGraphInspectorProps,
	GPUCommandGraphInspectorSnapshot,
	GPUCommandGraphNode,
	GPUCommandGraphNodeCondition,
	GPUCommandGraphNodeWorkloadEstimate,
	GPUCommandGraphPreflightReport,
	GPUCommandGraphRenderNode,
	GPUCommandGraphStats,
	GPUCommandGraphTimingReport,
	GPUHistogramProps,
	GPUNode,
	GPUOperation,
	GPUOperationLoweringContext,
	GPUOperationMetadata,
	GPUProgramBindings,
	GPUProgramCompilation,
	GPUProgramLoweringReport,
	GPUReductionOperation,
	GPUReductionProps,
	GPUScalarFormat,
	GPUScanProps,
	GPUSortProps,
	GraphBufferDescriptor,
	GraphBufferUsage,
	GraphBufferUse,
	GraphExternalTextureBinding,
	GraphFrameTextureBinding,
	GraphImportedBuffer,
	GraphImportedTexture,
	GraphResourceUse,
	GraphTextureDescriptor,
	GraphTextureUsage,
	GraphTextureViewProps,
} from "@luma.gl/gpgpu/gpu-core";
export {
	CompiledGPUCommandGraph,
	GPUCommandGraph,
	GPUCommandGraphEncoding,
	GPUCommandGraphInspector,
	GPUConditionalOperation,
	GPUFFT1D,
	GPUHistogram,
	GPUProgram,
	GPUProgramCompiler,
	GPUProgramCSRMatrix,
	GPUProgramScalarLiteral,
	GPUProgramSpMV,
	GPUReadbackRing,
	GPUReadbackTicket,
	GPUReduction,
	GPUScan,
	GPUSort,
	GraphBufferHandle,
	GraphDataView,
	GraphTextureHandle,
	GraphTextureView,
	scalarArithmetic,
	scalarCompare,
} from "@luma.gl/gpgpu/gpu-core";
// GPUData: the buffer-backed chunk that binds a GPUProgram external vector (core/program.ts)
export { GPUData } from "@luma.gl/gpgpu/gpu-data";
