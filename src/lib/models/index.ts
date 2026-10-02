// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Model weights for in-browser compute: served from public/models (content-hashed filenames, listed
// in scripts/models/manifest.json), cached in Cache Storage, run with onnxruntime-web on the app's
// WebGPU device (WASM fallback). See README.md. ORT is imported lazily: fetchModel and modelUrl do
// not pull it in.

import type { Device } from "@luma.gl/core";
import type { InferenceSession } from "onnxruntime-web";
import { fetchModel, isNodeRuntime } from "./fetch";
import type { OrtBackend, OrtSessionBytesOptions } from "./ort";

export type { FetchModelOptions, ModelEntry } from "./fetch";
export {
	fetchModel,
	filenameHash,
	MODEL_CACHE,
	modelEntry,
	modelFileName,
	modelUrl,
	verifyModel,
} from "./fetch";
export type { OrtBackend } from "./ort";
export type { ModelDownload, ModelDownloadState } from "./progress";
export {
	describeModelDownload,
	formatBytes,
	modelDownloads,
	subscribeModelDownloads,
} from "./progress";

export type CreateOrtSessionOptions = {
	/** The app's luma device; a WebGPU device is handed to ORT so model tensors live on it. */
	device?: Device;
	/** false = WASM only. Default true: WebGPU on a hardware adapter, then WASM. */
	preferWebGpu?: boolean;
	signal?: AbortSignal;
	onProgress?: (loaded: number, total: number) => void;
	/** Explicit backend order (overrides preferWebGpu); ["webgpu"] alone also allows software adapters. */
	backends?: OrtBackend[];
	/** Keep outputs on the GPU when ORT runs on `device` (see OrtSessionBytesOptions.outputOnGpu). */
	outputOnGpu?: boolean;
	sessionOptions?: OrtSessionBytesOptions["sessionOptions"];
};

export type CreatedOrtSession = {
	session: InferenceSession;
	backend: OrtBackend;
	/** Set when ORT runs on `device` itself (GPU tensors are then `device`'s buffers). */
	sharedDevice?: GPUDevice;
	/** ORT's own device attached to luma, when ORT had already initialised on another device. */
	ortDevice?: Device;
};

/** The native GPUDevice behind a luma WebGPU device; undefined on WebGL. */
async function nativeDevice(
	device: Device | undefined,
): Promise<GPUDevice | undefined> {
	if (device?.type !== "webgpu") return undefined;
	const { nativeWebGPUDevice } = await import("#/lib/gpu/core/luma");
	return nativeWebGPUDevice(device);
}

/**
 * Loads public/models/<file> (fetchModel) and creates an ONNX Runtime session: WebGPU on `device`
 * when possible, else WASM. One ORT WebGPU device per realm: the first WebGPU session fixes it.
 */
export async function createOrtSession(
	file: string,
	opts: CreateOrtSessionOptions = {},
): Promise<CreatedOrtSession> {
	const [buf, ortModule] = await Promise.all([
		fetchModel(file, { signal: opts.signal, onProgress: opts.onProgress }),
		import("./ort"),
	]);
	opts.signal?.throwIfAborted();
	if (!isNodeRuntime()) await ortModule.configureOrtWasm();
	return ortModule.createOrtSessionFromBytes(new Uint8Array(buf), {
		backends:
			opts.backends ?? (opts.preferWebGpu === false ? ["wasm"] : undefined),
		device: await nativeDevice(opts.device),
		outputOnGpu: opts.outputOnGpu,
		sessionOptions: opts.sessionOptions,
	});
}
