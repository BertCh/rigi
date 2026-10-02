// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Browser-side foreground (people) segmentation on src/lib/nn: the MediaPipe selfie-multiclass and
// DeepLab v3 networks as WGSL kernels on one luma compute graph per forward (WebGPU), or the nn CPU
// reference backend where there is no WebGPU (see segment/people.ts, scripts/models/mediapipe-seg.py).
//
// segmentForeground() returns a soft 0..255 mask (255 = person, incl. hair,
// clothes and held accessories) at long side MASK_LONG_SIDE, row 0 = top.

import { smoothstep } from "./math";
import { createNn, type Nn } from "./nn";
import type { ByteMask } from "./ontology/core/geometry";
import {
	loadPeopleNet,
	type PeopleModel,
	type PeopleNet,
	runPeopleNet,
} from "./segment/people";

/** 0..255, 255 = foreground person (a ByteMask: row-major, row 0 = TOP of image). */
export type ForegroundMask = ByteMask;

export type SegmentModel = PeopleModel | "combined";

const MASK_LONG_SIDE = 512;

const DEFAULT_MODEL: SegmentModel = "multiclass";

type Loaded = PeopleModel;
let nnPromise: Promise<Nn> | null = null;
const nets = new Map<Loaded, Promise<PeopleNet>>();

/** The shared nn runtime: the page's WebGPU compute device when there is one, else the CPU backend. */
function getNn(): Promise<Nn> {
	nnPromise ??= createNn().catch((err) => {
		console.warn("[segment] GPU nn unavailable, using the CPU backend", err);
		return createNn({ backend: "cpu" });
	});
	return nnPromise;
}

function getNet(model: Loaded): Promise<PeopleNet> {
	let p = nets.get(model);
	if (!p) {
		p = getNn().then((nn) => loadPeopleNet(nn, model));
		// Don't cache failures; allow a retry on the next call.
		p.catch(() => nets.delete(model));
		nets.set(model, p);
	}
	return p;
}

/**
 * Start loading the weights (and the compute device) without an image, so it overlaps the photo decode /
 * region JSON / tiles. Idempotent; never throws.
 */
export function preloadSegmenter(model: SegmentModel = DEFAULT_MODEL): void {
	const models: Loaded[] =
		model === "combined" ? ["multiclass", "deeplab"] : [model];
	for (const m of models) getNet(m).catch(() => {});
}

/** Person probability (0..1) per pixel from one model run, at w x h. */
async function runModel(
	model: Loaded,
	rgba: Uint8ClampedArray,
	w: number,
	h: number,
): Promise<Float32Array> {
	try {
		return await runPeopleNet(await getNet(model), rgba, w, h, w, h);
	} catch (err) {
		if ((await getNn()).backend.kind === "cpu") throw err;
		// a WebGPU failure (device lost, unsupported limit): redo this and every later call on the CPU backend
		console.warn(
			"[segment] GPU forward failed, falling back to the CPU backend",
			err,
		);
		nnPromise = createNn({ backend: "cpu" });
		nets.clear();
		return runPeopleNet(await getNet(model), rgba, w, h, w, h);
	}
}

/** Separable running max (dilation) with a square window of radius r. */
function dilate(
	src: Float32Array,
	w: number,
	h: number,
	r: number,
): Float32Array {
	if (r <= 0) return src;
	const tmp = new Float32Array(src.length);
	const out = new Float32Array(src.length);
	for (let y = 0; y < h; y++) {
		const row = y * w;
		for (let x = 0; x < w; x++) {
			let m = 0;
			const x0 = Math.max(0, x - r);
			const x1 = Math.min(w - 1, x + r);
			for (let k = x0; k <= x1; k++) if (src[row + k] > m) m = src[row + k];
			tmp[row + x] = m;
		}
	}
	for (let x = 0; x < w; x++) {
		for (let y = 0; y < h; y++) {
			let m = 0;
			const y0 = Math.max(0, y - r);
			const y1 = Math.min(h - 1, y + r);
			for (let k = y0; k <= y1; k++) if (tmp[k * w + x] > m) m = tmp[k * w + x];
			out[y * w + x] = m;
		}
	}
	return out;
}

/** Separable box blur of radius r (applied once). */
function boxBlur(
	src: Float32Array,
	w: number,
	h: number,
	r: number,
): Float32Array {
	if (r <= 0) return src;
	const tmp = new Float32Array(src.length);
	const out = new Float32Array(src.length);
	for (let y = 0; y < h; y++) {
		const row = y * w;
		for (let x = 0; x < w; x++) {
			let s = 0;
			let n = 0;
			for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) {
				s += src[row + k];
				n++;
			}
			tmp[row + x] = s / n;
		}
	}
	for (let x = 0; x < w; x++) {
		for (let y = 0; y < h; y++) {
			let s = 0;
			let n = 0;
			for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) {
				s += tmp[k * w + x];
				n++;
			}
			out[y * w + x] = s / n;
		}
	}
	return out;
}

/**
 * Segment people in the foreground of a photo.
 * Returns null (never throws) if the model can't be loaded or run.
 * `model` is exposed for experimentation; the default is the tuned choice.
 */
export async function segmentForeground(
	img: HTMLImageElement | ImageBitmap,
	model: SegmentModel = DEFAULT_MODEL,
): Promise<ForegroundMask | null> {
	try {
		const iw = img instanceof HTMLImageElement ? img.naturalWidth : img.width;
		const ih = img instanceof HTMLImageElement ? img.naturalHeight : img.height;
		if (!iw || !ih) throw new Error("image has no size (not loaded?)");
		const scale = MASK_LONG_SIDE / Math.max(iw, ih);
		const w = Math.max(1, Math.round(iw * scale));
		const h = Math.max(1, Math.round(ih * scale));

		const canvas = document.createElement("canvas");
		canvas.width = w;
		canvas.height = h;
		const ctx = canvas.getContext("2d");
		if (!ctx) throw new Error("no 2d context");
		ctx.drawImage(img, 0, 0, w, h);

		const rgba = ctx.getImageData(0, 0, w, h).data;
		const models: Loaded[] =
			model === "combined" ? ["multiclass", "deeplab"] : [model];
		const probs: Float32Array[] = [];
		for (const m of models) {
			const p = await runModel(m, rgba, w, h);
			if (p.length !== w * h)
				throw new Error(`mask size ${p.length} != ${w}x${h}`);
			probs.push(p);
		}

		let fg: Float32Array = new Float32Array(w * h);
		for (let i = 0; i < fg.length; i++) {
			let p = 0;
			for (const pr of probs) if (pr[i] > p) p = pr[i];
			fg[i] = smoothstep(0.3, 0.6, p);
		}

		fg = dilate(fg, w, h, Math.max(1, Math.round(w * 0.01)));
		fg = boxBlur(fg, w, h, 1);
		fg = boxBlur(fg, w, h, 1);

		const data = new Uint8Array(w * h);
		for (let i = 0; i < data.length; i++) data[i] = Math.round(fg[i] * 255);
		return { width: w, height: h, data };
	} catch (err) {
		console.warn("[segment] segmentForeground failed", err);
		return null;
	}
}
