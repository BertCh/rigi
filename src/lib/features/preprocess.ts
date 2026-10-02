// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * Image → ALIKED input, as lightglue's `Extractor.extract` does it: RGB in [0, 1], resized so the long
 * side is `longSide` with kornia's `resize(side="long", antialias=True)` (a Gaussian pre-blur when
 * shrinking, then bilinear with half-pixel centres), then replicate-padded to a multiple of 32
 * (ALIKED's InputPadder). The sizes and kernels are pure functions (spec-tested); `preprocessImage`
 * runs the blur / resize / pad as nn ops so they execute on the same graph as the network.
 */
import type { Nn, Tensor } from "#/lib/nn";

/** RGBA pixels (ImageData-compatible). */
export interface RgbaImage {
	data: Uint8Array | Uint8ClampedArray;
	width: number;
	height: number;
}

/** kornia `_side_to_image_size(longSide, w / h, "long")`: [height, width] (Python int() truncation). */
export function resizedSize(
	width: number,
	height: number,
	longSide: number,
): [number, number] {
	const aspect = width / height;
	return aspect < 1
		? [longSide, Math.trunc(longSide * aspect)]
		: [Math.trunc(longSide / aspect), longSide];
}

/**
 * kornia's antialias kernel for one axis with shrink `factor` (in / out): sigma = max((f-1)/2, 0.001),
 * size = int(max(4 sigma, 3)) made odd; a normalised Gaussian. Null when the axis does not shrink
 * (kornia blurs only when max(factors) > 1, then on both axes; a 3-tap kernel with sigma 0.001 is the identity).
 */
export function antialiasKernel(factor: number): Float32Array {
	const sigma = Math.max((factor - 1) / 2, 0.001);
	let size = Math.trunc(Math.max(4 * sigma, 3));
	if (size % 2 === 0) size += 1;
	const k = new Float64Array(size);
	const mean = Math.floor(size / 2);
	let total = 0;
	for (let i = 0; i < size; i++) {
		k[i] = Math.exp(-((i - mean) ** 2) / (2 * sigma * sigma));
		total += k[i];
	}
	return Float32Array.from(k, (v) => v / total);
}

/** ALIKED InputPadder(h, w, 32): F.pad order [left, right, top, bottom]. */
export function padTo32(
	height: number,
	width: number,
	div = 32,
): [number, number, number, number] {
	const ph = ((Math.floor(height / div) + 1) * div - height) % div;
	const pw = ((Math.floor(width / div) + 1) * div - width) % div;
	return [pw >> 1, pw - (pw >> 1), ph >> 1, ph - (ph >> 1)];
}

/** Planar RGB float32 [3, H, W] in [0, 1] from RGBA bytes. */
export function rgbaToPlanes(img: RgbaImage): Float32Array {
	const n = img.width * img.height;
	const out = new Float32Array(3 * n);
	const d = img.data;
	for (let i = 0; i < n; i++) {
		out[i] = d[4 * i] / 255;
		out[n + i] = d[4 * i + 1] / 255;
		out[2 * n + i] = d[4 * i + 2] / 255;
	}
	return out;
}

export interface Prepared {
	/** Unpadded resized image [1, 3, h, w]. */
	image: Tensor;
	/** Replicate-padded image [1, 3, h + top + bottom, w + left + right]. */
	padded: Tensor;
	height: number;
	width: number;
	/** [left, right, top, bottom]. */
	pads: [number, number, number, number];
	/** Resized / original size per axis (lightglue's `scales`: x then y). */
	scaleX: number;
	scaleY: number;
}

/**
 * Enqueues resize + pad for an RGB [1, 3, H, W] tensor. Call inside `nn.forward`.
 */
export function preprocessImage(
	nn: Nn,
	rgb: Tensor,
	longSide: number,
): Prepared {
	const H = rgb.shape[2];
	const W = rgb.shape[3];
	const [h, w] = resizedSize(W, H, longSide);
	let x = rgb;
	const fy = H / h;
	const fx = W / w;
	if (Math.max(fy, fx) > 1) {
		const ky = antialiasKernel(fy);
		const kx = antialiasKernel(fx);
		const k2 = new Float32Array(3 * ky.length * kx.length);
		for (let c = 0; c < 3; c++)
			for (let i = 0; i < ky.length; i++)
				for (let j = 0; j < kx.length; j++)
					k2[(c * ky.length + i) * kx.length + j] = ky[i] * kx[j];
		const kernel = nn.fromArray(k2, [3, 1, ky.length, kx.length]);
		const ry = ky.length >> 1;
		const rx = kx.length >> 1;
		x = nn.conv2d(
			nn.pad(x, [rx, rx, ry, ry], { mode: "reflect" }),
			kernel,
			null,
			{
				groups: 3,
			},
		);
	}
	if (h !== H || w !== W)
		x = nn.interpolate(x, {
			size: [h, w],
			mode: "bilinear",
			alignCorners: false,
		});
	const pads = padTo32(h, w);
	const padded = pads.some((p) => p > 0)
		? nn.pad(x, pads, { mode: "replicate" })
		: x;
	return {
		image: x,
		padded,
		height: h,
		width: w,
		pads,
		scaleX: w / W,
		scaleY: h / H,
	};
}
