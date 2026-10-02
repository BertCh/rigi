// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// BaseNn: the backend-independent half of `Nn`. It validates shapes, resolves options and maps the
// public ops onto a smaller set of primitives (p*) that each backend implements, so the CPU reference
// and the GPU kernels see exactly the same resolved parameters.

import {
	aroundAxis,
	broadcastShapes,
	broadcastStrides,
	type ConvParams,
	convParams,
	interpScale,
	normAxis,
	numel,
	type PoolParams,
	pair,
	poolParams,
	resolveShape,
	stridesOf,
} from "./shape";
import type {
	AttentionOptions,
	BinaryOp,
	Conv2dOptions,
	ConvTranspose2dOptions,
	DeformConv2dOptions,
	GridSampleOptions,
	InterpolateOptions,
	Nn,
	NnBackend,
	PadOptions,
	Pool2dOptions,
	ReduceOp,
	RotaryOptions,
	Tensor,
	TensorOrScalar,
	UnaryOp,
	Weights,
} from "./types";

/** Unary ops plus the parameterised ones the public API maps onto them (alpha, beta). */
export type UnaryPrim =
	| UnaryOp
	| "leakyRelu" // alpha = slope
	| "eluA" // alpha
	| "clamp" // [alpha, beta]
	| "affine"; // x·alpha + beta

export type MatmulParams = {
	/** output batch shape (broadcast of both inputs' batch dims) */
	batch: number[];
	/** per batch dim, the element stride of a's / b's matrix (0 = broadcast) */
	aBatchStrides: number[];
	bBatchStrides: number[];
	M: number;
	N: number;
	K: number;
	transB: boolean;
};

export type AttentionParams = {
	B: number;
	H: number;
	Nq: number;
	Nk: number;
	D: number;
	Dv: number;
	scale: number;
	/** mask strides over [B, H, Nq, Nk] (broadcast = 0) */
	maskStrides: [number, number, number, number] | null;
};

export type InterpParams = {
	N: number;
	C: number;
	H: number;
	W: number;
	Ho: number;
	Wo: number;
	mode: "nearest" | "bilinear" | "bicubic";
	alignCorners: boolean;
	/** source coordinate per output step (see interpScale) */
	scaleH: number;
	scaleW: number;
};

export type GridSampleParams = {
	N: number;
	C: number;
	H: number;
	W: number;
	Ho: number;
	Wo: number;
	mode: "bilinear" | "nearest";
	padding: "zeros" | "border";
	alignCorners: boolean;
};

export type ReducePrim = ReduceOp | "argmax";

/** Erf (Abramowitz & Stegun 7.1.26 refined: max abs error 1.2e-7), same formula as the WGSL. */
export function erf(x: number): number {
	const s = x < 0 ? -1 : 1;
	const a = Math.abs(x);
	const t = 1 / (1 + 0.5 * a);
	// Numerical Recipes erfc (Chebyshev), fractional error < 1.2e-7
	const y =
		t *
		Math.exp(
			-a * a -
				1.26551223 +
				t *
					(1.00002368 +
						t *
							(0.37409196 +
								t *
									(0.09678418 +
										t *
											(-0.18628806 +
												t *
													(0.27886807 +
														t *
															(-1.13520398 +
																t *
																	(1.48851587 +
																		t * (-0.82215223 + t * 0.17087277)))))))),
		);
	return s * (1 - y);
}

export abstract class BaseNn<T extends Tensor = Tensor> implements Nn {
	abstract readonly backend: NnBackend;
	abstract loadWeights(
		file: string,
		opts?: {
			signal?: AbortSignal;
			onProgress?: (loaded: number, total: number) => void;
		},
	): Promise<Weights>;
	abstract weightsFromBytes(bytes: ArrayBuffer | Uint8Array): Weights;
	abstract fromArray(
		data: Float32Array | readonly number[],
		shape: readonly number[],
	): T;
	abstract read(t: Tensor): Promise<Float32Array>;
	abstract dispose(t: Tensor | Weights | readonly Tensor[]): void;
	abstract forward<R>(fn: () => R): Promise<R>;

