/// <reference lib="webworker" />
/**
 * Sky segmentation worker: lazily loads the U²-Net-P sky model (WebGPU →
 * WASM), runs it, refines with the fast guided filter, and falls back to the
 * classical segmenter if the model can't be loaded or run.
 *
 * GPU (when the page's gpuEnabled() says so, sent as `gpu`): the worker's
 * luma compute device is created first and handed to ORT (shareOrtDevice), so
 * the model and the refine share ONE GPUDevice; the model output stays on the
 * GPU and the refine (src/lib/gpu/sky/refine.ts, the GPU twin of
 * refineToWorking) reads only the final byte mask back. If ORT runs on its
 * own device (it was initialised by a request without `gpu`) or on WASM, the
 * GPU refine takes the downloaded P(sky). The CPU refine is the reference and
 * the fallback: no WebGPU, ?gpu=off, or any GPU error.
 *
 * Assets: "onnxruntime-web" resolves to the JSEP bundle (ort.bundle.min.mjs),
 * whose JS glue is inlined and which serves both the WebGPU and WASM
 * execution providers from ONE wasm binary (ort-wasm-simd-threaded.jsep.wasm).
 * That binary is imported with `?url`, so Vite emits exactly one
 * content-hashed ORT asset (safe for immutable long-cache headers); no other
 * ORT wasm variant is referenced. The model is public/models/ with a
 * content-hashed filename.
 */

import type { Device } from "@luma.gl/core";
import * as ort from "onnxruntime-web";
import wasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.jsep.wasm?url";
import { getComputeDevice } from "#/lib/gpu/device";
import type { SkyPrepGpu } from "#/lib/gpu/sky/prep";
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
import {
	type Backend,
	createSkyModel,
	inferSkyModel,
	inferSkyModelGpu,
	MODEL_FILE,
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

// Explicit wasm URL: needed in dev (Vite pre-bundles ORT, breaking its own
// import.meta.url lookup) and resolves to the same hashed asset in builds.
ort.env.wasm.wasmPaths = { wasm: wasmUrl };
// Single-threaded: ORT's pthread workers would re-load this bundled worker
// chunk, and the app isn't crossOriginIsolated (no SharedArrayBuffer) anyway.
ort.env.wasm.numThreads = 1;
ort.env.logLevel = "error";

const models = new Map<string, Promise<SkyModel | null>>();
let modelError: string | undefined;
// A failed load is not cached for good: retry after a growing backoff, up to a cap.
const failures = new Map<string, { n: number; at: number }>();
const MAX_LOAD_ATTEMPTS = 4;
const LOAD_BACKOFF_MS = 2000;

const warmed = new WeakSet<Device>();

/** The worker's luma compute device when the page allows the GPU (null: CPU refine). */
async function computeDevice(gpu: boolean | undefined): Promise<Device | null> {
	if (!gpu) return null;
	const device = await getComputeDevice();
	if (device && !warmed.has(device)) {
		warmed.add(device);
		void warmSkyKernels(device);
	}
	return device;
}

/**
 * The session for (url, backend). The first WebGPU session decides ORT's device for the life of the
 * worker: `device` (shared) when given, else ORT's own.
 */
function loadModel(
	url: string,
	backend?: Backend,
	device?: Device | null,
): Promise<SkyModel | null> {
	const key = `${url}|${backend ?? "auto"}`;
	let p = models.get(key);
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
				const res = await fetch(url);
				if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
				const bytes = new Uint8Array(await res.arrayBuffer());
				return await createSkyModel(bytes, backend ? [backend] : undefined, {
					device: (device?.handle as GPUDevice | undefined) ?? undefined,
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

// The model lives in public/ (content-hashed filename, see MODEL_FILE); the
// dev server here only serves a few asset types from src/, so no `?url`.
const defaultModelUrl = `${import.meta.env.BASE_URL}${MODEL_FILE}`;
const modelUrlOf = (req: { modelUrl?: string }) =>
	new URL(req.modelUrl ?? defaultModelUrl, self.location.origin).href;

const scope = self as unknown as DedicatedWorkerGlobalScope;

async function preload(req: SkyPreloadRequest) {
	const t0 = performance.now();
	const device = await computeDevice(req.gpu);
	const model = await loadModel(modelUrlOf(req), req.backend, device);
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

const ortDeviceOf = (model: SkyModel | null | undefined) =>
	model?.backend === "webgpu"
		? model.sharedDevice
			? ("shared" as const)
			: ("own" as const)
		: undefined;

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
	const model = req.forceFallback
		? null
		: await loadModel(modelUrlOf(req), req.backend, device);
	// GPU prep (src/lib/sky/prep.ts): the photo goes ImageBitmap → GPU buffers (ORT's input, the
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
				inf = await inferSkyModelGpu(model, prep.input, width, height);
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
				// the model output stays on the GPU only when ORT runs on this very device; when ORT kept
				// its own device (model.ortDevice, attached), refine runs there instead of the shim
				const shared = model?.sharedDevice === device.handle;
				const refineDev =
					inf?.gpuBuffer &&
					!shared &&
					model?.ortDevice &&
					// ORT's device may carry default limits: its biggest refine buffer is ~16 B/px
					model.ortDevice.limits.maxStorageBufferBindingSize >= W * H * 16
						? model.ortDevice
						: device;
				const onDevice =
					inf?.gpuBuffer && (shared || refineDev !== device)
						? inf.gpuBuffer
						: undefined;
				const out = await refineSkyGpu(refineDev, {
					W,
					H,
					// the prep's buffers live on `device`; refineDev is `device` whenever the prep ran
					// (the prep needs ORT on the shared device) or the model output is on the CPU
					rgba: prep && refineDev === device ? prep.rgba : await pixels(),
					lw,
					lh,
					guideLo:
						prep && refineDev === device && lw === prep.lw && lh === prep.lh
							? prep.rgbLo
							: (inf?.rgbLo ?? resamplePlanes(await rgbOf(), W, H, 3, lw, lh)),
					prob:
						onDevice ?? (inf ? await inf.download() : (low as ModelRun).prob),
				});
				data = out.bytes;
				refineOn = "gpu";
			} catch (e) {
				console.warn("[sky] GPU refine failed, using the CPU refine:", e);
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
		inf?.release();
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
		ortDevice: source === "model" ? ortDeviceOf(model) : undefined,
		prep: prepStatus(device, prep ? "gpu" : "cpu"),
	};
	scope.postMessage(msg, [msg.data]);
}

// One ORT session can't run concurrent inferences ("Session already started"),
// so requests are handled strictly in arrival order.
let queue: Promise<void> = Promise.resolve();

async function handle(req: SkyWorkerRequest) {
	try {
		if (req.type === "preload") await preload(req);
		else await segment(req);
	} catch (e) {
		const msg: SkyWorkerResponse = {
			id: req.id,
			ok: false,
			error: String(e),
			needPixels: e instanceof NeedPixels || undefined,
		};
		scope.postMessage(msg);
	}
}

scope.onmessage = (ev: MessageEvent<SkyWorkerRequest>) => {
	const req = ev.data;
	queue = queue.then(() => handle(req));
};
