// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The frozen tensor-runtime interface (browser-only pass, AMENDMENT 1). Model forward passes
// (features/aliked.ts, features/lightglue.ts, nearfield/local/depth-net.ts, …) are written against
// `Nn` only, so the same code runs on the GPU backend (WGSL kernels on one core ComputeGraph per
// forward) and on the CPU reference backend (specs, and the no-WebGPU fallback).
//
// Conventions (PyTorch's, so ported code reads 1:1):
// - images are NCHW, sequences [B, N, C], attention [B, H, N, D]; tensors are contiguous row-major;
// - `axis` may be negative (counted from the end);
// - conv weights are [Cout, Cin/groups, kh, kw]; convTranspose weights [Cin, Cout/groups, kh, kw];
//   linear weights [out, in] (y = x Wᵀ + b);
// - index tensors (topk indices, gather indices) are f32 holding integers (exact below 2^24);
// - boolean results (compare) are 0 / 1 in f32.
// Every op returns a new tensor. Activations are f32; weights may be f16 on a GPU with shader-f16
// (kernels accumulate in f32 and widen f16 inputs on load).

/**
 * Tensor storage type. "q8" only appears on GPU weights loaded from a quantized file with resident
 * int8 (quant.ts `packResident`): the buffer stays packed and conv / linear / matmul-B kernels
 * dequantize inside their weight loads; any other op on such a tensor throws.
 */
export type DType = "f32" | "f16" | "q8";

/** A backend-owned tensor. Read it with `nn.read`, free it with `nn.dispose`. */
export interface Tensor {
	readonly shape: readonly number[];
	readonly dtype: DType;
}

export interface NnBackend {
	kind: "gpu" | "cpu";
	/** GPU: f16 weights stay f16 in storage (shader-f16). Always false on the CPU. */
	f16?: boolean;
}

/** A loaded safetensors file: tensors by name (PyTorch state_dict keys). */
export interface Weights {
	readonly names: readonly string[];
	has(name: string): boolean;
	/** Throws on an unknown name. */
	get(name: string): Tensor;
	/** Metadata from the safetensors header (`__metadata__`), if any. */
	readonly metadata: Readonly<Record<string, string>>;
}

export type Pair = number | readonly [number, number];

export type Conv2dOptions = {
	stride?: Pair;
	/** symmetric zero padding (h, w) */
	padding?: Pair;
	dilation?: Pair;
	groups?: number;
};

export type ConvTranspose2dOptions = Conv2dOptions & { outputPadding?: Pair };

/** torchvision.ops.deform_conv2d: offset [N, 2·dg·kh·kw, Ho, Wo] as (dy, dx) pairs, mask [N, dg·kh·kw, Ho, Wo]. */
export type DeformConv2dOptions = Conv2dOptions & { offsetGroups?: number };

export type Pool2dOptions = {
	kernel: Pair;
	/** default = kernel */
	stride?: Pair;
	padding?: Pair;
	dilation?: Pair;
	/** avgPool2d: count padded cells in the divisor (PyTorch default true) */
	countIncludePad?: boolean;
	ceilMode?: boolean;
};

export type InterpolateOptions = {
	/** output (H, W); or `scale` */
	size?: readonly [number, number];
	scale?: Pair;
	mode: "nearest" | "bilinear" | "bicubic";
	/** bilinear / bicubic only (default false, like PyTorch) */
	alignCorners?: boolean;
};

export type GridSampleOptions = {
	mode?: "bilinear" | "nearest";
	padding?: "zeros" | "border";
	/** default false, like PyTorch */
	alignCorners?: boolean;
};

export type PadOptions = {
	mode?: "constant" | "reflect" | "replicate";
	value?: number;
};

export type UnaryOp =
	| "relu"
	| "gelu"
	| "geluTanh"
	| "silu"
	| "sigmoid"
	| "tanh"
	| "elu"
	| "selu"
	| "softplus"
	| "logSigmoid"
	| "exp"
	| "log"
	| "sqrt"
	| "rsqrt"
	| "abs"
	| "neg"
	| "square"
	| "recip"
	| "floor"
	| "round";

export type BinaryOp =
	| "add"
	| "sub"
	| "mul"
	| "div"
	| "max"
	| "min"
	| "pow"
	| "eq"
	| "ne"
	| "gt"
	| "ge"
	| "lt"
	| "le";

