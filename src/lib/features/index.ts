// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { getNn, type Nn, perNn, type Weights } from "#/lib/nn";
/**
 * Browser ALIKED + LightGlue: the keypoint extractor and matcher of the former Python matcher
 * and relative-rotation services (removed 2026-10-02; reference: tools/matcher/match.py), on the
 * src/lib/nn runtime (WGSL kernels on the compute graph; WebGPU only, no CPU forward).
 * Same configuration as the services: ALIKED-n16, detection threshold 0.01, long side 1024 (lightglue's
 * resize), up to `maxKeypoints` (matcher 4096, propagation 2048); LightGlue(aliked) with filter threshold
 * 0.1 and its adaptive depth / width. Weights: scripts/models/aliked-lightglue.py.
 *
 * These functions run on the calling thread; `./client` has the same API backed by a worker.
 * Parity with PyTorch: __tests__/parity.check.ts (fixtures from the producer's `fixtures` command).
 */
import { ALIKED_WEIGHTS, runAliked } from "./aliked";
import { LIGHTGLUE_WEIGHTS, runLightGlue } from "./lightglue";
import { type RgbaImage, rgbaToPlanes } from "./preprocess";
import { warmAliked } from "./warm";

export type FeatureSet = {
	width: number;
	height: number;
	/** N×2, pixels, origin top-left (pixel centres at integers, as lightglue). */
	keypoints: Float32Array;
	scores: Float32Array;
	/** N×dim, L2-normalised. */
	descriptors: Float32Array;
	dim: number;
	count: number;
};
export type FeatureMatches = {
	indices0: Uint32Array;
	indices1: Uint32Array;
	scores: Float32Array;
	count: number;
};
export type ImageInput = ImageBitmap | ImageData | RgbaImage;

export const DEFAULT_MAX_KEYPOINTS = 4096;
export const DEFAULT_LONG_SIDE = 1024;
export const DEFAULT_MIN_SCORE = 0.1;
interface Models {
	nn: Nn;
	aliked: Weights;
	lightglue: Weights;
}

/** GPU only: the error of a page without WebGPU (or a lost device that did not come back). */
const NEEDS_WEBGPU = "features: needs WebGPU";

// weights per nn runtime: a device loss drops the runtime (nn/registry), the next call rebuilds on the new one
const weightsOf = perNn(async (nn) => {
	const [aliked, lightglue] = await Promise.all([
		nn.loadWeights(ALIKED_WEIGHTS),
		nn.loadWeights(LIGHTGLUE_WEIGHTS),
	]);
	// background compile of the common first extract; never blocks or fails a request
	void warmAliked(nn, aliked).catch(() => {});
	return { nn, aliked, lightglue };
});

async function loadModels(): Promise<Models> {
	const nn = await getNn("features");
	if (!nn) throw new Error(NEEDS_WEBGPU);
	return weightsOf(nn);
}

/** True when WebGPU and both weight files load (fetches the weights, ~25 MB, once per device). */
export async function featuresAvailable(): Promise<boolean> {
	try {
		await loadModels();
		return true;
	} catch {
		return false;
	}
}

function toRgba(image: ImageInput): RgbaImage {
	if ("data" in image) return image;
	const bmp = image as ImageBitmap;
	const canvas = new OffscreenCanvas(bmp.width, bmp.height);
	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("features: no 2d context for the ImageBitmap");
	ctx.drawImage(bmp, 0, 0);
	return ctx.getImageData(0, 0, bmp.width, bmp.height);
}

const aborted = (signal?: AbortSignal) => {
	if (signal?.aborted)
		throw signal.reason ?? new DOMException("Aborted", "AbortError");
};

export async function extractFeatures(
	image: ImageInput,
	opts: { maxKeypoints?: number; longSide?: number; signal?: AbortSignal } = {},
): Promise<FeatureSet> {
	const { nn, aliked } = await loadModels();
	aborted(opts.signal);
	const rgba = toRgba(image);
	const rgb = nn.fromArray(rgbaToPlanes(rgba), [1, 3, rgba.height, rgba.width]);
	try {
		const r = await runAliked(nn, aliked, rgb, {
			maxKeypoints: opts.maxKeypoints ?? DEFAULT_MAX_KEYPOINTS,
			longSide: opts.longSide ?? DEFAULT_LONG_SIDE,
		});
		return {
			width: rgba.width,
			height: rgba.height,
			keypoints: r.keypoints,
			scores: r.scores,
			descriptors: r.descriptors,
			dim: 128,
			count: r.count,
		};
	} finally {
		nn.dispose(rgb);
	}
}

export async function matchFeatures(
	a: FeatureSet,
	b: FeatureSet,
	opts: { minScore?: number; signal?: AbortSignal } = {},
): Promise<FeatureMatches> {
	const { nn, lightglue } = await loadModels();
	aborted(opts.signal);
	const r = await runLightGlue(nn, lightglue, a, b, {
		threshold: opts.minScore ?? DEFAULT_MIN_SCORE,
	});
	return compactMatches(r.matches0, r.scores0);
}

/** matches0 (−1 = none) → index pairs in image-0 order. */
export function compactMatches(
	matches0: Int32Array,
	scores0: Float32Array,
): FeatureMatches {
	let count = 0;
	for (const j of matches0) if (j >= 0) count++;
	const indices0 = new Uint32Array(count);
	const indices1 = new Uint32Array(count);
	const scores = new Float32Array(count);
	let k = 0;
	for (let i = 0; i < matches0.length; i++) {
		if (matches0[i] < 0) continue;
		indices0[k] = i;
		indices1[k] = matches0[i];
		scores[k++] = scores0[i];
	}
	return { indices0, indices1, scores, count };
}