	// ---- primitives -------------------------------------------------------------------------
	abstract pFull(shape: number[], value: number): T;
	abstract pConv(x: T, w: T, b: T | null, p: ConvParams, transpose: boolean): T;
	abstract pDeform(
		x: T,
		offset: T,
		mask: T | null,
		w: T,
		b: T | null,
		p: ConvParams,
	): T;
	abstract pMatmul(a: T, b: T, bias: T | null, p: MatmulParams): T;
	abstract pBinary(
		op: BinaryOp,
		a: T | number,
		b: T | number,
		out: number[],
	): T;
	abstract pWhere(c: T, a: T | number, b: T | number, out: number[]): T;
	abstract pUnary(op: UnaryPrim, x: T, alpha: number, beta: number): T;
	abstract pSoftmax(
		x: T,
		outer: number,
		len: number,
		inner: number,
		log: boolean,
	): T;
	abstract pLayerNorm(
		x: T,
		w: T | null,
		b: T | null,
		rows: number,
		C: number,
		eps: number,
	): T;
	abstract pGroupNorm(
		x: T,
		w: T | null,
		b: T | null,
		N: number,
		C: number,
		G: number,
		inner: number,
		eps: number,
	): T;
	abstract pL2Norm(
		x: T,
		outer: number,
		len: number,
		inner: number,
		eps: number,
	): T;
	abstract pAttention(q: T, k: T, v: T, mask: T | null, p: AttentionParams): T;
	abstract pRotary(
		x: T,
		cos: T,
		sin: T,
		interleaved: boolean,
		cosStrides: number[],
		sinStrides: number[],
	): T;
	abstract pPool(kind: "max" | "avg", x: T, p: PoolParams): T;
	abstract pInterpolate(x: T, p: InterpParams): T;
	abstract pGridSample(x: T, grid: T, p: GridSampleParams): T;
	abstract pNms(x: T, radius: number): T;
	/** zero-copy reshape */
	abstract pView(x: T, shape: number[]): T;
	/** out[i…] = x[offset + Σ i_d·strides_d] */
	abstract pCopy(x: T, out: number[], strides: number[], offset: number): T;
	abstract pConcat(xs: T[], axis: number, out: number[]): T;
	abstract pGather(
		x: T,
		idx: T,
		outer: number,
		len: number,
		inner: number,
		out: number[],
	): T;
	/** pads[d] = [before, after] per dim */
	abstract pPad(
		x: T,
		pads: [number, number][],
		mode: "constant" | "reflect" | "replicate",
		value: number,
		out: number[],
	): T;
	abstract pReduce(
		op: ReducePrim,
		x: T,
		outer: number,
		len: number,
		inner: number,
		out: number[],
	): T;
	abstract pTopk(
		x: T,
		rows: number,
		len: number,
		k: number,
		out: number[],
	): { values: T; indices: T };

	// ---- public API -------------------------------------------------------------------------
	zeros(shape: readonly number[]): T {
		return this.pFull([...shape], 0);
	}
	full(shape: readonly number[], value: number): T {
		return this.pFull([...shape], value);
	}

