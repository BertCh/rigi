// Shared WebGPU compute device (the "compute sidecar"). The renderers stay on WebGL2; compute
// kernels (horizon, pose scoring, look passes) run on this separate luma.gl WebGPU device, in
// whichever thread calls getComputeDevice() (window or dedicated worker, one device per realm).
//
// Every caller MUST keep a CPU path: getComputeDevice() resolves null when WebGPU is missing
// (Safari/Firefox before macOS 26, older iOS), disabled, or the device was lost. The CPU code is
// the accuracy reference.
//
// Kill switch: ?gpu=off (src/lib/flags; harnesses set globalThis.__RIGI_FLAGS__.gpu, also inside
// workers). Default: on when WebGPU is available.

import { type Device, luma } from "@luma.gl/core";
import { webgpuAdapter } from "@luma.gl/webgpu";
import { getFlag } from "#/lib/flags";

export const gpuEnabled = () =>
	getFlag("gpu") === "on" &&
	typeof navigator !== "undefined" &&
	!!(navigator as { gpu?: unknown }).gpu;

let pending: Promise<Device | null> | null = null;

/** The realm's WebGPU compute device, or null (use the CPU path). Never throws. */
export function getComputeDevice(): Promise<Device | null> {
	if (!gpuEnabled()) return Promise.resolve(null);
	pending ??= create();
	return pending;
}

async function create(): Promise<Device | null> {
	try {
		const device = await luma.createDevice({
			id: "rigi-compute",
			type: "webgpu",
			adapters: [webgpuAdapter],
			powerPreference: "high-performance",
			optionalFeatures: [
				"timestamp-query",
				"float32-filterable",
				"subgroups",
				"shader-f16",
			],
		});
		device.lost.then((info) => {
			console.warn("[gpu] compute device lost", info);
			pending = null;
		});
		return device;
	} catch (e) {
		console.warn("[gpu] WebGPU unavailable, using CPU paths", e);
		return null;
	}
}
