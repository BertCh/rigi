// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

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
import { getFlag } from "#/lib/flags";
import { gpuEnabled } from "#/lib/gpu/device";
import {
	classicalSky,
	refineToWorking,
	rgbPlanes,
	toBytes,
	workingSize,
} from "./core";
import { createPendingRequests } from "./pending";
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
	/** Where the model input was prepared: "gpu" (ImageBitmap → WGSL), else the CPU chain. */
	prepOn?: "gpu" | "cpu";
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
	/**
	 * Prepare the model input on the GPU (default: ?skyGpuPrep, on): the working-size photo goes to the
	 * worker as an ImageBitmap (no getImageData once the device is verified) and the resample and
	 * normalise run in WGSL, bit-identical to the CPU chain (gpu/sky/prep.ts, sky/prep.ts). Needs the
	 * GPU path (gpuEnabled()) and ORT on WebGPU; otherwise, or on any failure, the CPU prep runs.
	 */
	gpuPrep?: boolean;
}

const DEFAULT_LONG_SIDE = 1024;
/**
 * The GPU prep's default: ?skyGpuPrep (src/lib/flags), on since 2026-10-01. Measured in headless Chrome
 * (Metal, scripts/gpu/sky-prep-ab.mjs): 69/69 photos (19 bundled + 50 wild dev) took the GPU prep, masks
 * byte-identical to the CPU prep, median segmentSky 88.1 → 77.6 ms (the dispatch-chain version; the
 * ComputeGraph port that followed is bit-identical on Dawn in node: scripts/gpu/sky-prep-dawn.ts --graph).
 */
const defaultGpuPrep = () => getFlag("skyGpuPrep") === "on";
/** Photos the worker verifies against the CPU chain per device (sky/prep.ts PREP_VERIFY). */
const PREP_VERIFY = 3;
// what the worker last reported about the GPU prep: while unverified the CPU pixels ride along
let prepVerified = 0;
let prepDisabled = false;
// replies where the worker ran the CPU prep although a bitmap was sent (no shared WebGPU device, WASM
// model, unsupported shape): after PREP_MISSES in a row stop building bitmaps
let prepMisses = 0;
const PREP_MISSES = 3;

let worker: Worker | null | undefined;
// worker crashes: the worker may be re-created later, up to a cap (null = cannot start at all)
let workerErrors = 0;
const MAX_WORKER_ERRORS = 3;
let nextId = 1;
/**
 * No reply for this long while requests are pending means the worker is stuck (a hung ORT run, a GPU
 * process crash without an error event): it is dropped like a crashed one, and every pending request
 * falls back. Measured from the last reply, not per request, because the worker runs requests one at a
 * time. Before the first reply the cold start (worker module, the 28 MB ORT wasm, the 4.5 MB model;
 * ~10 s in the dev server under load, ~33 MB to download on a slow link) gets a generous allowance;
 * afterwards one WASM inference is ~1.5 s and a reload after a device loss a few seconds more.
 */
const STALL_COLD_MS = 180_000;
const STALL_WARM_MS = 60_000;
const pending = createPendingRequests<SkyWorkerResponse>(
	(heard) => (heard ? STALL_WARM_MS : STALL_COLD_MS),
	() => worker && dropWorker(worker, "no reply from the sky worker"),
);

/**
 * Terminate `wk` after an error or a stall; pending requests reject (→ inline fallback). A late event
 * from a worker that was already replaced is ignored, so it can never take down its successor.
 */
function dropWorker(wk: Worker, reason: string) {
	if (wk !== worker) return;
	console.warn("[sky] worker error:", reason);
	pending.rejectAll(new Error(reason));
	worker?.terminate();
	workerErrors++;
	worker = workerErrors < MAX_WORKER_ERRORS ? undefined : null;
	preloadPromise = undefined;
	// a new worker verifies the GPU prep from scratch (prepDisabled stays: a mismatch is the device's)
	prepVerified = 0;
	prepMisses = 0;
}

function getWorker(): Worker | null {
	if (worker !== undefined) return worker;
	try {
		const wk = new Worker(new URL("./sky.worker.ts", import.meta.url), {
			type: "module",
		});
		worker = wk;
		wk.onmessage = (ev: MessageEvent<SkyWorkerResponse>) => {
			if (wk === worker) pending.resolve(ev.data.id, ev.data);
		};
		wk.onerror = (ev) => dropWorker(wk, ev.message);
		wk.onmessageerror = () => dropWorker(wk, "unreadable reply");
	} catch (e) {
		console.warn("[sky] cannot start worker, running fallback inline:", e);
		worker = null;
	}
	return worker;
}

