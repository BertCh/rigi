/**
 * Browser sky segmentation: P(sky) per pixel for a photo.
 *
 *   const mask = await segmentSky(img);          // 1024 px long side, refined
 *   const { rows, weight } = skylineFromSky(mask); // per-column skyline
 *
 * The U²-Net sky model (see README.md) is loaded lazily in a module Web
 * Worker (WebGPU if available, else WASM) and refined with a fast colour
 * guided filter using the photo as guide. If the model or worker is
 * unavailable, a classical colour/texture + Viterbi segmenter is used, so the
 * call always resolves with a mask.
 */
import { gpuEnabled } from "#/lib/gpu/device";
import {
	classicalSky,
	refineToWorking,
	rgbPlanes,
	toBytes,
	workingSize,
} from "./core";
import type {
	SkySegmentRequest,
	SkyWorkerRequest,
	SkyWorkerResponse,
} from "./protocol";

export type { SkylineDPOptions, SkylineFromSkyOptions } from "./skyline";
export { skylineFromSky, skylineFromSkyDP } from "./skyline";

export type SkyMask = {
	width: number;
	height: number;
	/** P(sky)*255, row-major, row 0 = TOP. */
	data: Uint8Array;
	/** Which path produced the mask. */
	source?: "model" | "fallback";
	backend?: "webgpu" | "wasm";
	/** Timings in ms (worker-side). */
	ms?: { load: number; infer: number; refine: number };
	/** Where the guided-filter refine ran (GPU unless ?gpu=off, no WebGPU, or a GPU error). */
	refineOn?: "gpu" | "cpu";
	/** ORT WebGPU EP on the shared compute device, or its own; absent on WASM / fallback. */
	ortDevice?: "shared" | "own";
};

export interface SegmentSkyOptions {
	/** Working (output) long side, px. Default 1024; clamped to ≥ 512 unless the photo is smaller. */
	longSide?: number;
	/** Guided-filter refinement against the photo (default true). */
	refine?: boolean;
	/** Model input long side (default 512, rounded to multiples of 32). */
	modelLongSide?: number;
	/** Restrict the ONNX Runtime backend (default: WebGPU if available, else WASM). */
	backend?: "webgpu" | "wasm";
	/** Skip the model and use the classical segmenter. */
	forceFallback?: boolean;
}

const DEFAULT_LONG_SIDE = 1024;

let worker: Worker | null | undefined;
// worker crashes: the worker may be re-created later, up to a cap (null = cannot start at all)
let workerErrors = 0;
const MAX_WORKER_ERRORS = 3;
let nextId = 1;
const pending = new Map<
	number,
	{ resolve: (r: SkyWorkerResponse) => void; reject: (e: unknown) => void }
>();

function getWorker(): Worker | null {
	if (worker !== undefined) return worker;
	try {
		worker = new Worker(new URL("./sky.worker.ts", import.meta.url), {
			type: "module",
		});
		worker.onmessage = (ev: MessageEvent<SkyWorkerResponse>) => {
			const p = pending.get(ev.data.id);
			if (!p) return;
			pending.delete(ev.data.id);
			p.resolve(ev.data);
		};
		worker.onerror = (ev) => {
			console.warn("[sky] worker error:", ev.message);
			for (const p of pending.values()) p.reject(new Error(ev.message));
			pending.clear();
			worker?.terminate();
			workerErrors++;
			worker = workerErrors < MAX_WORKER_ERRORS ? undefined : null;
			preloadPromise = undefined;
		};
	} catch (e) {
		console.warn("[sky] cannot start worker, running fallback inline:", e);
		worker = null;
	}
	return worker;
}

let preloadPromise: Promise<{ backend: "webgpu" | "wasm" | null }> | undefined;

/**
 * Starts the worker and, inside it, the ONNX Runtime wasm + model download and
 * session creation. Returns immediately (nothing heavy runs on the calling
 * thread); the promise resolves once the model is ready, with the backend in
 * use, or `null` when it failed and segmentSky() will use the classical
 * fallback. It never rejects, so it's safe to fire and forget, e.g. alongside
 * terrain loading:
 *
 *     void preloadSkyModel();
 *     const terrain = await loadTerrain(...);
 *     const mask = await segmentSky(img); // model already warm
 *
 * Idempotent: repeated calls share one load, and segmentSky() reuses it.
 */
export function preloadSkyModel(
	opts: { backend?: "webgpu" | "wasm" } = {},
): Promise<{ backend: "webgpu" | "wasm" | null }> {
	if (preloadPromise) return preloadPromise;
	const wk = getWorker();
	if (!wk) {
		preloadPromise = Promise.resolve({ backend: null });
		return preloadPromise;
	}
	const id = nextId++;
	const req: SkyWorkerRequest = {
		type: "preload",
		id,
		backend: opts.backend,
		gpu: gpuEnabled(),
	};
	preloadPromise = new Promise<SkyWorkerResponse>((resolve, reject) => {
		pending.set(id, { resolve, reject });
		wk.postMessage(req);
	}).then(
		(res) =>
			res.ok && res.type === "preload"
				? { backend: res.backend }
				: { backend: null },
		() => ({ backend: null }),
	);
	const mine = preloadPromise;
	// a failed preload is not final: the next call may retry (the worker backs off itself)
	void mine.then((r) => {
		if (!r.backend && preloadPromise === mine) preloadPromise = undefined;
	});
	return mine;
}

