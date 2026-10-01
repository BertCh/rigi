/**
 * ONNX Runtime wrapper for the U²-Net sky model. Works with onnxruntime-web
 * in a browser worker (WebGPU → WASM) and in node (the package's node build,
 * CPU/WASM), so the eval script exercises exactly the same code.
 */
import type { Device } from "@luma.gl/core";
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
	/**
	 * The GPUDevice ORT's WebGPU EP runs on when it is the caller's device (see shareOrtDevice): the
	 * session then keeps its output on the GPU (inferSkyModel's `gpuBuffer`).
	 */
	sharedDevice?: GPUDevice;
	/**
	 * ORT's own device, attached to luma (`_ownsHandle: false`: ORT keeps ownership), when the shared
	 * device was not taken because ORT had already initialised on another one. The output then stays
	 * on this device (inferSkyModel's `gpuBuffer`) and refine runs on it; the compute shim stays primary.
	 */
	ortDevice?: Device;
}

/** ORT's GPUDevice when its WebGPU EP has already created one (else undefined). */
function initialisedOrtDevice(): Promise<GPUDevice> | GPUDevice | undefined {
	const d = Object.getOwnPropertyDescriptor(ort.env.webgpu, "device");
	return d && "value" in d && d.value ? d.value : undefined;
}

/**
 * Makes ORT's WebGPU EP run on `device` (one device for the model and the caller's compute), if ORT
 * has not created its device yet. Returns whether ORT now uses `device`.
 *
 * ORT 1.30's JSEP build (the "onnxruntime-web" bundle) ignores `env.webgpu.device` on the way in:
 * its backend always calls `adapter.requestDevice()` and then overwrites `env.webgpu.device`. It does
 * honour `env.webgpu.adapter` (any object with `limits`, `features` and `requestDevice`), so we hand
 * it an adapter whose requestDevice resolves `device`. Once ORT is initialised, `env.webgpu.device`
 * is ORT's device and `env.webgpu.adapter` is read-only, so a later call only reports the match.
 */
export async function shareOrtDevice(device: GPUDevice): Promise<boolean> {
	const env = ort.env.webgpu as unknown as {
		device?: GPUDevice | Promise<GPUDevice>;
		adapter?: unknown;
	};
	const d = Object.getOwnPropertyDescriptor(env, "device");
	if (d && "value" in d && d.value) return (await d.value) === device;
	const info = (device as { adapterInfo?: unknown }).adapterInfo;
	try {
		env.adapter = {
			limits: device.limits,
			features: device.features,
			info,
			requestAdapterInfo: async () => info,
			requestDevice: async () => device,
		};
	} catch {
		return false;
	}
	return true;
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
	opts: { device?: GPUDevice } = {},
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
			const shared =
				backend === "webgpu" && opts.device
					? await shareOrtDevice(opts.device)
					: false;
			// ORT already runs on another device (not the caller's): attach it for refine (luma #3313),
			// ORT keeps ownership. Needs its device now, before the session, to keep the output on the GPU.
			let attached: Device | undefined;
			if (backend === "webgpu" && opts.device && !shared) {
				try {
					const g = await initialisedOrtDevice();
					if (g && g !== opts.device) {
						const { attachWebGPUDevice } = await import("#/lib/gpu/core/luma");
						attached = await attachWebGPUDevice(g, {
							id: "rigi-ort",
							_ownsHandle: false,
						});
					}
				} catch (e) {
					console.warn("[sky] could not attach ORT's device", e);
				}
			}
			const session = await ort.InferenceSession.create(bytes, {
				executionProviders: [backend],
				graphOptimizationLevel: "all",
				...((shared || attached) && {
					preferredOutputLocation: "gpu-buffer" as const,
				}),
			});
			const ortDevice = shared
				? await (ort.env.webgpu as unknown as { device?: unknown }).device
				: undefined;
			if (shared && ortDevice !== opts.device)
				console.warn("[sky] ORT did not take the shared WebGPU device");
			return {
				session,
				backend,
				sharedDevice:
					shared && ortDevice === opts.device ? opts.device : undefined,
				ortDevice: attached,
			};
		} catch (e) {
			lastErr = e;
		}
	}
	throw lastErr ?? new Error("no ONNX Runtime backend available");
}

/** The model's raw output: on the CPU, or still on the GPU when the session shares the device. */
export interface SkyInference {
	width: number;
	height: number;
	/** resamplePlanes(rgbWork, W, H, 3, width, height): the model input, also the refine's low-res guide. */
	rgbLo: Float32Array;
	/** P(sky) at model resolution, when the output is on the CPU. */
	prob?: Float32Array;
	/** The output buffer (width·height f32) on `model.sharedDevice`, valid until `release()`. */
	gpuBuffer?: GPUBuffer;
	/** P(sky) on the CPU (downloads a GPU output; call before `release()`). */
	download(): Promise<Float32Array>;
	/** Frees the output tensor (the GPU buffer returns to ORT's pool). */
	release(): void;
}

/**
 * Runs the model on a planar RGB (0..1) image of size W×H. The output stays on the GPU when the
 * session was created on a shared device; otherwise it is P(sky) on the CPU.
 */
export async function inferSkyModel(
	model: SkyModel,
	rgbWork: Float32Array,
	W: number,
	H: number,
	longSide = MODEL_LONG_SIDE[model.backend],
): Promise<SkyInference> {
	const { width, height } = modelSize(W, H, longSide);
	const rgb = resamplePlanes(rgbWork, W, H, 3, width, height);
	const input = new ort.Tensor("float32", normalise(rgb, width * height), [
		1,
		3,
		height,
		width,
	]);
	const s = model.session;
	let t: ort.Tensor;
	try {
		const out = await s.run({ [s.inputNames[0]]: input });
		t = out[s.outputNames[0]];
	} finally {
		input.dispose?.();
	}
	if (t.location === "gpu-buffer") {
		let prob: Float32Array | undefined;
		return {
			width,
			height,
			rgbLo: rgb,
			gpuBuffer: t.gpuBuffer as GPUBuffer,
			download: async () => {
				prob ??= new Float32Array((await t.getData()) as Float32Array);
				return prob;
			},
			release: () => t.dispose?.(),
		};
	}
	const prob = new Float32Array(t.data as Float32Array);
	t.dispose?.();
	return {
		width,
		height,
		rgbLo: rgb,
		prob,
		download: async () => prob,
		release: () => {},
	};
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
	const r = await inferSkyModel(model, rgbWork, W, H, longSide);
	try {
		return { prob: await r.download(), width: r.width, height: r.height };
	} finally {
		r.release();
	}
}