/**
 * Post a request to `wk`. A post that throws (e.g. a detached buffer), or a `wk` that was dropped while
 * the caller awaited (its bitmap, or the first reply before a needPixels resend), rejects at once
 * instead of waiting for a reply that cannot come.
 */
function post(
	wk: Worker,
	req: SkyWorkerRequest,
	transfer: Transferable[] = [],
): Promise<SkyWorkerResponse> {
	return new Promise<SkyWorkerResponse>((resolve, reject) => {
		if (wk !== worker) {
			if ("bitmap" in req) req.bitmap?.close();
			reject(new Error("sky worker was replaced"));
			return;
		}
		pending.add(req.id, resolve, reject);
		try {
			wk.postMessage(req, transfer);
		} catch (e) {
			pending.remove(req.id);
			// not transferred: the bitmap is still ours to close
			if ("bitmap" in req) req.bitmap?.close();
			reject(e);
		}
	});
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
	preloadPromise = post(wk, req).then(
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

const BITMAP_OPTS = {
	premultiplyAlpha: "none",
	colorSpaceConversion: "none",
} as const;

/** The photo at working resolution: its pixels (getImageData) and/or an ImageBitmap of the same raster. */
interface Raster {
	pixels(): Uint8ClampedArray;
	bitmap(): Promise<ImageBitmap>;
}

async function rasterise(img: Source, W: number, H: number): Promise<Raster> {
	if (
		typeof ImageData !== "undefined" &&
		img instanceof ImageData &&
		img.width === W &&
		img.height === H
	) {
		const data = img;
		return {
			pixels: () => new Uint8ClampedArray(data.data),
			bitmap: () => createImageBitmap(data, BITMAP_OPTS),
		};
	}
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
	return {
		pixels: () => ctx.getImageData(0, 0, W, H).data,
		// the canvas raster as is: the bytes getImageData would return (the worker verifies this)
		bitmap: () => createImageBitmap(canvas, BITMAP_OPTS),
	};
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
	const raster = await rasterise(img, W, H);

	const wk = getWorker();
	// the GPU prep also needs the page's gpuEnabled(): the worker shares the compute device only then
	const gpuPrep =
		(opts.gpuPrep ?? defaultGpuPrep()) &&
		!opts.forceFallback &&
		!prepDisabled &&
		prepMisses < PREP_MISSES &&
		typeof createImageBitmap !== "undefined" &&
		gpuEnabled();
	if (wk) {
		const send = async (bitmap: boolean, pixels: boolean) => {
			const id = nextId++;
			const transfer: Transferable[] = [];
			const req: SkySegmentRequest = {
				type: "segment",
				id,
				width: W,
				height: H,
				refine,
				modelLongSide: opts.modelLongSide,
				backend: opts.backend,
				forceFallback: opts.forceFallback,
				gpu: gpuEnabled(),
			};
			if (pixels) {
				req.rgba = raster.pixels().buffer.slice(0) as ArrayBuffer;
				transfer.push(req.rgba);
			}
			if (bitmap) {
				req.bitmap = await raster.bitmap();
				transfer.push(req.bitmap);
			}
			return post(wk, req, transfer);
		};
		try {
			// while the device is unverified the CPU pixels ride along, so the worker can compare
			let res = await send(gpuPrep, !gpuPrep || prepVerified < PREP_VERIFY);
			if (!res.ok && res.needPixels) res = await send(gpuPrep, true);
			if (res.ok && res.type === "segment") {
				if (res.prep) {
					prepVerified = Math.max(prepVerified, res.prep.verified);
					prepDisabled ||= !!res.prep.disabled;
					if (gpuPrep) prepMisses = res.prep.on === "gpu" ? 0 : prepMisses + 1;
				}
				return {
					width: res.width,
					height: res.height,
					data: new Uint8Array(res.data),
					source: res.source,
					backend: res.backend,
					ms: res.ms,
					refineOn: res.refineOn,
					ortDevice: res.ortDevice,
					prepOn: res.prep?.on,
				};
			}
			console.warn(
				"[sky] worker failed, running fallback inline:",
				res.ok ? "unexpected reply" : res.error,
			);
		} catch (e) {
			console.warn("[sky] worker failed, running fallback inline:", e);
		}
	}
	return inlineFallback(raster.pixels(), W, H, refine);
}