type Source = HTMLImageElement | ImageBitmap | ImageData;

function sourceSize(img: Source) {
	if (
		typeof HTMLImageElement !== "undefined" &&
		img instanceof HTMLImageElement
	)
		return {
			w: img.naturalWidth || img.width,
			h: img.naturalHeight || img.height,
		};
	return { w: img.width, h: img.height };
}

/** Pixels at working resolution. */
async function rasterise(
	img: Source,
	W: number,
	H: number,
): Promise<Uint8ClampedArray> {
	if (
		typeof ImageData !== "undefined" &&
		img instanceof ImageData &&
		img.width === W &&
		img.height === H
	)
		return new Uint8ClampedArray(img.data);
	let src: CanvasImageSource = img as CanvasImageSource;
	if (typeof ImageData !== "undefined" && img instanceof ImageData)
		src = await createImageBitmap(img);
	const canvas =
		typeof OffscreenCanvas !== "undefined"
			? new OffscreenCanvas(W, H)
			: Object.assign(document.createElement("canvas"), {
					width: W,
					height: H,
				});
	const ctx = canvas.getContext("2d", { willReadFrequently: true }) as
		| CanvasRenderingContext2D
		| OffscreenCanvasRenderingContext2D
		| null;
	if (!ctx) throw new Error("2D canvas unavailable");
	ctx.imageSmoothingEnabled = true;
	ctx.imageSmoothingQuality = "high";
	ctx.drawImage(src, 0, 0, W, H);
	if (src !== img && "close" in src) (src as ImageBitmap).close();
	return ctx.getImageData(0, 0, W, H).data;
}

function inlineFallback(
	rgba: Uint8ClampedArray,
	W: number,
	H: number,
	refine: boolean,
): SkyMask {
	const t0 = performance.now();
	const rgb = rgbPlanes({ width: W, height: H, data: rgba });
	const low = classicalSky(rgb, W, H);
	const t1 = performance.now();
	const data = toBytes(refineToWorking(rgb, W, H, low, refine));
	return {
		width: W,
		height: H,
		data,
		source: "fallback",
		ms: { load: 0, infer: t1 - t0, refine: performance.now() - t1 },
		refineOn: "cpu",
	};
}

// Same image + options while a request is in flight → share its promise
// (e.g. React StrictMode mounting twice).
const inflight = new WeakMap<object, Map<string, Promise<SkyMask>>>();

export function segmentSky(
	img: Source,
	opts: SegmentSkyOptions = {},
): Promise<SkyMask> {
	const key = JSON.stringify(opts);
	let perImg = inflight.get(img as object);
	const hit = perImg?.get(key);
	if (hit) return hit;
	if (!perImg) {
		perImg = new Map();
		inflight.set(img as object, perImg);
	}
	const p = segmentSkyUncached(img, opts).finally(() => perImg?.delete(key));
	perImg.set(key, p);
	return p;
}

async function segmentSkyUncached(
	img: Source,
	opts: SegmentSkyOptions,
): Promise<SkyMask> {
	const { w, h } = sourceSize(img);
	if (!w || !h) throw new Error("segmentSky: image has no size (not loaded?)");
	const longSide = Math.max(
		Math.min(512, Math.max(w, h)),
		opts.longSide ?? DEFAULT_LONG_SIDE,
	);
	const { width: W, height: H } = workingSize(w, h, longSide);
	const refine = opts.refine ?? true;
	const rgba = await rasterise(img, W, H);

	const wk = getWorker();
	if (wk) {
		const id = nextId++;
		const req: SkySegmentRequest = {
			type: "segment",
			id,
			width: W,
			height: H,
			rgba: rgba.buffer.slice(0) as ArrayBuffer,
			refine,
			modelLongSide: opts.modelLongSide,
			backend: opts.backend,
			forceFallback: opts.forceFallback,
			gpu: gpuEnabled(),
		};
		try {
			const res = await new Promise<SkyWorkerResponse>((resolve, reject) => {
				pending.set(id, { resolve, reject });
				wk.postMessage(req, [req.rgba]);
			});
			if (res.ok && res.type === "segment")
				return {
					width: res.width,
					height: res.height,
					data: new Uint8Array(res.data),
					source: res.source,
					backend: res.backend,
					ms: res.ms,
					refineOn: res.refineOn,
					ortDevice: res.ortDevice,
				};
			console.warn(
				"[sky] worker failed, running fallback inline:",
				res.ok ? "unexpected reply" : res.error,
			);
		} catch (e) {
			console.warn("[sky] worker failed, running fallback inline:", e);
		}
	}
	return inlineFallback(rgba, W, H, refine);
}
