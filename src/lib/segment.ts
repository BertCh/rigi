// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Browser-side foreground (people) segmentation using MediaPipe ImageSegmenter.
//
// segmentForeground() returns a soft 0..255 mask (255 = person, incl. hair,
// clothes and held accessories) at long side MASK_LONG_SIDE, row 0 = top.

import {
	FilesetResolver,
	ImageSegmenter,
	type ImageSegmenterResult,
} from "@mediapipe/tasks-vision";
import { cachedFetchBuffer } from "./cache";
import { smoothstep } from "./math";
import type { ByteMask } from "./ontology/core/geometry";

/** 0..255, 255 = foreground person (a ByteMask: row-major, row 0 = TOP of image). */
export type ForegroundMask = ByteMask;

export type SegmentModel = "multiclass" | "deeplab" | "combined";

const MASK_LONG_SIDE = 512;
// Must match the installed (exact-pinned) @mediapipe/tasks-vision version in package.json.
const TASKS_VISION_VERSION = "1.0.1";
const WASM_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VISION_VERSION}/wasm`;
const MODEL_URLS: Record<"multiclass" | "deeplab", string> = {
	multiclass:
		"https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite",
	deeplab:
		"https://storage.googleapis.com/mediapipe-models/image_segmenter/deeplab_v3/float32/latest/deeplab_v3.tflite",
};
/** Pascal VOC "person" class index in deeplab_v3. */
const DEEPLAB_PERSON = 15;

const DEFAULT_MODEL: SegmentModel = "multiclass";

type Loaded = "multiclass" | "deeplab";
const segmenters = new Map<Loaded, Promise<ImageSegmenter>>();

/**
 * createFromOptions loads the wasm loader script and then the .wasm only once the model buffer is in:
 * preload both as soon as their URLs are known so the three downloads run side by side. The link
 * attributes match what MediaPipe requests (script crossOrigin=anonymous; emscripten's cors fetch),
 * so the browser reuses the preloaded responses.
 */
let wasmPreloaded = false;
function preloadWasm(fileset: {
	wasmLoaderPath: string;
	wasmBinaryPath: string;
}) {
	if (wasmPreloaded || typeof document === "undefined") return;
	wasmPreloaded = true;
	for (const [href, as] of [
		[fileset.wasmLoaderPath, "script"],
		[fileset.wasmBinaryPath, "fetch"],
	]) {
		const link = document.createElement("link");
		link.rel = "preload";
		link.as = as;
		link.href = href;
		link.crossOrigin = "anonymous";
		document.head.appendChild(link);
	}
}

async function createSegmenter(model: Loaded): Promise<ImageSegmenter> {
	const [fileset, buf] = await Promise.all([
		FilesetResolver.forVisionTasks(WASM_BASE).then((f) => {
			preloadWasm(f);
			return f;
		}),
		// 16 MB model: keep it in the persistent cache (GCS sends max-age=3600, and it is too big for
		// many HTTP caches). Priority -1 = ahead of DEM tiles in the shared queue. Any failure → the URL.
		cachedFetchBuffer(MODEL_URLS[model], { priority: -1 }).catch(() => null),
	]);
	const make = (delegate: "GPU" | "CPU") =>
		ImageSegmenter.createFromOptions(fileset, {
			baseOptions: buf
				? { modelAssetBuffer: new Uint8Array(buf), delegate }
				: { modelAssetPath: MODEL_URLS[model], delegate },
			runningMode: "IMAGE",
			outputConfidenceMasks: true,
			outputCategoryMask: false,
		});
	try {
		return await make("GPU");
	} catch (err) {
		console.warn(
			`[segment] GPU delegate failed for ${model}, falling back to CPU`,
			err,
		);
		return make("CPU");
	}
}

function getSegmenter(model: Loaded): Promise<ImageSegmenter> {
	let p = segmenters.get(model);
	if (!p) {
		p = createSegmenter(model);
		// Don't cache failures; allow a retry on the next call.
		p.catch(() => segmenters.delete(model));
		segmenters.set(model, p);
	}
	return p;
}

/**
 * Start loading the wasm runtime + model (and GPU delegate init) without an image, so it overlaps
 * the photo decode / region JSON / tiles. Idempotent; never throws.
 */
export function preloadSegmenter(model: SegmentModel = DEFAULT_MODEL): void {
	const models: Loaded[] =
		model === "combined" ? ["multiclass", "deeplab"] : [model];
	for (const m of models) getSegmenter(m).catch(() => {});
}

/** Person probability (0..1) per pixel from one model run. */
function runModel(
	seg: ImageSegmenter,
	model: Loaded,
	src: HTMLCanvasElement,
): Float32Array {
	const result: ImageSegmenterResult = seg.segment(src);
	try {
		const masks = result.confidenceMasks;
		if (!masks || masks.length === 0) throw new Error("no confidence masks");
		if (model === "multiclass") {
			// class 0 = background; everything else (hair, skin, clothes, others) = person
			const bg = masks[0].getAsFloat32Array();
			const out = new Float32Array(bg.length);
			for (let i = 0; i < bg.length; i++) out[i] = 1 - bg[i];
			return out;
		}
		return Float32Array.from(masks[DEEPLAB_PERSON].getAsFloat32Array());
	} finally {
		result.close();
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

		const models: Loaded[] =
			model === "combined" ? ["multiclass", "deeplab"] : [model];
		const probs: Float32Array[] = [];
		for (const m of models) {
			const seg = await getSegmenter(m);
			const p = runModel(seg, m, canvas);
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
