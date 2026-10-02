// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * The U²-Net sky model on the nn runtime (u2netp.ts): WGSL kernels on one core ComputeGraph per forward
 * on the page's WebGPU compute device, the nn CPU reference backend otherwise. The same code runs in a
 * browser worker and in node (the eval scripts), with no ONNX Runtime.
 */
import type { Buffer, Device } from "@luma.gl/core";
import { createNn, type Nn, type Tensor, type Weights } from "#/lib/nn";
import { type ModelRun, modelSize, normalise, resamplePlanes } from "./core";
import { bindU2netp, runU2netp, U2NETP_WEIGHTS, type U2Netp } from "./u2netp";

/**
 * U²-Net-P sky model (MIT), the upstream ncnn weights as fp16 safetensors (skyseg-u2netp-nn.884ee489.safetensors,
 * scripts/models/u2netp.py, served by src/lib/models fetchModel; the filename carries the first 8 hex digits of its sha256).
 */
export const MODEL_FILE = U2NETP_WEIGHTS;
/**
 * Model input long side (px) per backend. Trained at 384²; 384 and 512 score the same on our photos.
 * The CPU reference backend is about 150 M MAC/s in plain JS (a 160×128 forward is ~8 s in node), so a
 * browser without WebGPU takes 192 and runs it off the main thread; the classical segmenter is the quick
 * alternative (`forceFallback`).
 */
export const MODEL_LONG_SIDE: Record<Backend, number> = {
	webgpu: 512,
	cpu: 192,
};

export type Backend = "webgpu" | "cpu";

export interface SkyModel {
	net: U2Netp;
	nn: Nn;
	backend: Backend;
	/** The luma device the model runs on (webgpu): the refine and the prep share it. */
	device?: Device;
	/** Frees the weights (the device stays the caller's). */
	dispose(): void;
}

export interface CreateSkyModelOptions {
	/** The compute device: a WebGPU device enables the "webgpu" backend. */
	device?: Device | null;
	/** Preference order (default: webgpu when `device` is WebGPU, then cpu). */
	backends?: Backend[];
	/** The safetensors bytes (default: fetchModel(MODEL_FILE), Cache Storage in the browser). */
	bytes?: Uint8Array | ArrayBuffer;
	signal?: AbortSignal;
	onProgress?: (loaded: number, total: number) => void;
}

/** Creates the model on the first backend that works. */
export async function createSkyModel(
	opts: CreateSkyModelOptions = {},
): Promise<SkyModel> {
	const order = opts.backends ?? ["webgpu", "cpu"];
	let firstError: unknown;
	for (const backend of order) {
		try {
			if (backend === "webgpu" && opts.device?.type !== "webgpu")
				throw new Error("sky model: the webgpu backend needs a WebGPU device");
			const nn = await createNn(
				backend === "webgpu"
					? { device: opts.device as Device, backend: "gpu" }
					: { backend: "cpu" },
			);
			const weights: Weights = opts.bytes
				? nn.weightsFromBytes(opts.bytes)
				: await nn.loadWeights(MODEL_FILE, {
						signal: opts.signal,
						onProgress: opts.onProgress,
					});
			return {
				net: bindU2netp(weights),
				nn,
				backend,
				device: backend === "webgpu" ? (opts.device ?? undefined) : undefined,
				dispose: () => nn.dispose(weights),
			};
		} catch (e) {
			console.warn(`[sky] ${backend} model backend unavailable:`, e);
			firstError ??= e;
		}
	}
	throw firstError ?? new Error("sky model: no backend");
}

/** The model's raw output: on the CPU, or still on the GPU when the model runs on WebGPU. */
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
	/**
	 * The output buffer (≥ width·height f32) on `model.device`, valid until `release()` and once the
	 * forward has resolved (it has when this object exists).
	 */
	gpuBuffer?: GPUBuffer;
	/** P(sky) on the CPU (downloads a GPU output; call before `release()`). */
	download(): Promise<Float32Array>;
	/** Frees the output tensor (the GPU buffer returns to the runtime's free list). */
	release(): void;
}

type GpuNnLike = Nn & {
	fromBuffer(buffer: Buffer, shape: readonly number[]): Tensor;
	bufferOf(t: Tensor): Buffer;
};

/**
 * Runs the model on a planar RGB (0..1) image of size W×H. The output stays on the GPU on the webgpu
 * backend; otherwise it is P(sky) on the CPU.
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
	const input = model.nn.fromArray(normalise(rgb, width * height), [
		1,
		3,
		height,
		width,
	]);
	return run(model, input, width, height, rgb);
}

/**
 * inferSkyModel with the GPU prep (gpu/sky/prep.ts): `input` is the normalised NCHW float32 buffer
 * (3·width·height) on `model.device`, read in place, so the photo never leaves the GPU. The caller owns
 * the buffer (the model neither frees nor retains it past the run); the result has no `rgbLo` (the
 * refine's guide is the prep's own buffer).
 */
export async function inferSkyModelGpu(
	model: SkyModel,
	input: Buffer,
	width: number,
	height: number,
): Promise<SkyInference> {
	if (model.backend !== "webgpu")
		throw new Error("inferSkyModelGpu: the model is not on the GPU");
	const x = (model.nn as GpuNnLike).fromBuffer(input, [1, 3, height, width]);
	return run(model, x, width, height, undefined);
}

async function run<L extends Float32Array | undefined>(
	model: SkyModel,
	input: Tensor,
	width: number,
	height: number,
	rgbLo: L,
): Promise<SkyInference & { rgbLo: L }> {
	const { nn } = model;
	let prob: Tensor;
	try {
		({ prob } = await nn.forward(() => runU2netp(nn, model.net, input)));
	} finally {
		nn.dispose(input);
	}
	let host: Float32Array | undefined;
	let gpuBuffer: GPUBuffer | undefined;
	if (model.backend === "webgpu") {
		const { nativeWebGPUBuffer } = await import("#/lib/gpu/core/luma");
		gpuBuffer = nativeWebGPUBuffer((nn as GpuNnLike).bufferOf(prob));
	}
	return {
		width,
		height,
		rgbLo,
		gpuBuffer,
		prob: gpuBuffer ? undefined : await nn.read(prob),
		download: async () => {
			host ??= await nn.read(prob);
			return host;
		},
		release: () => nn.dispose(prob),
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
