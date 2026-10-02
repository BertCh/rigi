// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Photo look: palette + embedding of one photo. photoLook picks the GPU path when a compute device
// exists (and ?gpu is not off), else the CPU twin; any GPU failure falls back to the CPU twin.
import { getComputeDevice } from "../device";
import { photoLookEmbedding } from "./look-embedding";
import {
	type PaletteOptions,
	type PhotoPalette,
	type PhotoPixels,
	photoPaletteCpu,
	photoPaletteGpu,
} from "./palette";

export * from "./kmeans-cpu";
export * from "./look-embedding";
export * from "./oklab";
export * from "./palette";

export type PhotoLook = {
	palette: PhotoPalette;
	embedding: Float32Array;
	backend: "gpu" | "cpu";
};

/** The look of an RGBA8 image (about 64 x 64 after downscaling). */
export async function photoLook(
	pixels: PhotoPixels,
	options: PaletteOptions = {},
): Promise<PhotoLook> {
	const device = await getComputeDevice().catch(() => null);
	if (device) {
		try {
			const palette = await photoPaletteGpu(device, pixels, options);
			return {
				palette,
				embedding: photoLookEmbedding(pixels, palette),
				backend: "gpu",
			};
		} catch {
			// device lost or kernel failure: the CPU twin answers
		}
	}
	const palette = photoPaletteCpu(pixels, options);
	return {
		palette,
		embedding: photoLookEmbedding(pixels, palette),
		backend: "cpu",
	};
}

/** Side of the square the photo is shrunk to before reading its colours. */
export const LOOK_SAMPLE_SIZE = 64;

const lookCache = new Map<string, Promise<PhotoLook>>();

/** Decode `url` at LOOK_SAMPLE_SIZE x LOOK_SAMPLE_SIZE (aspect ignored: a colour sample, not a picture). */
export async function decodeLookPixels(url: string): Promise<PhotoPixels> {
	const size = LOOK_SAMPLE_SIZE;
	const response = await fetch(url);
	if (!response.ok) throw new Error(`photo look: ${response.status} ${url}`);
	const blob = await response.blob();
	if (typeof createImageBitmap === "function") {
		const bitmap = await createImageBitmap(blob, {
			resizeWidth: size,
			resizeHeight: size,
			resizeQuality: "medium",
		});
		try {
			const canvas =
				typeof OffscreenCanvas !== "undefined"
					? new OffscreenCanvas(size, size)
					: Object.assign(document.createElement("canvas"), {
							width: size,
							height: size,
						});
			const context = canvas.getContext("2d") as
				| OffscreenCanvasRenderingContext2D
				| CanvasRenderingContext2D
				| null;
			if (!context) throw new Error("photo look: no 2d context");
			context.drawImage(bitmap, 0, 0, size, size);
			const { data } = context.getImageData(0, 0, size, size);
			return { width: size, height: size, data };
		} finally {
			bitmap.close();
		}
	}
	throw new Error("photo look: createImageBitmap is not available");
}

/** photoLook of an image URL, decoded once and cached (failures are not cached). */
export function photoLookFromUrl(url: string): Promise<PhotoLook> {
	let cached = lookCache.get(url);
	if (!cached) {
		cached = decodeLookPixels(url).then((pixels) => photoLook(pixels));
		cached.catch(() => lookCache.delete(url));
		lookCache.set(url, cached);
	}
	return cached;
}
