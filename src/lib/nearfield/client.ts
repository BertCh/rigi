// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Step Inside's near-field source: the in-browser client (./local/client.ts: MoGe-2 ViT-S on src/lib/nn
// + the depth lift on the compute graph). It degrades to `false` / `null` on failure and never throws.
import { localNearField } from "./local/client";
import type { GaussianCloud, NearFieldDepth } from "./types";

export type DepthModel = "moge2";
export type GaussianModel = "lift";
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
	available(force?: boolean): Promise<boolean>;
	/** Fetch the model weights ahead of the first build (no device work); false on failure. */
	prefetch?(signal?: AbortSignal): Promise<boolean>;
	depth(
		image: Blob,
		opts?: RequestOpts & {
			model?: DepthModel;
			maxSide?: number;
			/** progress text (model download, inference) */
			onProgress?: (message: string) => void;
		},
	): Promise<NearFieldDepth | null>;
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
