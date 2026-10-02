// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Pure helpers of the GPU photo resample (photo-resample.ts): the box footprint of an output pixel,
// the tap stride that bounds a footprint, the sRGB byte encode, the padded row length of the packed
// buffer, and a CPU box-filter reference (the spec and scripts/gpu/look-photo-resample-dawn.ts
// compare the kernel against it).

/** Most taps along one axis of a footprint; wider footprints are strided (a sparse box). */
export const MAX_TAPS_PER_AXIS = 16;

/**
 * Source texels [a, b) of output pixel `i` of `n` over `size` source texels: floor(i·size/n) to
 * floor((i+1)·size/n), at least one texel (so an upscale is nearest). Integer arithmetic only, the
 * same expression as the WGSL.
 */
export function boxFootprint(
	i: number,
	n: number,
	size: number,
): [number, number] {
	const a = Math.floor((i * size) / n);
	const b = Math.max(a + 1, Math.min(size, Math.floor(((i + 1) * size) / n)));
	return [a, b];
}

/** Step between taps of a footprint of `extent` texels: 1 up to MAX_TAPS_PER_AXIS texels, then a stride. */
export function tapStride(extent: number): number {
	return Math.max(1, Math.ceil(extent / MAX_TAPS_PER_AXIS));
}

/** Row length in u32 words of the packed buffer: copyBufferToTexture needs 256-byte rows. */
export function packedRowWords(width: number): number {
	return Math.ceil((width * 4) / 256) * 64;
}

/** Linear [0, 1] to the sRGB-encoded byte (the WGSL enc() followed by round(v·255)). */
export function srgbEncodeByte(linear: number): number {
	const v = Math.min(1, Math.max(0, linear));
	const e = v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
	return Math.round(e * 255);
}

/** sRGB byte to linear [0, 1] (what an rgba8unorm-srgb textureLoad returns). */
export function srgbDecodeByte(byte: number): number {
	const e = byte / 255;
	return e <= 0.04045 ? e / 12.92 : ((e + 0.055) / 1.055) ** 2.4;
}

/**
 * CPU reference of the kernel: `src` is sRGB-encoded RGBA8 (sw × sh, row 0 = top). Each output
 * pixel is the rounded mean of the strided taps of its footprint; alpha is 255.
 */
export function boxResampleRgba(
	src: Uint8Array | Uint8ClampedArray,
	sw: number,
	sh: number,
	w: number,
	h: number,
): Uint8Array {
	const out = new Uint8Array(w * h * 4);
	for (let y = 0; y < h; y++) {
		const [y0, y1] = boxFootprint(y, h, sh);
		const sy = tapStride(y1 - y0);
		for (let x = 0; x < w; x++) {
			const [x0, x1] = boxFootprint(x, w, sw);
			const sx = tapStride(x1 - x0);
			const sum = [0, 0, 0];
			let n = 0;
			for (let yy = y0; yy < y1; yy += sy)
				for (let xx = x0; xx < x1; xx += sx) {
					const o = (yy * sw + xx) * 4;
					sum[0] += src[o];
					sum[1] += src[o + 1];
					sum[2] += src[o + 2];
					n++;
				}
			const o = (y * w + x) * 4;
			out[o] = Math.floor((sum[0] + (n >> 1)) / n);
			out[o + 1] = Math.floor((sum[1] + (n >> 1)) / n);
			out[o + 2] = Math.floor((sum[2] + (n >> 1)) / n);
			out[o + 3] = 255;
		}
	}
	return out;
}
