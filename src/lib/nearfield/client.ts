// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Step Inside's near-field source: the in-browser client (./local/client.ts: MoGe-2 ViT-S on src/lib/nn
// + the depth lift on the compute graph). WebGPU only. available() / prefetch() never throw; depth() and
// gaussiansWithMeta() reject with a NearFieldError (or an AbortError when the caller aborted).
import { localNearField } from "./local/client";
import type { GaussianCloud, NearFieldDepth } from "./types";

export type DepthModel = "moge2";
export type GaussianModel = "lift";
export type NearFieldUnavailableReason = "no-webgpu" | "weights-unreachable";

export type NearFieldErrorCode =
	| NearFieldUnavailableReason
	| "weights-failed"
	| "timeout"
	| "device-lost"
	| "out-of-memory"
	| "inference-failed"
	| "lift-failed";

/** A structured near-field failure: `code` says what to tell the user, `cause` keeps the original. */
export class NearFieldError extends Error {
	constructor(
		readonly code: NearFieldErrorCode,
		message?: string,
		options?: { cause?: unknown },
	) {
		super(message ?? code, options);
		this.name = "NearFieldError";
	}
}

export type RequestOpts = { signal?: AbortSignal; timeoutMs?: number };
/** Metadata of a lifted cloud (only the fields callers rely on are typed). */
export type GaussianMeta = {
	width?: number;
	height?: number;
	intrinsicsNorm?: { fx: number; fy: number; cx: number; cy: number };
	[k: string]: unknown;
};

/** What Step Inside and the roll spot need from a near-field source. */
export type NearFieldSource = {
	/** Never throws. */
	available(force?: boolean): Promise<boolean>;
	/** available() with the reason when it is false. Never throws. */
	availability?(
		force?: boolean,
	): Promise<{ ok: boolean; reason?: NearFieldUnavailableReason }>;
	/** Fetch the model weights ahead of the first build (no device work); false on failure. Never throws. */
	prefetch?(signal?: AbortSignal): Promise<boolean>;
	/**
	 * Rejects with a NearFieldError (`timeoutMs` → "timeout"), or an AbortError when `signal` aborted.
	 * Null only when the source has no depth for the photo.
	 */
	depth(
		image: Blob,
		opts?: RequestOpts & {
			model?: DepthModel;
			maxSide?: number;
			/** progress text (model download, inference) */
			onProgress?: (message: string) => void;
		},
	): Promise<NearFieldDepth | null>;
	/** Rejects like depth(). */
	gaussiansWithMeta(
		image: Blob,
		opts?: RequestOpts & {
			model?: GaussianModel;
			onProgress?: (message: string) => void;
		},
	): Promise<{ cloud: GaussianCloud; meta: GaussianMeta } | null>;
};

/** Step Inside's default source: in the browser (./local/client.ts). */
export const nearField: NearFieldSource = localNearField;
