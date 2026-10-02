// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The ONE module that imports @luma.gl/gpgpu/gpu-core. That subpath is experimental in luma 10
// (no semver promise, WebGPU only), so everything else in the repo imports these names from here,
// and a luma bump touches this file only.
//
// luma 10 notes:
// - GPUCommandGraph.add(node) takes any GPUNode (an op with getCommandNodes(graph), a raw node, or a
//   group). core/graph.ts GraphOp = GPUNode.
// - gpu/device.ts creates the sidecar with webgpuAdapter.create (optionalFeatures + RAISED_LIMITS as
//   requiredLimits); sky/model.ts attaches ORT's device with attachWebGPUDevice below, and ORT gets
//   native objects through nativeWebGPUDevice / nativeWebGPUBuffer.
// - rigi.3 re-audit (LF7, vs luma master 7289d961 + #3313 #3302 #3287 #3328 #3333 #3334 #3330):
//   retired nothing, each item below was re-read in node_modules/@luma.gl/*/dist.
//   - Buffer.readAsync on a non-MAP_READ buffer: #3330 stages only the requested range, but it still
//     creates a temporary buffer, waits on onSubmittedWorkDone and submits its own encoder per call.
//     core/readback.ts keeps its own MAP_READ slots on the caller's encoder (one submit, no allocation).
//   - GPUReadbackRing has fixed-size slots (byteLength per ring) and its tickets go through
//     Buffer.readAsync; core/readback.ts implements the same ticket pattern with grow-on-demand slots
//     (the ring is re-exported here for callers with a fixed readback size).
//   - (retired on rigi.4, see below) core/queue.ts submitWithDefault called the private
//     WebGPUDevice._finalizeDefaultCommandEncoderForSubmit. deck/device-lost.ts still
//     writes WebGLDevice._resolveContextLost/_isLost/_lossWasRequested/_moduleData and reads the
//     default PipelineFactory's _sharedRenderPipelineCache (unchanged by #3287); the state tracker
//     comes from the public WebGLStateTracker.get(gl).
//   - setGPUComputeDispatchWorkgroups is still not exported from @luma.gl/gpgpu/gpu-core, so
//     core/graph.ts applies its validation by hand.
// - rigi.4 adoption (luma patches in vendor/luma/patches): CommandEncoder.clearBuffer replaces the raw
//   handle clear in core/pool.ts clear(); Device.submit(undefined, extras) replaces the private
//   _finalizeDefaultCommandEncoderForSubmit + raw queue.submit in core/queue.ts submitWithDefault
//   (luma also resolves the default encoder's GPU time and defers freeing transient upload buffers of
//   every submitted buffer until the work completes); Buffer.mapAndReadAsync(cb, off, len,
//   {waitForSubmittedWork: false}) replaces the raw mapAsync in core/readback.ts (MAP_READ slots are
//   mapped in place, no staging copy); RenderBundleEncoder sampleCount > 1 replaces the native
//   bundle encoder in deck-webgpu/render-bundle.ts.
// - GPUProgram / GPUProgramCompiler (semantic scalar ops, literals baked at compile, GPU predicates
//   lowered to indirect-dispatch gates) are used by look/haze-argmin.ts, with our kernels lowered
//   into the program's graph through a registered lowering (core/graph.ts ComputeGraph adopts it).
// - GPUCommandGraphInspector (bounded per-node CPU / GPU timing samples over compiled graphs) is used
//   only by core/inspector.ts (one inspector per device, opt-in; see core/inspect.ts).

import type { Buffer, Device, DeviceProps } from "@luma.gl/core";
import type { WebGPUBuffer, WebGPUDevice } from "@luma.gl/webgpu";
import { webgpuAdapter } from "@luma.gl/webgpu";

/**
 * Wraps an app-created GPUDevice as a luma Device (WebGPUAdapter.attach, luma #3313). Call the
 * adapter directly, not luma.attachDevice. `ownsHandle` makes Device.destroy() also destroy the
 * GPUDevice (releaseWhenIdle relies on it); false leaves it alive, for ORT's device. We do this
 * ourselves because #3313 dropped its `_ownsHandle` prop (b1728918): attached devices always
 * belong to the app upstream, so passing the prop would silently leak on the npm release.
 */
export { webgpuAdapter };

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

/**
 * The native GPUDevice behind a luma WebGPU device (WebGPUDevice.handle, public), for libraries that
 * take native objects (onnxruntime-web). With attachWebGPUDevice, the app's one WebGPU interop point.
 */
export const nativeWebGPUDevice = (device: Device): GPUDevice =>
	(device as WebGPUDevice).handle;

/** The native GPUBuffer behind a luma WebGPU buffer (WebGPUBuffer.handle, public), for ORT tensors. */
export const nativeWebGPUBuffer = (buffer: Buffer): GPUBuffer =>
	(buffer as WebGPUBuffer).handle;

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
	GPUConvolution,
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
