/// <reference lib="webworker" />
/**
 * Sky segmentation worker: lazily loads the U²-Net-P sky model (WebGPU →
 * WASM), runs it, refines with the fast guided filter, and falls back to the
 * classical segmenter if the model can't be loaded or run.
 *
 * Assets: "onnxruntime-web" resolves to the JSEP bundle (ort.bundle.min.mjs),
 * whose JS glue is inlined and which serves both the WebGPU and WASM
 * execution providers from ONE wasm binary (ort-wasm-simd-threaded.jsep.wasm).
 * That binary is imported with `?url`, so Vite emits exactly one
 * content-hashed ORT asset (safe for immutable long-cache headers); no other
 * ORT wasm variant is referenced. The model is public/models/ with a
 * content-hashed filename.
 */
import * as ort from "onnxruntime-web";
import wasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.jsep.wasm?url";
import {
	classicalSky,
	type ModelRun,
	refineToWorking,
	rgbPlanes,
	toBytes,
} from "./core";
import {
	type Backend,
	createSkyModel,
	MODEL_FILE,
	runSkyModel,
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

function loadModel(url: string, backend?: Backend): Promise<SkyModel | null> {
	const key = `${url}|${backend ?? "auto"}`;
	let p = models.get(key);
	if (!p) {
		p = (async () => {
			try {
				const res = await fetch(url);
				if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
				const bytes = new Uint8Array(await res.arrayBuffer());
				return await createSkyModel(bytes, backend ? [backend] : undefined);
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
	const model = await loadModel(modelUrlOf(req), req.backend);
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
	const { id, width: W, height: H } = req;
	const t0 = performance.now();
	const rgb = rgbPlanes({
		width: W,
		height: H,
		data: new Uint8Array(req.rgba),
	});
	const model = req.forceFallback
		? null
		: await loadModel(modelUrlOf(req), req.backend);
	const t1 = performance.now();
	let low: ModelRun | undefined;
	let source: "model" | "fallback" = "fallback";
	if (model) {
		try {
			low = await runSkyModel(model, rgb, W, H, req.modelLongSide);
			source = "model";
		} catch (e) {
			console.warn("[sky] inference failed, using classical fallback:", e);
			modelError = String(e);
		}
	}
	low ??= classicalSky(rgb, W, H);
	const t2 = performance.now();
	const data = toBytes(refineToWorking(rgb, W, H, low, req.refine));
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
