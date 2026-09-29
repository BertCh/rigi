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
}

/** Start fetching the wasm + model and creating the session; replies when ready. */
export interface SkyPreloadRequest {
	type: "preload";
	id: number;
	modelUrl?: string;
	backend?: "webgpu" | "wasm";
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
