/** Messages between index.ts and sky.worker.ts. */
export interface SkySegmentRequest {
	type: "segment";
	id: number;
	width: number;
	height: number;
	/** RGBA bytes at working resolution (transferred). */
	rgba: ArrayBuffer;
	refine: boolean;
	/** Model input long side (default per backend, see MODEL_LONG_SIDE). */
	modelLongSide?: number;
	/** Absolute model URL override (default: the bundled, fingerprinted model). */
	modelUrl?: string;
	/** Restrict the ONNX Runtime backend (default: WebGPU if available, else WASM). */
	backend?: "webgpu" | "wasm";
	/** Skip the model (testing the classical path). */
	forceFallback?: boolean;
	/**
	 * The page's gpuEnabled() (?gpu=off → false): the worker has no page URL. When true, ORT's WebGPU
	 * EP shares the worker's luma compute device and the refine runs on it (src/lib/gpu/sky).
	 */
	gpu?: boolean;
}

/** Start fetching the wasm + model and creating the session; replies when ready. */
export interface SkyPreloadRequest {
	type: "preload";
	id: number;
	modelUrl?: string;
	backend?: "webgpu" | "wasm";
	/** As SkySegmentRequest.gpu (decides whether ORT shares the compute device). */
	gpu?: boolean;
}

export type SkyWorkerRequest = SkySegmentRequest | SkyPreloadRequest;

export type SkyWorkerResponse =
	| {
			id: number;
			ok: true;
			type: "segment";
			width: number;
			height: number;
			data: ArrayBuffer;
			source: "model" | "fallback";
			backend?: "webgpu" | "wasm";
			error?: string;
			ms: { load: number; infer: number; refine: number };
			/** Where the refine ran (the GPU path falls back to the CPU on any error). */
			refineOn?: "gpu" | "cpu";
			/** ORT's WebGPU device: the compute device ("shared") or its own; absent on WASM. */
			ortDevice?: "shared" | "own";
	  }
	| {
			id: number;
			ok: true;
			type: "preload";
			/** null when the model could not be loaded (fallback will be used). */
			backend: "webgpu" | "wasm" | null;
			error?: string;
			ms: number;
	  }
	| { id: number; ok: false; error: string };
