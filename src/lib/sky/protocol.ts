// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import type { ModelDownload } from "../models/progress";

/** Messages between index.ts and sky.worker.ts. */
export interface SkySegmentRequest {
	type: "segment";
	id: number;
	width: number;
	height: number;
	/**
	 * RGBA bytes at working resolution (transferred). Absent when `bitmap` is sent alone (the GPU prep
	 * of an already verified device); present with `bitmap` while the worker still verifies the GPU
	 * prep against it.
	 */
	rgba?: ArrayBuffer;
	/**
	 * The working-resolution photo as an ImageBitmap (premultiplyAlpha / colorSpaceConversion
	 * 'none', transferred; exactly width × height): the worker uploads it and prepares the model
	 * input on the GPU (gpu/sky/prep.ts, bit-identical to the CPU chain). Needs `gpu`. If the GPU prep
	 * cannot run and `rgba` is absent the worker answers `needPixels`.
	 */
	bitmap?: ImageBitmap;
	refine: boolean;
	/** Model input long side (default per backend, see MODEL_LONG_SIDE). */
	modelLongSide?: number;
	/** Restrict the nn backend (default: WebGPU if available, else the CPU reference backend). */
	backend?: "webgpu" | "cpu";
	/** Skip the model (testing the classical path). */
	forceFallback?: boolean;
	/**
	 * The page's gpuEnabled() (?gpu=off → false): the worker has no page URL. When true, the model
	 * (nn WebGPU backend) and the refine run on the worker's luma compute device (src/lib/gpu/sky).
	 */
	gpu?: boolean;
}

/** Start fetching the model weights and creating the nn model; replies when ready. */
export interface SkyPreloadRequest {
	type: "preload";
	id: number;
	backend?: "webgpu" | "cpu";
	/** As SkySegmentRequest.gpu (decides whether the model runs on the compute device). */
	gpu?: boolean;
}

export type SkyWorkerRequest = SkySegmentRequest | SkyPreloadRequest;

export type SkyWorkerResponse =
	| {
			id: number;
			ok: true;
			type: "segment";
			width: number;
			height: number;
			data: ArrayBuffer;
			source: "model" | "fallback";
			backend?: "webgpu" | "cpu";
			error?: string;
			ms: { load: number; infer: number; refine: number };
			/** Where the refine ran (the GPU path falls back to the CPU on any error). */
			refineOn?: "gpu" | "cpu";
			/** Where the model input was prepared, and the GPU prep's per-device verification state. */
			prep?: SkyPrepStatus;
	  }
	| {
			id: number;
			ok: true;
			type: "preload";
			/** null when the model could not be loaded (fallback will be used). */
			backend: "webgpu" | "cpu" | null;
			error?: string;
			ms: number;
	  }
	| {
			id: number;
			ok: false;
			error: string;
			/** The worker needs the RGBA bytes (verifying or falling back from the GPU prep): resend with `rgba`. */
			needPixels?: boolean;
	  };

/** Per-device state of the GPU prep, reported on every segment reply (sky/prep.ts). */
export interface SkyPrepStatus {
	on: "gpu" | "cpu";
	/** Photos whose GPU prep matched the CPU chain bit for bit on this device. */
	verified: number;
	/** Set once a verification mismatched (or errors repeated): the GPU prep stays off for this device. */
	disabled?: string;
}

/** Model-download status of the worker realm, forwarded for the page's progress store (no id). */
export interface SkyProgressMessage {
	type: "progress";
	downloads: readonly ModelDownload[];
}