	conv2d(x: Tensor, w: Tensor, b?: Tensor | null, o: Conv2dOptions = {}): T {
		const p = convParams(x.shape, w.shape, o);
		this.checkBias(b, p.Cout);
		return this.pConv(x as T, w as T, (b ?? null) as T | null, p, false);
	}
	convTranspose2d(
		x: Tensor,
		w: Tensor,
		b?: Tensor | null,
		o: ConvTranspose2dOptions = {},
	): T {
		const p = convParams(x.shape, w.shape, o, true);
		this.checkBias(b, p.Cout);
		return this.pConv(x as T, w as T, (b ?? null) as T | null, p, true);
	}
	deformConv2d(
		x: Tensor,
		offset: Tensor,
		mask: Tensor | null,
		w: Tensor,
		b?: Tensor | null,
		o: DeformConv2dOptions = {},
	): T {
		const p = convParams(x.shape, w.shape, o);
		this.checkBias(b, p.Cout);
		const kk = p.kh * p.kw * p.dg;
		const want = (c: number) => [p.N, c, p.Ho, p.Wo].join(",");
		if (offset.shape.join(",") !== want(2 * kk))
			throw new Error(
				`nn: deformConv2d offset [${offset.shape.join(",")}], want [${want(2 * kk)}]`,
			);
		if (mask && mask.shape.join(",") !== want(kk))
			throw new Error(`nn: deformConv2d mask [${mask.shape.join(",")}]`);
		if (p.Cin % p.dg) throw new Error("nn: Cin not divisible by offsetGroups");
		return this.pDeform(
			x as T,
			offset as T,
			mask as T | null,
			w as T,
			(b ?? null) as T | null,
			p,
		);
	}
	private checkBias(b: Tensor | null | undefined, C: number) {
		if (b && numel(b.shape) !== C)
			throw new Error(`nn: bias [${b.shape.join(",")}], want ${C}`);
	}

	linear(x: Tensor, w: Tensor, b?: Tensor | null): T {
		if (w.shape.length !== 2) throw new Error("nn: linear weight must be 2-D");
		const [N, K] = w.shape;
		const xs = x.shape;
		if (xs[xs.length - 1] !== K)
			throw new Error(
				`nn: linear x [${xs.join(",")}] vs weight [${w.shape.join(",")}]`,
			);
		this.checkBias(b, N);
		const M = numel(xs) / K;
		const y = this.pMatmul(x as T, w as T, (b ?? null) as T | null, {
			batch: [],
			aBatchStrides: [],
			bBatchStrides: [],
			M,
			N,
			K,
			transB: true,
		});
		return this.pView(y, [...xs.slice(0, -1), N]);
	}

	matmul(a: Tensor, b: Tensor, o: { transposeB?: boolean } = {}): T {
		if (a.shape.length < 2 || b.shape.length < 2)
			throw new Error("nn: matmul needs rank ≥ 2");
		const transB = !!o.transposeB;
		const [M, K] = a.shape.slice(-2);
		const bk = transB
			? b.shape[b.shape.length - 1]
			: b.shape[b.shape.length - 2];
		const N = transB
			? b.shape[b.shape.length - 2]
			: b.shape[b.shape.length - 1];
		if (bk !== K)
			throw new Error(
				`nn: matmul [${a.shape.join(",")}]·[${b.shape.join(",")}]${transB ? "ᵀ" : ""}`,
			);
		const ab = a.shape.slice(0, -2);
		const bb = b.shape.slice(0, -2);
		const batch = broadcastShapes(ab, bb);
		const bs = (s: number[], mat: number) =>
			broadcastStrides(s, batch).map((v) => v * mat);
		const p: MatmulParams = {
			batch,
			aBatchStrides: bs(ab, M * K),
			bBatchStrides: bs(bb, K * N),
			M,
			N,
			K,
			transB,
		};
		return this.pMatmul(a as T, b as T, null, p);
	}

