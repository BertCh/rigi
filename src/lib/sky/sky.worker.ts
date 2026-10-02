// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/// <reference lib="webworker" />
/**
 * Sky segmentation worker: lazily loads the U²-Net-P sky model (src/lib/nn: WGSL kernels on WebGPU, the
 * CPU reference backend otherwise), runs it, refines with the fast guided filter, and falls back to the
 * classical segmenter if the model can't be loaded or run.
 *
 * GPU (when the page's gpuEnabled() says so, sent as `gpu`): the worker's luma compute device runs the
 * model (one ComputeGraph per forward), the GPU prep and the refine, so the photo, the model input and
 * the model output stay on the GPU; only the final byte mask is read back. The CPU refine is the
 * reference and the fallback: no WebGPU, ?gpu=off, or any GPU error. The weights (fp16 safetensors,
 * scripts/models/u2netp.py) are fetched through src/lib/models (Cache Storage, content-hashed name).
 */

import type { Device } from "@luma.gl/core";
import { getComputeDevice } from "#/lib/gpu/device";
import { releasePrepGraphs, type SkyPrepGpu } from "#/lib/gpu/sky/prep";
import { refineSkyGpu, warmSkyKernels } from "#/lib/gpu/sky/refine";
import {
	classicalSky,
	type ModelRun,
	modelSize,
	refineToWorking,
	resamplePlanes,
	rgbPlanes,
	toBytes,
} from "./core";
import { createIdleRelease } from "./graph-idle";
import {
	type Backend,
	createSkyModel,
	inferSkyModel,
	inferSkyModelGpu,
	MODEL_LONG_SIDE,
	type SkyInference,
	type SkyModel,
} from "./model";
import { NeedPixels, prepareGpu, prepStatus } from "./prep";
import type {
	SkyPreloadRequest,
	SkySegmentRequest,
	SkyWorkerRequest,
	SkyWorkerResponse,
} from "./protocol";
import { createSerialQueue } from "./serial-queue";
import { isDeviceLossError } from "./session-recovery";

const queue = createSerialQueue();
// one model per backend; a webgpu model is tied to the compute device it was created on
const models = new Map<string, Promise<SkyModel | null>>();
let modelError: string | undefined;
// A failed load is not cached for good: retry after a growing backoff, up to a cap.
const failures = new Map<string, { n: number; at: number }>();
const MAX_LOAD_ATTEMPTS = 4;
const LOAD_BACKOFF_MS = 2000;

const warmed = new WeakSet<Device>();
let lastDevice: Device | undefined;
// devices the GPU refine ran on since the last device loss: the idle release frees
// their cached refine graphs
const refineDevices = new Set<Device>();

// The prep and refine graphs are cached per shape; free them after this long without a request (the
// device itself stays: the model runs on it). A later request rebuilds the same graphs.
const SKY_GRAPH_IDLE_MS = 30_000;
const idle = createIdleRelease(SKY_GRAPH_IDLE_MS, () =>
	// on the request queue: a request that arrives while the imports below are awaited runs after
	// the release, never on graphs it is destroying; a request already queued runs first (skip)
	queue.run(async () => {
		if (queue.size > 1) return;
		const device = lastDevice;
		const refineOn = new Set(refineDevices);
		if (device) refineOn.add(device);
		if (!refineOn.size) return;
		// refine-graph is loaded on demand by refine.ts (import cycle); the cache is empty if it never was
		const { releaseSkyGraphs } = await import("#/lib/gpu/sky/refine-graph");
		await Promise.all([
			device && releasePrepGraphs(device),
			...[...refineOn].map((d) => releaseSkyGraphs(d)),
		]);
	}),
);

/**
 * After a GPU device loss the webgpu models and graph bookkeeping of the dead device are dropped; nothing
 * is pinned to the CPU: the next request resolves the compute device again (getComputeDevice() returns a
 * fresh one) and builds the webgpu model on it (loadModel frees a model of another device).
 */
