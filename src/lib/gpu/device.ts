// Shared WebGPU compute device. The implementation lives in ./core/device.ts; this module is the
// stable import path the kernels (and the deck-webgpu renderer) already use.
//
// - getComputeDevice(): the realm's WebGPU device (window or dedicated worker), or null (use the
//   CPU path). When the renderer runs on WebGPU and called adoptRenderDevice(device), compute runs
//   on that SAME device (one queue; look passes read render targets without copies). Otherwise it
//   is the lazily created "compute sidecar".
// - adoptRenderDevice(device): the renderer's hand-off. WebGL devices / null are ignored; losing
//   the adopted device falls back to the sidecar.
//
// Every caller MUST keep a CPU path: getComputeDevice() resolves null when WebGPU is missing
// (Safari/Firefox before macOS 26, older iOS), disabled, or the device was lost. The CPU code is
// the accuracy reference.
//
// Kill switch: ?gpu=off (src/lib/flags; harnesses set globalThis.__RIGI_FLAGS__.gpu, also inside
// workers). Default: on when WebGPU is available.

import type { Flags } from "#/lib/flags";

export {
	adoptedRenderDevice,
	adoptRenderDevice,
	getComputeDevice,
	gpuEnabled,
	hasFeature,
	releaseWhenIdle,
	resetComputeDevice,
} from "./core/device";

/** The ?gpu flag's value ("on" | "off"). */
export type GpuMode = Flags["gpu"];