	binary(op: BinaryOp, a: TensorOrScalar, b: TensorOrScalar): T {
		if (typeof a === "number" && typeof b === "number")
			throw new Error("nn: binary op on two scalars");
		const out =
			typeof a === "number"
				? [...(b as Tensor).shape]
				: typeof b === "number"
					? [...a.shape]
					: broadcastShapes(a.shape, b.shape);
		return this.pBinary(op, a as T | number, b as T | number, out);
	}
	add(a: TensorOrScalar, b: TensorOrScalar) {
		return this.binary("add", a, b);
	}
	sub(a: TensorOrScalar, b: TensorOrScalar) {
		return this.binary("sub", a, b);
	}
	mul(a: TensorOrScalar, b: TensorOrScalar) {
		return this.binary("mul", a, b);
	}
	div(a: TensorOrScalar, b: TensorOrScalar) {
		return this.binary("div", a, b);
	}
	maximum(a: TensorOrScalar, b: TensorOrScalar) {
		return this.binary("max", a, b);
	}
	minimum(a: TensorOrScalar, b: TensorOrScalar) {
		return this.binary("min", a, b);
	}
	compare(
		op: "eq" | "ne" | "gt" | "ge" | "lt" | "le",
		a: TensorOrScalar,
		b: TensorOrScalar,
	) {
		return this.binary(op, a, b);
	}
	where(cond: Tensor, a: TensorOrScalar, b: TensorOrScalar): T {
		let out = [...cond.shape];
		if (typeof a !== "number") out = broadcastShapes(out, a.shape);
		if (typeof b !== "number") out = broadcastShapes(out, b.shape);
		return this.pWhere(cond as T, a as T | number, b as T | number, out);
	}
	scale(x: Tensor, s: number) {
		return this.pUnary("affine", x as T, s, 0);
	}
	clamp(x: Tensor, min: number, max: number) {
		return this.pUnary("clamp", x as T, min, max);
	}
	unary(op: UnaryOp, x: Tensor) {
		return this.pUnary(op, x as T, 0, 0);
	}
	relu(x: Tensor) {
		return this.unary("relu", x);
	}
	gelu(x: Tensor, o: { approximate?: "none" | "tanh" } = {}) {
		return this.unary(o.approximate === "tanh" ? "geluTanh" : "gelu", x);
	}
	silu(x: Tensor) {
		return this.unary("silu", x);
	}
	sigmoid(x: Tensor) {
		return this.unary("sigmoid", x);
	}
	tanh(x: Tensor) {
		return this.unary("tanh", x);
	}
	elu(x: Tensor, alpha = 1) {
		return this.pUnary("eluA", x as T, alpha, 0);
	}
	selu(x: Tensor) {
		return this.unary("selu", x);
	}
	leakyRelu(x: Tensor, slope = 0.01) {
		return this.pUnary("leakyRelu", x as T, slope, 0);
	}

	softmax(x: Tensor, axis = -1) {
		const r = aroundAxis(x.shape, axis);
		return this.pSoftmax(x as T, r.outer, r.len, r.inner, false);
	}
	logSoftmax(x: Tensor, axis = -1) {
		const r = aroundAxis(x.shape, axis);
		return this.pSoftmax(x as T, r.outer, r.len, r.inner, true);
	}
	layerNorm(x: Tensor, w?: Tensor | null, b?: Tensor | null, eps = 1e-5) {
		const C = x.shape[x.shape.length - 1];
		this.checkBias(w, C);
		this.checkBias(b, C);
		return this.pLayerNorm(
			x as T,
			(w ?? null) as T | null,
			(b ?? null) as T | null,
			numel(x.shape) / C,
			C,
			eps,
		);
	}
	batchNorm(
		x: Tensor,
		mean: Tensor,
		variance: Tensor,
		w?: Tensor | null,
		b?: Tensor | null,
		eps = 1e-5,
	): T {
		const C = x.shape[1];
		const bshape = [C, ...x.shape.slice(2).map(() => 1)];
		const v = (t: Tensor) => this.pView(t as T, bshape);
		let y = this.mul(
			this.sub(x, v(mean)),
			this.unary("rsqrt", this.add(v(variance), eps)),
		);
		if (w) y = this.mul(y, v(w));
		if (b) y = this.add(y, v(b));
		return y;
	}
	groupNorm(
		x: Tensor,
		groups: number,
		w?: Tensor | null,
		b?: Tensor | null,
		eps = 1e-5,
	) {
		const [N, C] = x.shape;
		if (C % groups) throw new Error("nn: groupNorm C % groups");
		this.checkBias(w, C);
		this.checkBias(b, C);
		const inner = numel(x.shape.slice(2));
		return this.pGroupNorm(
			x as T,
			(w ?? null) as T | null,
			(b ?? null) as T | null,
			N,
			C,
			groups,
			inner,
			eps,
		);
	}
	l2Normalize(x: Tensor, axis = 1, eps = 1e-12) {
		const r = aroundAxis(x.shape, axis);
		return this.pL2Norm(x as T, r.outer, r.len, r.inner, eps);
	}