export type ReduceOp = "sum" | "mean" | "max" | "min";

export type AttentionOptions = {
	/** additive, broadcastable to [B, H, Nq, Nk] */
	mask?: Tensor;
	/** default 1/√D */
	scale?: number;
};

export type RotaryOptions = {
	/** true (default): pairs (2i, 2i+1), LightGlue's rotate_half; false: halves (i, i + D/2), GPT-NeoX */
	interleaved?: boolean;
};

export type TensorOrScalar = Tensor | number;

/** What `CompiledForward.run` returns: the forward's result with every tensor replaced by its values. */
export type Readback<R> = R extends Tensor
	? Float32Array
	: R extends null | undefined
		? R
		: R extends readonly (infer U)[]
			? Readback<U>[]
			: R extends object
				? { [K in keyof R]: Readback<R[K]> }
				: R;

/** An input of a compiled forward: values (uploaded in place) or a ready f32 tensor of that shape. */
export type CompiledInput = Float32Array | Tensor;

/**
 * A forward recorded once (`Nn.compile`) and replayed per frame: persistent input and output
 * buffers, a compiled graph with stable bind groups, no re-recording, hashing or fusion planning.
 * Calls do not wait for one another (only for the previous call's GPU submission order): a frame
 * loop may call `run` every frame and consume the promise a frame later.
 */
export interface CompiledForward<R> {
	/**
	 * Upload `inputs` (Float32Array values, or ready tensors rebound for this run), run the graph and
	 * read every output tensor back. Resolves when this run's results are mapped.
	 */
	run(inputs?: readonly CompiledInput[]): Promise<Readback<R>>;
	/** Like run without the readback, for consumers that use the outputs on the GPU (GpuNn `outputs`). Resolves once submitted. */
	submit(inputs?: readonly CompiledInput[]): Promise<void>;
	/** Free the persistent buffers and graph. Await every run first. */
	dispose(): void;
}

export interface Nn {
	readonly backend: NnBackend;

	/** GPU runtimes: give free-list memory back (registry releaseNn); absent on the CPU backend. */
	release?(): Promise<void>;

	/** Loads a safetensors file from public/models (fetchModel; Cache Storage in the browser). */
	loadWeights(
		file: string,
		opts?: {
			signal?: AbortSignal;
			onProgress?: (loaded: number, total: number) => void;
		},
	): Promise<Weights>;
	/** Parses safetensors bytes already in memory. */
	weightsFromBytes(bytes: ArrayBuffer | Uint8Array): Weights;
	fromArray(
		data: Float32Array | readonly number[],
		shape: readonly number[],
	): Tensor;
	/**
	 * GPU only: a 2-D texture (luma Texture; rgba8unorm, rgba16float, rgba32float, …) as a
	 * [1, C, H, W] f32 tensor, without a readback. Channels are the texel's first C components,
	 * resampled bilinearly (align_corners false) when H×W differs from the texture, then
	 * (v - mean[c]) / std[c].
	 */
	fromTexture?(
		tex: unknown,
		opts: {
			shape: readonly number[];
			mean?: readonly number[];
			std?: readonly number[];
		},
	): Tensor;
	zeros(shape: readonly number[]): Tensor;
	full(shape: readonly number[], value: number): Tensor;
	read(t: Tensor): Promise<Float32Array>;
	dispose(t: Tensor | Weights | readonly Tensor[]): void;
	/**
	 * Runs `fn` (which calls ops) as ONE ComputeGraph submission on the GPU backend; tensors reachable
	 * from the return value (a tensor, array, or plain object of them) are the outputs, every other
	 * tensor created inside is graph scratch and must not be used afterwards. Eager on the CPU.
	 */
	forward<T>(fn: () => T): Promise<T>;
	/**
	 * GPU backend: build and compile the graph `forward(fn)` would produce, without running it, so the
	 * first real forward of that shape is a cache hit (no pipeline compile at the first photo). `fn`
	 * must record exactly what the real forward records; inputs must have the real ones' kind: weights,
	 * `fromArray` / `fromBuffer` / `scratch(shape)` (a zeroed, never-uploaded f32 input, freed after),
	 * `fromTexture` with a texture of the real size. Outputs get no buffers. Resolves when compiled;
	 * rejects on a compile error (callers ignore it: a warm-up never fails a request).
	 */
	warm?<T>(
		fn: (scratch: (shape: readonly number[]) => Tensor) => T,
	): Promise<void>;
	/**
	 * Record `fn` once per (`key`, input shapes) and return a replayable forward (see
	 * CompiledForward). `fn` receives one persistent f32 tensor per entry of `inputShapes`; tensors
	 * it returns (a tensor, array or plain object of them) are the persistent outputs. Same
	 * `key` + shapes again returns the same compiled forward (fn is not called). On the CPU backend
	 * `run` simply runs `fn` eagerly.
	 */
	compile<R>(
		key: string,
		inputShapes: readonly (readonly number[])[],
		fn: (inputs: Tensor[]) => R,
	): Promise<CompiledForward<R>>;
	/**
	 * Name a group of ops (`encoder.block3`): the GPU backend puts the path into its graph node ids,
	 * so getGpuProfile() and the /dev/graph inspector rows map to layers. Nests with "/".
	 */
	scope<T>(name: string, fn: () => T): T;
	/**
	 * `read` for frame loops: starts the copy now (several may be in flight; nothing is held back
	 * for an earlier one) and resolves a frame later. With `into` the values land in that array
	 * (numel long) instead of a fresh one.
	 */
	readLater(t: Tensor, into?: Float32Array): Promise<Float32Array>;

