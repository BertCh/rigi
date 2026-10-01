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
import { refineSkyGpu, warmSkyKernels } from "#/lib/gpu/sky/refine";
import {
	classicalSky,
	type ModelRun,
	refineToWorking,
	resamplePlanes,
	rgbPlanes,
	toBytes,
} from "./core";
import {
	type Backend,
	createSkyModel,
	inferSkyModel,
	MODEL_FILE,
	type SkyInference,
	type SkyModel,
} from "./model";
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
				return null;
			}
		})();
		models.set(key, p);
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
	const { id, width: W, height: H } = req;
	const t0 = performance.now();
	const rgba = new Uint8Array(req.rgba);
	const rgb = rgbPlanes({ width: W, height: H, data: rgba });
	const device = await computeDevice(req.gpu);
	const model = req.forceFallback
		? null
		: await loadModel(modelUrlOf(req), req.backend, device);
	const t1 = performance.now();
	let inf: SkyInference | undefined;
	let low: ModelRun | undefined;
	let source: "model" | "fallback" = "fallback";
	if (model) {
		try {
			inf = await inferSkyModel(model, rgb, W, H, req.modelLongSide);
			source = "model";
		} catch (e) {
			console.warn("[sky] inference failed, using classical fallback:", e);
			modelError = String(e);
		}
	}
	if (!inf) low = classicalSky(rgb, W, H);
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
					rgba,
					lw,
					lh,
					guideLo: inf?.rgbLo ?? resamplePlanes(rgb, W, H, 3, lw, lh),
					prob:
						onDevice ?? (inf ? await inf.download() : (low as ModelRun).prob),
					// GPUCommandGraph with aliased transients: bit-identical, ~27–51% less scratch VRAM
					graph: true,
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
			data = toBytes(refineToWorking(rgb, W, H, low as ModelRun, req.refine));
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
		const msg: SkyWorkerResponse = { id: req.id, ok: false, error: String(e) };
		scope.postMessage(msg);
	}
}

scope.onmessage = (ev: MessageEvent<SkyWorkerRequest>) => {
	const req = ev.data;
	queue = queue.then(() => handle(req));
};