	attention(q: Tensor, k: Tensor, v: Tensor, o: AttentionOptions = {}): T {
		if (q.shape.length !== 4 || k.shape.length !== 4 || v.shape.length !== 4)
			throw new Error("nn: attention expects [B, H, N, D]");
		const [B, H, Nq, D] = q.shape;
		const [kb, kh, Nk, kd] = k.shape;
		const [vb, vh, vn, Dv] = v.shape;
		if (kb !== B || vb !== B || kh !== H || vh !== H || kd !== D || vn !== Nk)
			throw new Error(
				`nn: attention q [${q.shape}] k [${k.shape}] v [${v.shape}]`,
			);
		let maskStrides: AttentionParams["maskStrides"] = null;
		if (o.mask) {
			const full = [B, H, Nq, Nk];
			broadcastShapes(o.mask.shape, full);
			maskStrides = broadcastStrides(o.mask.shape, full) as [
				number,
				number,
				number,
				number,
			];
		}
		return this.pAttention(
			q as T,
			k as T,
			v as T,
			(o.mask ?? null) as T | null,
			{
				B,
				H,
				Nq,
				Nk,
				D,
				Dv,
				scale: o.scale ?? 1 / Math.sqrt(D),
				maskStrides,
			},
		);
	}
	rotaryEmbed(x: Tensor, cos: Tensor, sin: Tensor, o: RotaryOptions = {}) {
		const out = [...x.shape];
		if (broadcastShapes(cos.shape, out).join() !== out.join())
			throw new Error("nn: rotary cos does not broadcast to x");
		if (broadcastShapes(sin.shape, out).join() !== out.join())
			throw new Error("nn: rotary sin does not broadcast to x");
		if (out[out.length - 1] % 2) throw new Error("nn: rotary needs even D");
		return this.pRotary(
			x as T,
			cos as T,
			sin as T,
			o.interleaved ?? true,
			broadcastStrides(cos.shape, out),
			broadcastStrides(sin.shape, out),
		);
	}

	maxPool2d(x: Tensor, o: Pool2dOptions) {
		return this.pPool("max", x as T, poolParams(x.shape, o));
	}
	avgPool2d(x: Tensor, o: Pool2dOptions) {
		return this.pPool("avg", x as T, poolParams(x.shape, o));
	}
	interpolate(x: Tensor, o: InterpolateOptions): T {
		if (x.shape.length !== 4) throw new Error("nn: interpolate expects NCHW");
		const [N, C, H, W] = x.shape;
		const ac = o.mode !== "nearest" && !!o.alignCorners;
		let Ho: number;
		let Wo: number;
		let sfh: number | undefined;
		let sfw: number | undefined;
		if (o.size) [Ho, Wo] = o.size;
		else if (o.scale !== undefined) {
			[sfh, sfw] = pair(o.scale, 1);
			Ho = Math.floor(H * sfh);
			Wo = Math.floor(W * sfw);
		} else throw new Error("nn: interpolate needs size or scale");
		return this.pInterpolate(x as T, {
			N,
			C,
			H,
			W,
			Ho,
			Wo,
			mode: o.mode,
			alignCorners: ac,
			scaleH: interpScale(H, Ho, ac, sfh),
			scaleW: interpScale(W, Wo, ac, sfw),
		});
	}
	gridSample(x: Tensor, grid: Tensor, o: GridSampleOptions = {}): T {
		const [N, C, H, W] = x.shape;
		const [gn, Ho, Wo, two] = grid.shape;
		if (x.shape.length !== 4 || gn !== N || two !== 2)
			throw new Error(`nn: gridSample x [${x.shape}] grid [${grid.shape}]`);
		return this.pGridSample(x as T, grid as T, {
			N,
			C,
			H,
			W,
			Ho,
			Wo,
			mode: o.mode ?? "bilinear",
			padding: o.padding ?? "zeros",
			alignCorners: !!o.alignCorners,
		});
	}
	nmsMaxPool(scores: Tensor, radius: number) {
		if (scores.shape.length !== 4)
			throw new Error("nn: nmsMaxPool expects NCHW");
		return this.pNms(scores as T, radius);
	}

