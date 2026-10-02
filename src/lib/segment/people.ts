// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * People segmentation nets on nn (tflite-net.ts): per-pixel P(person) from DeepLab v3 (VOC class 15) or
 * the selfie multiclass model (1 - P(background)), as MediaPipe's ImageSegmenter computed it: the image
 * stretched (bilinear) to the model size, (byte - 127.5) / 127.5, softmax over the classes at model
 * resolution, bilinear back up to the image size. Weights: scripts/models/mediapipe-seg.py (fp16
 * safetensors converted from the MediaPipe float32 .tflite files, Apache-2.0).
 */
import type { Nn, Tensor } from "#/lib/nn";
import { bindTfliteNet, runTfliteNet, type TfliteNet } from "./tflite-net";

export type PeopleModel = "multiclass" | "deeplab";

export const PEOPLE_WEIGHTS: Record<PeopleModel, string> = {
	multiclass: "selfie-multiclass-nn.c64d6152.safetensors",
	deeplab: "deeplab-v3-nn.70580c5b.safetensors",
};
/** Pascal VOC "person" class index in deeplab_v3. */
export const DEEPLAB_PERSON = 15;

export interface PeopleNet {
	model: PeopleModel;
	nn: Nn;
	net: TfliteNet;
}

export async function loadPeopleNet(
	nn: Nn,
	model: PeopleModel,
	opts: Parameters<Nn["loadWeights"]>[1] = {},
): Promise<PeopleNet> {
	return {
		model,
		nn,
		net: bindTfliteNet(await nn.loadWeights(PEOPLE_WEIGHTS[model], opts)),
	};
}

/** Model input size (W, H). */
export const peopleInputSize = (p: PeopleNet): [number, number] => [
	p.net.inputShape[2],
	p.net.inputShape[1],
];

/**
 * Bilinear resample (half-pixel centres, no antialiasing: PyTorch `align_corners=False`, what MediaPipe's
 * preprocessing does) of `channels` interleaved values per pixel; `map` converts each source value.
 */
export function resampleBilinear(
	src: ArrayLike<number>,
	sw: number,
	sh: number,
	channels: number,
	dw: number,
	dh: number,
	stride = channels,
	map: (v: number) => number = (v) => v,
): Float32Array {
	const out = new Float32Array(dw * dh * channels);
	const xs = new Int32Array(dw);
	const xs1 = new Int32Array(dw);
	const xf = new Float32Array(dw);
	for (let x = 0; x < dw; x++) {
		const f = Math.max(0, ((x + 0.5) * sw) / dw - 0.5);
		const i = Math.min(Math.floor(f), sw - 1);
		xs[x] = i;
		xs1[x] = Math.min(i + 1, sw - 1);
		xf[x] = f - i;
	}
	for (let y = 0; y < dh; y++) {
		const f = Math.max(0, ((y + 0.5) * sh) / dh - 0.5);
		const y0 = Math.min(Math.floor(f), sh - 1);
		const y1 = Math.min(y0 + 1, sh - 1);
		const fy = f - y0;
		for (let x = 0; x < dw; x++) {
			const fx = xf[x];
			for (let c = 0; c < channels; c++) {
				const a = map(src[(y0 * sw + xs[x]) * stride + c]);
				const b = map(src[(y0 * sw + xs1[x]) * stride + c]);
				const d = map(src[(y1 * sw + xs[x]) * stride + c]);
				const e = map(src[(y1 * sw + xs1[x]) * stride + c]);
				out[(y * dw + x) * channels + c] =
					(a * (1 - fx) + b * fx) * (1 - fy) + (d * (1 - fx) + e * fx) * fy;
			}
		}
	}
	return out;
}

/** The model input [1, H, W, 3] (NHWC, normalised) from RGBA pixels of any size (stretched, like MediaPipe). */
export function peopleInput(
	p: PeopleNet,
	rgba: ArrayLike<number>,
	width: number,
	height: number,
): Tensor {
	const [mw, mh] = peopleInputSize(p);
	const { mean, std } = p.net;
	// resample the three colour channels of the RGBA stride, normalising on load
	const data = resampleBilinear(
		rgba,
		width,
		height,
		3,
		mw,
		mh,
		4,
		(v) => (v - mean) / std,
	);
	return p.nn.fromArray(data, [1, mh, mw, 3]);
}

/**
 * P(person) [1, 1, H, W] at model resolution. Call inside `nn.forward(() => …)` on the GPU backend
 * (one submission); `x` is peopleInput's tensor.
 */
export function personProbability(p: PeopleNet, x: Tensor): Tensor {
	const { nn } = p;
	const probs = nn.softmax(runTfliteNet(nn, p.net, x).output, 1);
	return p.model === "multiclass"
		? // class 0 = background; everything else (hair, skin, clothes, others) = person
			nn.sub(1, nn.slice(probs, 1, 0, 1))
		: nn.slice(probs, 1, DEEPLAB_PERSON, DEEPLAB_PERSON + 1);
}

/**
 * Runs one model on RGBA pixels and returns P(person) (0..1) at `outWidth` x `outHeight` (row 0 = top).
 * Throws when the nn backend does.
 */
export async function runPeopleNet(
	p: PeopleNet,
	rgba: ArrayLike<number>,
	width: number,
	height: number,
	outWidth: number,
	outHeight: number,
): Promise<Float32Array> {
	const { nn } = p;
	const [mw, mh] = peopleInputSize(p);
	const x = peopleInput(p, rgba, width, height);
	try {
		const prob = await nn.forward(() => personProbability(p, x));
		const low = await nn.read(prob);
		nn.dispose(prob);
		return resampleBilinear(low, mw, mh, 1, outWidth, outHeight);
	} finally {
		nn.dispose(x);
	}
}
