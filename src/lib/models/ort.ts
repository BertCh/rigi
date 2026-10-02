// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// onnxruntime-web sessions on the app's WebGPU device (generalised from the sky model). Works in a
// page, a worker and node (the package's node build: no navigator.gpu, so WASM/CPU).

import type { Device } from "@luma.gl/core";
import * as ort from "onnxruntime-web";
import { navigatorGpu, peekWebGPUAdapter } from "#/lib/gpu/adapter-peek";

export type OrtBackend = "webgpu" | "wasm";

export type OrtSession = {
	session: ort.InferenceSession;
	backend: OrtBackend;
	/**
	 * The GPUDevice ORT's WebGPU EP runs on when it is the caller's device (see shareOrtDevice): GPU
	 * tensors (Tensor.fromGpuBuffer, gpu-buffer outputs) are then the caller's buffers.
	 */
	sharedDevice?: GPUDevice;
	/**
	 * ORT's own device, attached to luma (not owned: ORT keeps ownership), when the caller's device
	 * was not taken because ORT had already initialised on another one.
	 */
	ortDevice?: Device;
};

export type OrtSessionBytesOptions = {
	/** Backends to try in order (default webgpu, then wasm). webgpu alone skips the hardware check. */
	backends?: OrtBackend[];
	/** The caller's native WebGPU device, handed to ORT when ORT has not initialised yet. */
	device?: GPUDevice;
	/**
	 * Keep outputs on the GPU (preferredOutputLocation "gpu-buffer") when the session runs on the
	 * caller's device or an attached ORT device. Callers then read `tensor.gpuBuffer` or `getData()`.
	 */
	outputOnGpu?: boolean;
	/** Extra session options (executionProviders and preferredOutputLocation are set here). */
	sessionOptions?: ort.InferenceSession.SessionOptions;
	/** Log prefix for warnings. */
	tag?: string;
};

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
 * ORT has one device per realm: the first WebGPU session fixes it for the realm's life.
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
 * True when WebGPU has a hardware adapter. Software adapters (SwiftShader, e.g. headless Chromium or
 * blocklisted GPUs) run conv nets ~40× slower than WASM, so they are skipped unless WebGPU is the only
 * backend asked for.
 */
export async function hardwareWebGPU(): Promise<boolean> {
	type Adapter = {
		isFallbackAdapter?: boolean;
		info?: { architecture?: string };
	};
	if (!navigatorGpu()) return false;
	try {
		const a = (await peekWebGPUAdapter()) as Adapter | null;
		return (
			!!a && !a.isFallbackAdapter && a.info?.architecture !== "swiftshader"
		);
	} catch {
		return false;
	}
}

/**
 * Creates a session from model bytes, trying the backends in order (default WebGPU on a hardware
 * adapter, then WASM). With `device`, ORT runs on it when it can (shareOrtDevice); when ORT already
 * runs on its own device, that device is attached to luma as `ortDevice`.
 */
export async function createOrtSessionFromBytes(
	bytes: Uint8Array,
	opts: OrtSessionBytesOptions = {},
): Promise<OrtSession> {
	const backends = opts.backends ?? ["webgpu", "wasm"];
	const tag = opts.tag ?? "[models]";
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
			// ORT already runs on another device (not the caller's): attach it to luma (#3313), ORT keeps
			// ownership. Needs its device now, before the session, to keep the output on the GPU.
			let attached: Device | undefined;
			if (backend === "webgpu" && opts.device && !shared) {
				try {
					const g = await initialisedOrtDevice();
					if (g && g !== opts.device) {
						const { attachWebGPUDevice } = await import("#/lib/gpu/core/luma");
						attached = await attachWebGPUDevice(g, { id: "rigi-ort" });
					}
				} catch (e) {
					console.warn(`${tag} could not attach ORT's device`, e);
				}
			}
			const session = await ort.InferenceSession.create(bytes, {
				graphOptimizationLevel: "all",
				...opts.sessionOptions,
				executionProviders: [backend],
				...(opts.outputOnGpu &&
					(shared || attached) && {
						preferredOutputLocation: "gpu-buffer" as const,
					}),
			});
			const ortDevice = shared
				? await (ort.env.webgpu as unknown as { device?: unknown }).device
				: undefined;
			if (shared && ortDevice !== opts.device)
				console.warn(`${tag} ORT did not take the shared WebGPU device`);
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

let wasmConfigured = false;

/**
 * Browser only: points ORT at the bundled JSEP wasm (Vite pre-bundles ORT in dev, which breaks its own
 * import.meta.url lookup) and runs it single-threaded (pthread workers would re-load the bundled chunk,
 * and the app is not crossOriginIsolated). Leaves a caller's own wasmPaths alone. Node keeps ORT's
 * defaults (the wasm next to the package).
 */
export async function configureOrtWasm(): Promise<void> {
	if (wasmConfigured) return;
	wasmConfigured = true;
	ort.env.wasm.numThreads = 1;
	if (!ort.env.wasm.wasmPaths) {
		const { default: wasm } = await import(
			"onnxruntime-web/ort-wasm-simd-threaded.jsep.wasm?url"
		);
		ort.env.wasm.wasmPaths = { wasm };
	}
}
