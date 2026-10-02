// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The compact "look" descriptor of a photo, LOOK_DIMS floats, for k-means grouping and similarity.
//
// Layout (all OKLab, each colour triple weighted LOOK_LAB_WEIGHTS = [1, 2.5, 2.5]: L spans 0..1 but
// a, b only about +-0.3, so the chroma axes are stretched until a hue difference counts about as much
// as a lightness difference in euclidean distance):
//   0..8    mean colour of the top / middle / bottom horizontal thirds (sky / middle / ground)
//   9..11   global standard deviation of L, a, b (contrast and colourfulness)
//   12..31  the palette colours sorted by L ascending, 5 slots of [L, a, b, share] (a, b weighted as
//           above, share x LOOK_SHARE_WEIGHT; unused slots are zeros)
// Embeddings are therefore comparable by euclidean distance (k-means) and, being mostly positive
// lightness-dominated vectors, by cosine (similarLooks).
import { type Oklab, oklabToSrgb8 } from "./oklab";
import {
	type PaletteColor,
	type PhotoPalette,
	type PhotoPixels,
	pixelsToOklab,
} from "./palette";

export const LOOK_PALETTE_SLOTS = 5;
export const LOOK_DIMS = 9 + 3 + LOOK_PALETTE_SLOTS * 4;
export const LOOK_LAB_WEIGHTS = [1, 2.5, 2.5] as const;
export const LOOK_SHARE_WEIGHT = 0.5;

export function photoLookEmbedding(
	pixels: PhotoPixels,
	palette: PhotoPalette,
): Float32Array {
	const out = new Float32Array(LOOK_DIMS);
	const { width, height } = pixels;
	const rowCount = width * height;
	if (rowCount === 0) return out;
	const lab = pixelsToOklab(pixels, 3);
	const bandSums = new Float64Array(9);
	const bandCounts = [0, 0, 0];
	const sums = [0, 0, 0];
	const squares = [0, 0, 0];
	for (let y = 0; y < height; y++) {
		const band = Math.min(2, Math.floor((y * 3) / height));
		for (let x = 0; x < width; x++) {
			const i = (y * width + x) * 3;
			bandCounts[band]++;
			for (let c = 0; c < 3; c++) {
				const v = lab[i + c];
				bandSums[band * 3 + c] += v;
				sums[c] += v;
				squares[c] += v * v;
			}
		}
	}
	for (let band = 0; band < 3; band++)
		for (let c = 0; c < 3; c++)
			out[band * 3 + c] =
				(bandSums[band * 3 + c] / Math.max(1, bandCounts[band])) *
				LOOK_LAB_WEIGHTS[c];
	for (let c = 0; c < 3; c++) {
		const mean = sums[c] / rowCount;
		out[9 + c] =
			Math.sqrt(Math.max(0, squares[c] / rowCount - mean * mean)) *
			LOOK_LAB_WEIGHTS[c];
	}
	const byLightness = [...palette.colors]
		.sort((p, q) => p.oklab[0] - q.oklab[0])
		.slice(0, LOOK_PALETTE_SLOTS);
	byLightness.forEach((color, slot) => {
		const o = 12 + slot * 4;
		out[o] = color.oklab[0] * LOOK_LAB_WEIGHTS[0];
		out[o + 1] = color.oklab[1] * LOOK_LAB_WEIGHTS[1];
		out[o + 2] = color.oklab[2] * LOOK_LAB_WEIGHTS[2];
		out[o + 3] = color.share * LOOK_SHARE_WEIGHT;
	});
	return out;
}

/**
 * The palette slots of an embedding (or of a group centroid, which is a mean embedding), un-weighted
 * back to OKLab and sRGB, largest share first. Slots with a negligible share are dropped.
 */
export function paletteFromEmbedding(
	embedding: ArrayLike<number>,
): PaletteColor[] {
	const colors: PaletteColor[] = [];
	for (let slot = 0; slot < LOOK_PALETTE_SLOTS; slot++) {
		const o = 12 + slot * 4;
		const share = embedding[o + 3] / LOOK_SHARE_WEIGHT;
		if (!(share > 0.005)) continue;
		const oklab: Oklab = [
			embedding[o] / LOOK_LAB_WEIGHTS[0],
			embedding[o + 1] / LOOK_LAB_WEIGHTS[1],
			embedding[o + 2] / LOOK_LAB_WEIGHTS[2],
		];
		colors.push({ oklab, rgb: oklabToSrgb8(...oklab), share });
	}
	return colors.sort((p, q) => q.share - p.share);
}
