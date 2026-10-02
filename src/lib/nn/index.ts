// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// src/lib/nn: a small tensor runtime for neural-net forward passes in the browser. See README.md.
// GPU backend: WGSL kernels on one core ComputeGraph per forward (gpu/). CPU backend: the reference
// (cpu.ts), also the no-WebGPU fallback.

import type { Device } from "@luma.gl/core";
import { CpuNn } from "./cpu";
import type { Nn } from "./types";

export { CpuNn, CpuTensor } from "./cpu";
export { setModelFetcher } from "./fetch";
export {
	encodeSafetensors,
	floatToHalf,
	halfToFloat,
	halfToFloat32,
	parseSafetensors,
} from "./safetensors";
export type * from "./types";

export type CreateNnOptions = {
	/** the compute device (default: getComputeDevice(), i.e. the adopted render device or the sidecar) */
	device?: Device;
	/** "auto" (default): GPU on a WebGPU device, else CPU */
	backend?: "gpu" | "cpu" | "auto";
};

/** A tensor runtime on the GPU (WebGPU compute graph) or the CPU reference backend. */
export async function createNn(opts: CreateNnOptions = {}): Promise<Nn> {
	const want = opts.backend ?? "auto";
	if (want === "cpu") return new CpuNn();
	// the GPU backend (gpu/) lands next; until then "auto" is the CPU reference
	void opts.device;
	if (want === "gpu") throw new Error("nn: the GPU backend is not built yet");
	return new CpuNn();
}