function noteFailure(e: unknown) {
	if (!isDeviceLossError(e)) return;
	console.warn("[sky] GPU device lost: dropping the webgpu model and graphs");
	for (const [key, p] of [...models]) {
		if (key === "cpu") continue; // the CPU model does not live on the device
		models.delete(key);
		void p.then((m) => m?.dispose()).catch(() => {});
	}
	failures.clear();
	lastDevice = undefined;
	refineDevices.clear();
}

/** The worker's luma compute device when the page allows the GPU (null: CPU refine). */
async function computeDevice(gpu: boolean | undefined): Promise<Device | null> {
	if (!gpu) return null;
	const device = await getComputeDevice();
	if (device) lastDevice = device;
	if (device && !warmed.has(device)) {
		warmed.add(device);
		void warmSkyKernels(device);
	}
	return device;
}

/**
 * The model for `backend` (default: webgpu on `device`, else cpu). A cached webgpu model is only reused
 * on the device it was created on (the compute device is recreated after an idle release or a loss).
 */
function loadModel(
	backend?: Backend,
	device?: Device | null,
): Promise<SkyModel | null> {
	const key = backend ?? "auto";
	let p = models.get(key);
	if (p) {
		// a model of another device is stale: free it and build a fresh one
		const cached = p;
		void cached.then((m) => {
			if (
				m?.backend === "webgpu" &&
				m.device !== device &&
				models.get(key) === cached
			) {
				models.delete(key);
				m.dispose();
			}
		});
	}
	const f = failures.get(key);
	if (
		!p &&
		f &&
		(f.n >= MAX_LOAD_ATTEMPTS ||
			performance.now() - f.at < LOAD_BACKOFF_MS * 2 ** (f.n - 1))
	)
		return Promise.resolve(null);
	if (!p) {
		p = (async () => {
			try {
				return await createSkyModel({
					device,
					backends: backend ? [backend] : undefined,
				});
			} catch (e) {
				modelError = String(e);
				console.warn("[sky] model unavailable, using classical fallback:", e);
				failures.set(key, {
					n: (failures.get(key)?.n ?? 0) + 1,
					at: performance.now(),
				});
				return null;
			}
		})();
		models.set(key, p);
		p.then((m) => {
			if (!m && models.get(key) === p) models.delete(key);
		});
	}
	return p;
}

const scope = self as unknown as DedicatedWorkerGlobalScope;

async function preload(req: SkyPreloadRequest) {
	const t0 = performance.now();
	const device = await computeDevice(req.gpu);
	const model = await loadModel(req.backend, device);
	const msg: SkyWorkerResponse = {
		id: req.id,
		ok: true,
		type: "preload",
		backend: model?.backend ?? null,
		error: model ? undefined : modelError,
		ms: performance.now() - t0,
	};
	scope.postMessage(msg);
}

async function segment(req: SkySegmentRequest) {
	try {
		await segmentOf(req);
	} finally {
		req.bitmap?.close();
	}
}

async function segmentOf(req: SkySegmentRequest) {
	const { width: W, height: H } = req;
	const t0 = performance.now();
	if (!req.rgba && !req.bitmap) throw new Error("segment: no pixels");
	const rgba = req.rgba ? new Uint8Array(req.rgba) : undefined;
	const device = await computeDevice(req.gpu);
	const model = req.forceFallback ? null : await loadModel(req.backend, device);
	// GPU prep (src/lib/sky/prep.ts): the photo goes ImageBitmap → GPU buffers (the model's input, the
	// refine's guides) without visiting the CPU; undefined = the CPU prep below
	const modelLongSide =
		req.modelLongSide ?? (model ? MODEL_LONG_SIDE[model.backend] : 0);
	const prep =
		req.bitmap && device && model
			? await prepareGpu(device, model, req.bitmap, W, H, modelLongSide, rgba)
			: undefined;
	if (!prep && !rgba) throw new NeedPixels();
	try {
		await segmentWith(req, t0, device, model, prep, rgba);
	} finally {
		prep?.dispose();
	}
}