	reshape(x: Tensor, shape: readonly number[]) {
		return this.pView(x as T, resolveShape(x.shape, shape));
	}
	permute(x: Tensor, dims: readonly number[]): T {
		const r = x.shape.length;
		if (dims.length !== r) throw new Error("nn: permute rank");
		const d = dims.map((v) => normAxis(v, r));
		if (new Set(d).size !== r) throw new Error("nn: permute dims");
		if (d.every((v, i) => v === i)) return this.pView(x as T, [...x.shape]);
		const s = stridesOf(x.shape);
		return this.pCopy(
			x as T,
			d.map((v) => x.shape[v]),
			d.map((v) => s[v]),
			0,
		);
	}
	transpose(x: Tensor, a: number, b: number) {
		const r = x.shape.length;
		const d = [...Array(r).keys()];
		const i = normAxis(a, r);
		const j = normAxis(b, r);
		[d[i], d[j]] = [d[j], d[i]];
		return this.permute(x, d);
	}
	concat(xs: readonly Tensor[], axis: number): T {
		if (!xs.length) throw new Error("nn: concat of nothing");
		const r = xs[0].shape.length;
		const a = normAxis(axis, r);
		const out = [...xs[0].shape];
		out[a] = 0;
		for (const x of xs) {
			if (
				x.shape.length !== r ||
				x.shape.some((v, i) => i !== a && v !== xs[0].shape[i])
			)
				throw new Error("nn: concat shapes");
			out[a] += x.shape[a];
		}
		return this.pConcat(xs as T[], a, out);
	}
	split(x: Tensor, sizes: number | readonly number[], axis: number): T[] {
		const a = normAxis(axis, x.shape.length);
		const n = x.shape[a];
		let parts: number[];
		if (typeof sizes === "number") {
			// torch.chunk: ceil-sized chunks
			const c = Math.ceil(n / sizes);
			parts = [];
			for (let s = 0; s < n; s += c) parts.push(Math.min(c, n - s));
		} else parts = [...sizes];
		if (parts.reduce((p, v) => p + v, 0) !== n)
			throw new Error("nn: split sizes");
		const out: T[] = [];
		let s = 0;
		for (const p of parts) {
			out.push(this.slice(x, a, s, s + p));
			s += p;
		}
		return out;
	}
	slice(x: Tensor, axis: number, start: number, end?: number, step = 1): T {
		const a = normAxis(axis, x.shape.length);
		const n = x.shape[a];
		const norm = (v: number) => Math.min(n, Math.max(0, v < 0 ? v + n : v));
		const s0 = norm(start);
		const e0 = end === undefined ? n : norm(end);
		if (step < 1) throw new Error("nn: slice step must be ≥ 1");
		const count = Math.max(0, Math.ceil((e0 - s0) / step));
		const st = stridesOf(x.shape);
		const out = [...x.shape];
		out[a] = count;
		const strides = [...st];
		strides[a] = st[a] * step;
		// leading-axis contiguous slices could be views; a copy keeps storage ownership simple
		return this.pCopy(x as T, out, strides, s0 * st[a]);
	}
	gather(x: Tensor, indices: Tensor, axis: number): T {
		const r = aroundAxis(x.shape, axis);
		const out = [
			...x.shape.slice(0, r.axis),
			...indices.shape,
			...x.shape.slice(r.axis + 1),
		];
		return this.pGather(x as T, indices as T, r.outer, r.len, r.inner, out);
	}
	pad(x: Tensor, pads: readonly number[], o: PadOptions = {}): T {
		const r = x.shape.length;
		if (pads.length % 2 || pads.length / 2 > r)
			throw new Error("nn: pad length");
		const per: [number, number][] = x.shape.map(() => [0, 0]);
		for (let i = 0; i < pads.length / 2; i++)
			per[r - 1 - i] = [pads[2 * i], pads[2 * i + 1]];
		const mode = o.mode ?? "constant";
		const out = x.shape.map((v, d) => v + per[d][0] + per[d][1]);
		if (mode === "reflect")
			per.forEach(([b, e], d) => {
				if (b >= x.shape[d] || e >= x.shape[d])
					throw new Error("nn: reflect pad ≥ dim");
			});
		if (per.some(([b, e]) => b < 0 || e < 0))
			throw new Error("nn: negative pad (use slice)");
		return this.pPad(x as T, per, mode, o.value ?? 0, out);
	}
	expand(x: Tensor, shape: readonly number[]): T {
		const out = [...shape];
		if (broadcastShapes(x.shape, out).join() !== out.join())
			throw new Error("nn: expand");
		return this.pCopy(x as T, out, broadcastStrides(x.shape, out), 0);
	}

