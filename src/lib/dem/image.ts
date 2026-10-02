// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Terrarium image → heights with createImageBitmap + a 2D canvas: the page (load.ts), the decode pool
// (decode.worker.ts) and the horizon workers all decode through here.
import { decodeTerrarium, validateTile } from "./decode";

function context2d(w: number, h: number) {
	if (typeof OffscreenCanvas !== "undefined")
		return new OffscreenCanvas(w, h).getContext("2d", {
			willReadFrequently: true,
		}) as OffscreenCanvasRenderingContext2D | null;
	const c = document.createElement("canvas");
	c.width = w;
	c.height = h;
	return c.getContext("2d", { willReadFrequently: true });
}

/**
 * Whether 2D-canvas readback returns the pixels drawn. Anti-fingerprinting modes (Brave's canvas
 * farbling, Safari's Advanced Fingerprinting Protection, Firefox resistFingerprinting) add noise to
 * getImageData or blank it; a ±1 in Terrarium R is a ±256 m spike, a blank canvas is no data.
 * "unknown" until probeCanvasReadback() has run, and where it cannot (no canvas, Node).
 */
export type CanvasReadback = "exact" | "noised" | "unknown";

let readback: CanvasReadback = "unknown";
let probe: Promise<CanvasReadback> | null = null;

/** The probe's verdict so far (see CanvasReadback). */
export const canvasReadback = (): CanvasReadback => readback;

/** The probe image: w × w opaque pixels covering every R, G and B byte value. */
export function readbackProbePattern(w = 64): Uint8ClampedArray<ArrayBuffer> {
	const px = new Uint8ClampedArray(w * w * 4);
	for (let i = 0; i < w * w; i++) {
		px[i * 4] = i & 255;
		px[i * 4 + 1] = (i * 7 + 3) & 255;
		px[i * 4 + 2] = (i * 13 + 5) & 255;
		px[i * 4 + 3] = 255;
	}
	return px;
}

/** Bytes that differ between what was drawn and what came back (a length mismatch counts all). */
export function countReadbackMismatches(
	drawn: ArrayLike<number>,
	read: ArrayLike<number>,
): number {
	if (drawn.length !== read.length) return Math.max(drawn.length, read.length);
	let n = 0;
	for (let i = 0; i < drawn.length; i++) if (drawn[i] !== read[i]) n++;
	return n;
}

/**
 * Once per realm: draw a known image through the same createImageBitmap + 2D canvas path the decode
 * uses and compare the readback. A failure to run leaves "unknown" (decode unchanged).
 */
export function probeCanvasReadback(): Promise<CanvasReadback> {
	probe ??= (async () => {
		try {
			const w = 64;
			const px = readbackProbePattern(w);
			const bmp = await createImageBitmap(new ImageData(px, w, w), {
				colorSpaceConversion: "none",
				premultiplyAlpha: "none",
			});
			try {
				const ctx = context2d(w, w);
				if (!ctx) return readback;
				ctx.drawImage(bmp, 0, 0);
				const bad = countReadbackMismatches(
					px,
					ctx.getImageData(0, 0, w, w).data,
				);
				readback = bad ? "noised" : "exact";
				if (bad)
					console.warn(
						`dem: canvas readback is altered (${bad} of ${px.length} bytes; anti-fingerprinting?): DEM tiles get the 256 m seam repair, heights may still be off by a few metres`,
					);
			} finally {
				bmp.close();
			}
		} catch {
			// no ImageData / createImageBitmap / canvas in this realm: leave "unknown"
		}
		return readback;
	})();
	return probe;
}

/**
 * Heights of a decoded Terrarium image (OffscreenCanvas, or a <canvas> where there is none). When the
 * readback probe found noise, the tile also gets validateTile's 256 m seam repair (an R-channel ±1
 * becomes a one-pixel component shifted back by 256 m); with an exact or unknown readback the
 * heights are decodeTerrarium's, bit for bit.
 */
export function bitmapHeights(bmp: ImageBitmap) {
	const ctx = context2d(bmp.width, bmp.height);
	if (!ctx) throw new Error("2D canvas unavailable for DEM decode");
	ctx.drawImage(bmp, 0, 0);
	const h = decodeTerrarium(ctx.getImageData(0, 0, bmp.width, bmp.height).data);
	if (readback === "noised" && bmp.width === bmp.height)
		validateTile(h, bmp.width);
	return h;
}

/** Heights of an encoded Terrarium tile (PNG / WebP bytes); runs the readback probe first. */
export async function blobHeights(blob: Blob) {
	await probeCanvasReadback();
	const bmp = await createImageBitmap(blob, {
		colorSpaceConversion: "none",
		premultiplyAlpha: "none",
	});
	try {
		return bitmapHeights(bmp);
	} finally {
		bmp.close();
	}
}
