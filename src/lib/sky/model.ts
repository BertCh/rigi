/**
 * ONNX Runtime wrapper for the U²-Net sky model. Works with onnxruntime-web
 * in a browser worker (WebGPU → WASM) and in node (the package's node build,
 * CPU/WASM), so the eval script exercises exactly the same code.
 */
import * as ort from "onnxruntime-web";
import { type ModelRun, modelSize, normalise, resamplePlanes } from "./core";

/**
 * U²-Net-P sky model (MIT), converted from the upstream ncnn weights (see
 * README.md). Served from the app's public dir; the filename carries the
 * first 8 hex digits of its sha256 so it can be served with immutable
 * long-cache headers. When replacing the model, rename it to the new hash
 * (scripts/sky-eval.ts verifies the name matches the content).
 */
export const MODEL_FILE = "models/skyseg-u2netp.873ea284.onnx";
/**
 * Model input long side (px) per backend. Trained at 384²; 384 and 512 score
 * the same on our photos, so the slower WASM path uses 384.
 */
export const MODEL_LONG_SIDE: Record<Backend, number> = {
	webgpu: 512,
	wasm: 384,
};

export type Backend = "webgpu" | "wasm";

export interface SkyModel {
	session: ort.InferenceSession;
	backend: Backend;
}

/**
 * True when WebGPU has a hardware adapter. Software adapters (SwiftShader,
 * e.g. headless Chromium or blocklisted GPUs) run this model ~40× slower
 * than WASM, so they're skipped unless WebGPU is explicitly requested.
 */
async function hardwareWebGPU(): Promise<boolean> {
	type Adapter = {
		isFallbackAdapter?: boolean;
		info?: { architecture?: string };
	};
	type Gpu = { requestAdapter(): Promise<unknown> };
	const gpu = (globalThis.navigator as { gpu?: Gpu } | undefined)?.gpu;
	if (!gpu) return false;
	try {
		const a = (await gpu.requestAdapter()) as Adapter | null;
		return (
			!!a && !a.isFallbackAdapter && a.info?.architecture !== "swiftshader"
		);
	} catch {
		return false;
	}
}

/**
 * Creates the session from model bytes, trying WebGPU first (hardware
 * adapters only, unless `backends` is exactly ["webgpu"]), then WASM.
 */
export async function createSkyModel(
	bytes: Uint8Array,
	backends: Backend[] = ["webgpu", "wasm"],
): Promise<SkyModel> {
	let lastErr: unknown;
	for (const backend of backends) {
		if (
			backend === "webgpu" &&
			backends.length > 1 &&
			!(await hardwareWebGPU())
		)
			continue;
		try {
			const session = await ort.InferenceSession.create(bytes, {
				executionProviders: [backend],
				graphOptimizationLevel: "all",
			});
			return { session, backend };
		} catch (e) {
			lastErr = e;
		}
	}
	throw lastErr ?? new Error("no ONNX Runtime backend available");
}

/**
 * Runs the model on a planar RGB (0..1) image of size W×H and returns P(sky)
 * at model resolution (long side `longSide`, multiples of 32).
 */
export async function runSkyModel(
	model: SkyModel,
	rgbWork: Float32Array,
	W: number,
	H: number,
	longSide = MODEL_LONG_SIDE[model.backend],
): Promise<ModelRun> {
	const { width, height } = modelSize(W, H, longSide);
	const rgb = resamplePlanes(rgbWork, W, H, 3, width, height);
	const input = new ort.Tensor("float32", normalise(rgb, width * height), [
		1,
		3,
		height,
		width,
	]);
	const s = model.session;
	const out = await s.run({ [s.inputNames[0]]: input });
	const t = out[s.outputNames[0]];
	const prob = new Float32Array(t.data as Float32Array);
	input.dispose?.();
	t.dispose?.();
	return { prob, width, height };
}