	reduce(op: ReduceOp, x: Tensor, axis: number, keepDim = false): T {
		return this.reduceImpl(op, x, axis, keepDim);
	}
	private reduceImpl(
		op: ReducePrim,
		x: Tensor,
		axis: number,
		keepDim: boolean,
	): T {
		const r = aroundAxis(x.shape, axis);
		const out = [...x.shape];
		if (keepDim) out[r.axis] = 1;
		else out.splice(r.axis, 1);
		return this.pReduce(op, x as T, r.outer, r.len, r.inner, out);
	}
	sum(x: Tensor, axis: number, keepDim = false) {
		return this.reduceImpl("sum", x, axis, keepDim);
	}
	mean(x: Tensor, axis: number, keepDim = false) {
		return this.reduceImpl("mean", x, axis, keepDim);
	}
	max(x: Tensor, axis: number, keepDim = false) {
		return this.reduceImpl("max", x, axis, keepDim);
	}
	min(x: Tensor, axis: number, keepDim = false) {
		return this.reduceImpl("min", x, axis, keepDim);
	}
	argmax(x: Tensor, axis: number, keepDim = false) {
		return this.reduceImpl("argmax", x, axis, keepDim);
	}
	topk(x: Tensor, k: number, axis = -1): { values: T; indices: T } {
		const r = x.shape.length;
		const a = normAxis(axis, r);
		const len = x.shape[a];
		if (k < 1 || k > len) throw new Error(`nn: topk k=${k} of ${len}`);
		// k = 1 is max / argmax along the axis: no transpose, no sort (ties: lower index, as topk)
		if (k === 1)
			return {
				values: this.reduceImpl("max", x, a, true),
				indices: this.reduceImpl("argmax", x, a, true),
			};
		const last = a === r - 1;
		const xt = last ? (x as T) : this.transpose(x, a, r - 1);
		const lastShape = [...xt.shape.slice(0, -1), k];
		const res = this.pTopk(xt, numel(xt.shape) / len, len, k, lastShape);
		if (last) return res;
		return {
			values: this.transpose(res.values, a, r - 1),
			indices: this.transpose(res.indices, a, r - 1),
		};
	}
}
