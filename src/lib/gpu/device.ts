// Shared WebGPU compute device (the "compute sidecar"). The renderers stay on WebGL2; compute
// kernels (horizon, pose scoring, look passes) run on this separate luma.gl WebGPU device, in
// whichever thread calls getComputeDevice() (window or dedicated worker, one device per realm).
//
// Every caller MUST keep a CPU path: getComputeDevice() resolves null when WebGPU is missing
// (Safari/Firefox before macOS 26, older iOS), disabled, or the device was lost. The CPU code is
// the accuracy reference.
//
// Kill switch, checked in order: globalThis.__RIGI_GPU__ (set by tests), ?gpu=off|on in the page
// URL, localStorage "rigi.gpu" = "off"|"on". Default: on when WebGPU is available.

import { type Device, luma } from "@luma.gl/core";
import { webgpuAdapter } from "@luma.gl/webgpu";

export type GpuMode = "on" | "off";

function readMode(): GpuMode {
	const g = (globalThis as { __RIGI_GPU__?: GpuMode }).__RIGI_GPU__;
	if (g === "on" || g === "off") return g;
	try {
		const q = new URLSearchParams(globalThis.location?.search ?? "").get("gpu");
		if (q === "on" || q === "off") return q;
	} catch {}
	try {
		const s = globalThis.localStorage?.getItem("rigi.gpu");
		if (s === "on" || s === "off") return s;
	} catch {}
	return "on";
}

export const gpuEnabled = () =>
	readMode() === "on" &&
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

/** For tests and benchmarks: drop the cached device so the next call re-creates it. */
export function resetComputeDevice() {
	const p = pending;
	pending = null;
	p?.then((d) => d?.destroy());
}