	// convolutions and products
	conv2d(x: Tensor, w: Tensor, b?: Tensor | null, o?: Conv2dOptions): Tensor;
	convTranspose2d(
		x: Tensor,
		w: Tensor,
		b?: Tensor | null,
		o?: ConvTranspose2dOptions,
	): Tensor;
	deformConv2d(
		x: Tensor,
		offset: Tensor,
		mask: Tensor | null,
		w: Tensor,
		b?: Tensor | null,
		o?: DeformConv2dOptions,
	): Tensor;
	/** x [..., K] · wᵀ [N, K] (+ b [N]) → [..., N] */
	linear(x: Tensor, w: Tensor, b?: Tensor | null): Tensor;
	/** a [..., M, K] · b [..., K, N] (or b [..., N, K] with transposeB); batch dims broadcast */
	matmul(a: Tensor, b: Tensor, o?: { transposeB?: boolean }): Tensor;

	// elementwise (broadcasting, NumPy rules)
	binary(op: BinaryOp, a: TensorOrScalar, b: TensorOrScalar): Tensor;
	add(a: TensorOrScalar, b: TensorOrScalar): Tensor;
	sub(a: TensorOrScalar, b: TensorOrScalar): Tensor;
	mul(a: TensorOrScalar, b: TensorOrScalar): Tensor;
	div(a: TensorOrScalar, b: TensorOrScalar): Tensor;
	maximum(a: TensorOrScalar, b: TensorOrScalar): Tensor;
	minimum(a: TensorOrScalar, b: TensorOrScalar): Tensor;
	compare(
		op: "eq" | "ne" | "gt" | "ge" | "lt" | "le",
		a: TensorOrScalar,
		b: TensorOrScalar,
	): Tensor;
	/** cond != 0 ? a : b */
	where(cond: Tensor, a: TensorOrScalar, b: TensorOrScalar): Tensor;
	scale(x: Tensor, s: number): Tensor;
	clamp(x: Tensor, min: number, max: number): Tensor;
	unary(op: UnaryOp, x: Tensor): Tensor;
	relu(x: Tensor): Tensor;
	/** exact (erf) GELU; `approximate: "tanh"` = geluTanh */
	gelu(x: Tensor, o?: { approximate?: "none" | "tanh" }): Tensor;
	silu(x: Tensor): Tensor;
	sigmoid(x: Tensor): Tensor;
	tanh(x: Tensor): Tensor;
	elu(x: Tensor, alpha?: number): Tensor;
	selu(x: Tensor): Tensor;
	leakyRelu(x: Tensor, slope?: number): Tensor;

