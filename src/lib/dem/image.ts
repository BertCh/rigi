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

// One scratch 2D context per realm, reused while the tile size repeats (every DEM tile is the same
// size); a new size makes a new one. bitmapHeights is synchronous, so there is no overlap.
let scratch: {
	w: number;
	h: number;
	ctx: ReturnType<typeof context2d>;
} | null = null;

function scratchContext(w: number, h: number) {
	if (!scratch || scratch.w !== w || scratch.h !== h || !scratch.ctx)
		scratch = { w, h, ctx: context2d(w, h) };
	return scratch.ctx;
}

/**
 * Whether 2D-canvas readback returns the pixels drawn. Anti-fingerprinting modes (Brave's canvas
 * farbling, Safari's Advanced Fingerprinting Protection, Firefox resistFingerprinting) add noise to
 * getImageData or blank it; a ±1 in Terrarium R is a ±256 m spike, a blank canvas is no data.
 * "unknown" where the probe cannot run (no canvas or ImageData, e.g. Node).
 */
export type CanvasReadback = "exact" | "noised" | "unknown";

let readback: CanvasReadback | null = null;

/** Probe edge: a full 512 px Mapterhorn tile, so sparse noise has as many pixels to land on. */
const PROBE_SIZE = 512;

/** The probe's verdict in this realm (runs it on first use; see probeCanvasReadback). */
export const canvasReadback = (): CanvasReadback => probeCanvasReadback();

/** The probe image: w × w opaque pixels covering every R, G and B byte value. */
export function readbackProbePattern(
	w = PROBE_SIZE,
): Uint8ClampedArray<ArrayBuffer> {
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
 * Once per realm, synchronously (so every decode, including the GPU ingest's lazy CPU heights, sees
 * the verdict): put a known image on a 2D canvas and compare getImageData, where the noise is
 * applied. A failure to run gives "unknown" (decode unchanged).
 */
export function probeCanvasReadback(): CanvasReadback {
	if (readback) return readback;
	readback = "unknown";
	try {
		const w = PROBE_SIZE;
		const px = readbackProbePattern(w);
		const ctx = scratchContext(w, w); // the size of every Mapterhorn tile, so decode reuses it
		if (!ctx) return readback;
		ctx.putImageData(new ImageData(px, w, w), 0, 0);
		const bad = countReadbackMismatches(px, ctx.getImageData(0, 0, w, w).data);
		readback = bad ? "noised" : "exact";
		if (bad)
			console.warn(
				`dem: canvas readback is altered (${bad} of ${px.length} bytes; anti-fingerprinting?): DEM tiles get the 256 m seam repair, heights may still be off by a few metres`,
			);
	} catch {
		// no ImageData / canvas in this realm: leave "unknown"
	}
	return readback;
}

/**
 * Heights of a decoded Terrarium image (OffscreenCanvas, or a <canvas> where there is none). When the
 * readback probe found noise, the tile also gets validateTile's 256 m seam repair (an R-channel ±1
 * becomes a one-pixel component shifted back by 256 m); with an exact or unknown readback the
 * heights are decodeTerrarium's, bit for bit. Throws when the readback is not w × h pixels.
 */
export function bitmapHeights(bmp: ImageBitmap) {
	const noised = probeCanvasReadback() === "noised";
	const ctx = scratchContext(bmp.width, bmp.height);
	if (!ctx) throw new Error("2D canvas unavailable for DEM decode");
	ctx.clearRect(0, 0, bmp.width, bmp.height); // a reused canvas must start transparent, like a new one
	ctx.drawImage(bmp, 0, 0);
	const data = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
	// invariant: one RGBA pixel per tile pixel (a blocked readback can come back empty)
	if (data.length !== bmp.width * bmp.height * 4)
		throw new Error("DEM decode: canvas readback has the wrong size");
	const h = decodeTerrarium(data);
	if (noised && bmp.width === bmp.height) validateTile(h, bmp.width);
	return h;
}

/** Heights of an encoded Terrarium tile (PNG / WebP bytes). */
export async function blobHeights(blob: Blob) {
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
