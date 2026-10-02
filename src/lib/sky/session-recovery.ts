// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// What the sky worker does after a GPU device loss (CR-12). ORT's WebGPU EP is initialised once per
// worker on one device, so a session cannot be re-created on the GPU after that device died: the
// cached sessions are dropped and later loads are pinned to WASM (and the worker's GPU prep/refine
// is skipped) until the worker is re-created. Pure state, no ORT or GPU imports.

/** True for the errors WebGPU / ORT raise when the device is gone (lost, destroyed, invalid). */
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

export type Backend = "webgpu" | "wasm";

export type SessionRecovery = {
	/** A device loss was seen: GPU sessions and the worker's GPU compute are off for good. */
	readonly deviceLost: boolean;
	/**
	 * Feed any failure from a run / prep / refine. Returns true exactly once, when this error is
	 * the first device loss: the caller must drop its cached sessions now.
	 */
	noteFailure(e: unknown): boolean;
	/** The backend to request: after a loss everything runs on WASM, whatever was asked. */
	backendFor(requested: Backend | undefined): Backend | undefined;
};

export function createSessionRecovery(): SessionRecovery {
	let lost = false;
	return {
		get deviceLost() {
			return lost;
		},
		noteFailure(e) {
			if (lost || !isDeviceLossError(e)) return false;
			lost = true;
			return true;
		},
		backendFor: (requested) => (lost ? "wasm" : requested),
	};
}