async function segmentWith(
	req: SkySegmentRequest,
	t0: number,
	device: Device | null,
	model: SkyModel | null,
	prep: SkyPrepGpu | undefined,
	rgba: Uint8Array | undefined,
) {
	const { id, width: W, height: H } = req;
	// CPU pixels / planes on demand: with the GPU prep they are read back only if a fallback needs them
	const pixels = async () => {
		rgba ??= await (prep as SkyPrepGpu).readRgba();
		return rgba;
	};
	let planes: Float32Array | undefined;
	const rgbOf = async () =>
		(planes ??= rgbPlanes({ width: W, height: H, data: await pixels() }));
	const t1 = performance.now();
	let inf: SkyInference | undefined;
	let low: ModelRun | undefined;
	let source: "model" | "fallback" = "fallback";
	if (model) {
		try {
			if (prep) {
				const { width, height } = modelSize(
					W,
					H,
					req.modelLongSide ?? MODEL_LONG_SIDE[model.backend],
				);
				inf = await inferSkyModelGpu(model, prep.inputBuffer, width, height);
			} else
				inf = await inferSkyModel(
					model,
					await rgbOf(),
					W,
					H,
					req.modelLongSide,
				);
			source = "model";
		} catch (e) {
			console.warn("[sky] inference failed, using classical fallback:", e);
			modelError = String(e);
			noteFailure(e);
		}
	}
	if (!inf) low = classicalSky(await rgbOf(), W, H);
	const t2 = performance.now();
	let data: Uint8Array | undefined;
	let refineOn: "gpu" | "cpu" = "cpu";
	try {
		if (device && req.refine) {
			try {
				const lw = inf?.width ?? (low as ModelRun).width;
				const lh = inf?.height ?? (low as ModelRun).height;
				// the model output is a buffer on the compute device when the model runs on it
				const onDevice =
					inf?.gpuBuffer && model?.device === device
						? inf.gpuBuffer
						: undefined;
				refineDevices.add(device);
				const out = await refineSkyGpu(device, {
					W,
					H,
					rgba: prep ? prep.rgba : await pixels(),
					lw,
					lh,
					guideLo:
						prep && lw === prep.lw && lh === prep.lh
							? prep.rgbLo
							: (inf?.rgbLo ?? resamplePlanes(await rgbOf(), W, H, 3, lw, lh)),
					prob:
						onDevice ?? (inf ? await inf.download() : (low as ModelRun).prob),
				});
				data = out.bytes;
				refineOn = "gpu";
			} catch (e) {
				console.warn("[sky] GPU refine failed, using the CPU refine:", e);
				noteFailure(e);
			}
		}
		if (!data) {
			low ??= inf && {
				prob: await inf.download(),
				width: inf.width,
				height: inf.height,
			};
			data = toBytes(
				refineToWorking(await rgbOf(), W, H, low as ModelRun, req.refine),
			);
		}
	} finally {
		// after a device loss the model (and its output) may already be gone: never mask the result
		try {
			inf?.release();
		} catch {}
	}
	const t3 = performance.now();
	const msg: SkyWorkerResponse = {
		id,
		ok: true,
		type: "segment",
		width: W,
		height: H,
		data: data.buffer as ArrayBuffer,
		source,
		backend: source === "model" ? model?.backend : undefined,
		error: source === "fallback" ? modelError : undefined,
		ms: { load: t1 - t0, infer: t2 - t1, refine: t3 - t2 },
		refineOn,
		prep: prepStatus(device, prep ? "gpu" : "cpu"),
	};
	scope.postMessage(msg, [msg.data]);
}

// One model runs one forward at a time (the nn runtime records a single graph), so requests (and the
// idle release) are handled strictly in arrival order.

async function handle(req: SkyWorkerRequest) {
	idle.begin();
	try {
		if (req.type === "preload") await preload(req);
		else await segment(req);
	} catch (e) {
		noteFailure(e);
		const msg: SkyWorkerResponse = {
			id: req.id,
			ok: false,
			error: String(e),
			needPixels: e instanceof NeedPixels || undefined,
		};
		scope.postMessage(msg);
	} finally {
		idle.end();
	}
}

scope.onmessage = (ev: MessageEvent<SkyWorkerRequest>) => {
	const req = ev.data;
	void queue.run(() => handle(req));
};
