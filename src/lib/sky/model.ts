// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * ONNX Runtime wrapper for the U²-Net sky model. Works with onnxruntime-web
 * in a browser worker (WebGPU → WASM) and in node (the package's node build,
 * CPU/WASM), so the eval script exercises exactly the same code.
 */
import type { Device } from "@luma.gl/core";
import * as ort from "onnxruntime-web";
import { createOrtSessionFromBytes, shareOrtDevice } from "#/lib/models/ort";
import { type ModelRun, modelSize, normalise, resamplePlanes } from "./core";

/**
 * U²-Net-P sky model (MIT), converted from the upstream ncnn weights (see
 * README.md). Served from the app's public dir; the filename carries the
 * first 8 hex digits of its sha256 so it can be served with immutable
 * long-cache headers. When replacing the model, rename it to the new hash
 * (scripts/sky-eval.ts verifies the name matches the content).
 */
export const MODEL_FILE = "models/skyseg-u2netp.873ea284.onnx";
/**
 * Model input long side (px) per backend. Trained at 384²; 384 and 512 score
 * the same on our photos, so the slower WASM path uses 384.
 */
export const MODEL_LONG_SIDE: Record<Backend, number> = {
	webgpu: 512,
	wasm: 384,
};

export type Backend = "webgpu" | "wasm";

export interface SkyModel {
	session: ort.InferenceSession;
	backend: Backend;
	/**
	 * The GPUDevice ORT's WebGPU EP runs on when it is the caller's device (see shareOrtDevice): the
	 * session then keeps its output on the GPU (inferSkyModel's `gpuBuffer`).
	 */
	sharedDevice?: GPUDevice;
	/**
	 * ORT's own device, attached to luma (not owned: ORT keeps ownership), when the shared
	 * device was not taken because ORT had already initialised on another one. The output then stays
	 * on this device (inferSkyModel's `gpuBuffer`) and refine runs on it; the compute shim stays primary.
	 */
	ortDevice?: Device;
}

export { shareOrtDevice };

/**
 * Creates the session from model bytes, trying WebGPU first (hardware
 * adapters only, unless `backends` is exactly ["webgpu"]), then WASM
 * (models/ort.ts createOrtSessionFromBytes, outputs kept on the GPU).
 */
export async function createSkyModel(
	bytes: Uint8Array,
	backends: Backend[] = ["webgpu", "wasm"],
	opts: { device?: GPUDevice } = {},
): Promise<SkyModel> {
	return createOrtSessionFromBytes(bytes, {
		backends,
		device: opts.device,
		outputOnGpu: true,
		tag: "[sky]",
	});
}

/** The model's raw output: on the CPU, or still on the GPU when the session shares the device. */
export interface SkyInference {
	width: number;
	height: number;
	/**
	 * resamplePlanes(rgbWork, W, H, 3, width, height): the model input, also the refine's low-res
	 * guide. Absent when the GPU prep produced the input (its rgbLo stays on the GPU).
	 */
	rgbLo?: Float32Array;
	/** P(sky) at model resolution, when the output is on the CPU. */
	prob?: Float32Array;
	/** The output buffer (width·height f32) on `model.sharedDevice`, valid until `release()`. */
	gpuBuffer?: GPUBuffer;
	/** P(sky) on the CPU (downloads a GPU output; call before `release()`). */
	download(): Promise<Float32Array>;
	/** Frees the output tensor (the GPU buffer returns to ORT's pool). */
	release(): void;
}

/**
 * Runs the model on a planar RGB (0..1) image of size W×H. The output stays on the GPU when the
 * session was created on a shared device; otherwise it is P(sky) on the CPU.
 */
export async function inferSkyModel(
	model: SkyModel,
	rgbWork: Float32Array,
	W: number,
	H: number,
	longSide = MODEL_LONG_SIDE[model.backend],
): Promise<SkyInference & { rgbLo: Float32Array }> {
	const { width, height } = modelSize(W, H, longSide);
	const rgb = resamplePlanes(rgbWork, W, H, 3, width, height);
	const input = new ort.Tensor("float32", normalise(rgb, width * height), [
		1,
		3,
		height,
		width,
	]);
	return runInput(model, input, width, height, rgb);
}

/**
 * inferSkyModel with the GPU prep (gpu/sky/prep.ts): `input` is the normalised NCHW float32 buffer
 * (3·width·height) on `model.sharedDevice`, handed to ORT as a GPU-buffer tensor, so the photo never
 * leaves the GPU. The caller owns the buffer (ORT neither frees nor retains it past the run); the
 * result has no `rgbLo` (the refine's guide is the prep's own buffer).
 */
export async function inferSkyModelGpu(
	model: SkyModel,
	input: GPUBuffer,
	width: number,
	height: number,
): Promise<SkyInference> {
	if (!model.sharedDevice)
		throw new Error(
			"inferSkyModelGpu: the session is not on the shared device",
		);
	const tensor = ort.Tensor.fromGpuBuffer(input, {
		dataType: "float32",
		dims: [1, 3, height, width],
	});
	return runInput(model, tensor, width, height, undefined, false);
}

async function runInput<L extends Float32Array | undefined>(
	model: SkyModel,
	input: ort.Tensor,
	width: number,
	height: number,
	rgbLo: L,
	dispose = true,
): Promise<SkyInference & { rgbLo: L }> {
	const s = model.session;
	let t: ort.Tensor;
	try {
		const out = await s.run({ [s.inputNames[0]]: input });
		t = out[s.outputNames[0]];
	} finally {
		if (dispose) input.dispose?.();
	}
	if (t.location === "gpu-buffer") {
		let prob: Float32Array | undefined;
		return {
			width,
			height,
			rgbLo,
			gpuBuffer: t.gpuBuffer as GPUBuffer,
			download: async () => {
				prob ??= new Float32Array((await t.getData()) as Float32Array);
				return prob;
			},
			release: () => t.dispose?.(),
		};
	}
	const prob = new Float32Array(t.data as Float32Array);
	t.dispose?.();
	return {
		width,
		height,
		rgbLo,
		prob,
		download: async () => prob,
		release: () => {},
	};
}

/**
 * Runs the model on a planar RGB (0..1) image of size W×H and returns P(sky)
 * at model resolution (long side `longSide`, multiples of 32).
 */
export async function runSkyModel(
	model: SkyModel,
	rgbWork: Float32Array,
	W: number,
	H: number,
	longSide = MODEL_LONG_SIDE[model.backend],
): Promise<ModelRun> {
	const r = await inferSkyModel(model, rgbWork, W, H, longSide);
	try {
		return { prob: await r.download(), width: r.width, height: r.height };
	} finally {
		r.release();
	}
}
