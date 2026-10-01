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
// - Still worked around: Buffer.readAsync on a non-MAP_READ buffer still stages per call, so core/readback.ts keeps its
//   own MAP_READ slots.
// - GPUReadbackRing has fixed-size slots; core/readback.ts implements the same ticket pattern with
//   grow-on-demand slots (re-exported here for callers with a fixed readback size).

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
