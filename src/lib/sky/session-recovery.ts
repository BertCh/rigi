// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Device-loss detection for the sky worker (CR-12). After a loss the cached webgpu model and the GPU
// prep / refine graphs are dropped and the next request rebuilds them on the new compute device (no CPU
// pinning). Pure, no GPU imports.

/** True for the errors WebGPU raises when the device is gone (lost, destroyed, invalid). */
export function isDeviceLossError(e: unknown): boolean {
	const text =
		e instanceof Error
			? `${e.name} ${e.message}`
			: typeof e === "string"
				? e
				: "";
	return /device[^.]{0,24}(lost|destroyed)|(lost|destroyed)[^.]{0,24}device|GPUDeviceLostInfo|context lost|DXGI_ERROR_DEVICE_(REMOVED|HUNG)|Parent device is lost/i.test(
		text,
	);
}