	// normalisations
	softmax(x: Tensor, axis?: number): Tensor;
	logSoftmax(x: Tensor, axis?: number): Tensor;
	/** over the last dim; w, b [C] optional */
	layerNorm(
		x: Tensor,
		w?: Tensor | null,
		b?: Tensor | null,
		eps?: number,
	): Tensor;
	/** inference BatchNorm over axis 1 (NCHW / NC) */
	batchNorm(
		x: Tensor,
		mean: Tensor,
		variance: Tensor,
		w?: Tensor | null,
		b?: Tensor | null,
		eps?: number,
	): Tensor;
	groupNorm(
		x: Tensor,
		groups: number,
		w?: Tensor | null,
		b?: Tensor | null,
		eps?: number,
	): Tensor;
	/** x / max(‖x‖₂, eps) along `axis` (F.normalize) */
	l2Normalize(x: Tensor, axis?: number, eps?: number): Tensor;

	// attention
	/** softmax(q kᵀ · scale + mask) v; q [B, H, Nq, D], k [B, H, Nk, D], v [B, H, Nk, Dv] */
	attention(q: Tensor, k: Tensor, v: Tensor, o?: AttentionOptions): Tensor;
	/** x·cos + rotate(x)·sin; cos / sin broadcast to x */
	rotaryEmbed(x: Tensor, cos: Tensor, sin: Tensor, o?: RotaryOptions): Tensor;

	// spatial
	maxPool2d(x: Tensor, o: Pool2dOptions): Tensor;
	avgPool2d(x: Tensor, o: Pool2dOptions): Tensor;
	interpolate(x: Tensor, o: InterpolateOptions): Tensor;
	/** grid [N, Ho, Wo, 2] in [-1, 1] (x, y) → [N, C, Ho, Wo] */
	gridSample(x: Tensor, grid: Tensor, o?: GridSampleOptions): Tensor;
	/** NCHW: x where x equals the max of its (2r+1)² window, else 0 (one simple_nms step) */
	nmsMaxPool(scores: Tensor, radius: number): Tensor;

	// layout
	reshape(x: Tensor, shape: readonly number[]): Tensor;
	permute(x: Tensor, dims: readonly number[]): Tensor;
	transpose(x: Tensor, a: number, b: number): Tensor;
	concat(xs: readonly Tensor[], axis: number): Tensor;
	/** `sizes`: a chunk count (equal parts) or explicit sizes */
	split(x: Tensor, sizes: number | readonly number[], axis: number): Tensor[];
	/** x[start:end:step] along `axis` (end exclusive, negative ends count from the end) */
	slice(
		x: Tensor,
		axis: number,
		start: number,
		end?: number,
		step?: number,
	): Tensor;
	/** index_select: out = x.shape[:axis] + idx.shape + x.shape[axis+1:] */
	gather(x: Tensor, indices: Tensor, axis: number): Tensor;
	/** F.pad order: [left, right] of the last dim, then [top, bottom] of the one before, … */
	pad(x: Tensor, pads: readonly number[], o?: PadOptions): Tensor;
	/** broadcast to `shape` (materialised) */
	expand(x: Tensor, shape: readonly number[]): Tensor;

	// spectral (GPU backend; the CPU reference is src/lib/nn/fft-reference.ts)
	/**
	 * torch.fft.rfft2 over the last two dims (norm "backward"): x [..., H, W] real, H and W powers of two
	 * (2 to 2048) → [..., H, W/2+1, 2] (re, im), like view_as_real.
	 */
	rfft2?(x: Tensor): Tensor;
	/**
	 * torch.fft.irfft2 (norm "backward"): x [..., H, W/2+1, 2] → real [..., H, W]; `width` W defaults to
	 * 2 (Wf - 1).
	 */
	irfft2?(x: Tensor, o?: { width?: number }): Tensor;

	// reductions
	reduce(op: ReduceOp, x: Tensor, axis: number, keepDim?: boolean): Tensor;
	sum(x: Tensor, axis: number, keepDim?: boolean): Tensor;
	mean(x: Tensor, axis: number, keepDim?: boolean): Tensor;
	max(x: Tensor, axis: number, keepDim?: boolean): Tensor;
	min(x: Tensor, axis: number, keepDim?: boolean): Tensor;
	argmax(x: Tensor, axis: number, keepDim?: boolean): Tensor;
	/** largest k along `axis`, sorted descending (ties: lower index first) */
	topk(
		x: Tensor,
		k: number,
		axis?: number,
	): { values: Tensor; indices: Tensor };
}
