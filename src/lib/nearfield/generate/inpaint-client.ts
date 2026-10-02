// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Client for the near-field service's POST /inpaint (LaMa big-lama, Apache-2.0; tools/nearfield/service/inpaint.py).
// Browser only (PNG encode / decode through a canvas). Like ../client.ts it never throws: null on any failure.
import { decodeDepthWire, nearField } from "../client";
import type { NearFieldDepth, NearFieldDepthWire } from "../types";

export type InpaintMeta = {
	width: number;
	height: number;
	holeFrac: number;
	procWidth: number;
	procHeight: number;
	inferSeconds: number;
	device: string | null;
	seconds: number;
	licence: string;
	[k: string]: unknown;
};

export type InpaintResult = {
	/** sRGB RGBA, same size as the input; only hole pixels differ (composite). */
	rgba: Uint8ClampedArray;
	meta: InpaintMeta;
	/** Round trip (ms), including PNG encode / decode. */
	ms: number;
};

type Canvas2D = OffscreenCanvas | HTMLCanvasElement;

function canvas(w: number, h: number): Canvas2D {
	return typeof OffscreenCanvas !== "undefined"
		? new OffscreenCanvas(w, h)
		: Object.assign(document.createElement("canvas"), { width: w, height: h });
}

async function toPng(c: Canvas2D): Promise<Blob> {
	if ("convertToBlob" in c) return c.convertToBlob({ type: "image/png" });
	return new Promise((res, rej) =>
		(c as HTMLCanvasElement).toBlob(
			(b) => (b ? res(b) : rej(new Error("toBlob failed"))),
			"image/png",
		),
	);
}

/** RGBA (row 0 = top) → PNG blob. */
export async function rgbaToPng(
	rgba: ArrayLike<number>,
	w: number,
	h: number,
): Promise<Blob> {
	const c = canvas(w, h);
	const ctx = c.getContext("2d") as
		| CanvasRenderingContext2D
		| OffscreenCanvasRenderingContext2D;
	const id = ctx.createImageData(w, h);
	id.data.set(rgba as ArrayLike<number>);
	ctx.putImageData(id, 0, 0);
	return toPng(c);
}

/** 0/1 mask (row 0 = top) → greyscale PNG (255 = hole). */
function maskToPng(mask: Uint8Array, w: number, h: number): Promise<Blob> {
	const rgba = new Uint8ClampedArray(4 * w * h);
	for (let k = 0; k < w * h; k++) {
		const v = mask[k] ? 255 : 0;
		rgba[4 * k] = v;
		rgba[4 * k + 1] = v;
		rgba[4 * k + 2] = v;
		rgba[4 * k + 3] = 255;
	}
	return rgbaToPng(rgba, w, h);
}

/** Decode an image blob to RGBA at its own size. */
async function blobToRgba(
	b: Blob,
): Promise<{ width: number; height: number; data: Uint8ClampedArray }> {
	const bmp = await createImageBitmap(b, {
		colorSpaceConversion: "none",
		premultiplyAlpha: "none",
	});
	const c = canvas(bmp.width, bmp.height);
	const ctx = c.getContext("2d") as
		| CanvasRenderingContext2D
		| OffscreenCanvasRenderingContext2D;
	ctx.drawImage(bmp, 0, 0);
	const d = ctx.getImageData(0, 0, bmp.width, bmp.height);
	bmp.close();
	return { width: d.width, height: d.height, data: d.data };
}

/**
 * Fill the holes of an RGBA view with LaMa. `hole` 1 = fill. `dilate` (px) grows the hole on the service
 * side (0 here: the caller's hole mask is already dilated). null when the service is down, has no LaMa, or
 * errors.
 */
export async function inpaint(
	rgba: ArrayLike<number>,
	hole: Uint8Array,
	w: number,
	h: number,
	opts: {
		maxSide?: number;
		dilate?: number;
		signal?: AbortSignal;
		timeoutMs?: number;
	} = {},
): Promise<InpaintResult | null> {
	const t0 = performance.now();
	try {
		const fd = new FormData();
		fd.append("image", await rgbaToPng(rgba, w, h), "view.png");
		fd.append("mask", await maskToPng(hole, w, h), "mask.png");
		if (opts.maxSide) fd.append("maxSide", String(opts.maxSide));
		if (opts.dilate) fd.append("dilate", String(opts.dilate));
		// the shared transport: health gate, linked abort signal, timeout that also covers the body
		const r = await nearField.post("/inpaint", fd, opts, 120_000);
		if (!r) return null;
		let meta = {} as InpaintMeta;
		try {
			meta = JSON.parse(r.headers.get("X-NearField-Meta") ?? "{}");
		} catch {
			/* keep {} */
		}
		const img = await blobToRgba(await r.blob());
		if (img.width !== w || img.height !== h) {
			console.warn("[nearfield] /inpaint size mismatch", img.width, img.height);
			return null;
		}
		return { rgba: img.data, meta, ms: performance.now() - t0 };
	} catch (e) {
		console.warn("[nearfield] /inpaint failed", e);
		return null;
	}
}

/**
 * POST /depth for a rendered view with its KNOWN horizontal FOV (the service's fovX field; ../client.ts
 * depth() does not expose it). MoGe-2 only. null on any failure.
 */
export async function depthWithFov(
	image: Blob,
	fovXDeg: number,
	opts: {
		model?: "moge2" | "moge2b";
		maxSide?: number;
		timeoutMs?: number;
	} = {},
): Promise<NearFieldDepth | null> {
	const fd = new FormData();
	fd.append("image", image, "view.png");
	fd.append("model", opts.model ?? "moge2");
	fd.append("fovX", fovXDeg.toFixed(4));
	if (opts.maxSide) fd.append("maxSide", String(opts.maxSide));
	const r = await nearField.post("/depth", fd, opts, 120_000);
	if (!r) return null;
	try {
		return decodeDepthWire((await r.json()) as NearFieldDepthWire);
	} catch {
		return null;
	}
}
