// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The CPU reference backend: plain Float32Array loops, eager, correct and simple. It is the oracle
// for the GPU kernels (nn.check.ts) and the no-WebGPU fallback. Accumulation is in f64 (JS numbers)
// unless noted, so it is at least as accurate as the f32 GPU kernels.

import {
	type AttentionParams,
	BaseNn,
	erf,
	type GridSampleParams,
	type InterpParams,
	type MatmulParams,
	type ReducePrim,
	type UnaryPrim,
} from "./base";
import { conv2dFast, conv2dReference, convTranspose2dFast } from "./cpu-conv";
import {
	binarySameShape,
	matmulTiled,
	padConstantRows,
	poolInside,
	reluInto,
	resizeFast,
} from "./cpu-fast";
import { fetchModel } from "./fetch";
import { dequantize, splitQuantized } from "./quant";
import { entryF32, parseSafetensors } from "./safetensors";
import {
	type ConvParams,
	cubicWeights,
	numel,
	type PoolParams,
	stridesOf,
} from "./shape";
import type { BinaryOp, NnBackend, Tensor, Weights } from "./types";

export class CpuTensor implements Tensor {
	readonly dtype = "f32" as const;
	constructor(
		readonly shape: readonly number[],
		public data: Float32Array,
	) {}
}

class CpuWeights implements Weights {
	constructor(
		private map: Map<string, CpuTensor>,
		readonly metadata: Record<string, string>,
	) {}
	get names() {
		return [...this.map.keys()];
	}
	has(name: string) {
		return this.map.has(name);
	}
	get(name: string): CpuTensor {
		const t = this.map.get(name);
		if (!t) throw new Error(`nn: no weight "${name}"`);
		return t;
	}
}

const t = (shape: readonly number[], data?: Float32Array) =>
	new CpuTensor([...shape], data ?? new Float32Array(numel(shape)));

const SELU_A = 1.6732632423543772;
const SELU_S = 1.0507009873554805;

export function unaryFn(
	op: UnaryPrim,
	alpha: number,
	beta: number,
): (v: number) => number {
	switch (op) {
		case "relu":
			return (v) => (v > 0 ? v : 0);
		case "gelu":
			return (v) => 0.5 * v * (1 + erf(v / Math.SQRT2));
		case "geluTanh":
			return (v) =>
				0.5 *
				v *
				(1 + Math.tanh(0.7978845608028654 * (v + 0.044715 * v * v * v)));
		case "silu":
			return (v) => v / (1 + Math.exp(-v));
		case "sigmoid":
			return (v) => 1 / (1 + Math.exp(-v));
		case "tanh":
			return Math.tanh;
		case "elu":
			return (v) => (v > 0 ? v : Math.expm1(v));
		case "eluA":
			return (v) => (v > 0 ? v : alpha * Math.expm1(v));
		case "selu":
			return (v) => SELU_S * (v > 0 ? v : SELU_A * Math.expm1(v));
		case "softplus":
			return (v) => (v > 20 ? v : Math.log1p(Math.exp(v)));
		case "logSigmoid":
			return (v) => Math.min(v, 0) - Math.log1p(Math.exp(-Math.abs(v)));
		case "exp":
			return Math.exp;
		case "log":
			return Math.log;
		case "sqrt":
			return Math.sqrt;
		case "rsqrt":
			return (v) => 1 / Math.sqrt(v);
		case "abs":
			return Math.abs;
		case "neg":
			return (v) => -v;
		case "square":
			return (v) => v * v;
		case "recip":
			return (v) => 1 / v;
		case "floor":
			return Math.floor;
		case "round":
			// torch.round: half to even
			return (v) => {
				const r = Math.round(v);
				return Math.abs(v % 1) === 0.5 && r % 2 ? r - 1 : r;
			};
		case "leakyRelu":
			return (v) => (v > 0 ? v : alpha * v);
		case "clamp":
			return (v) => Math.min(beta, Math.max(alpha, v));
		case "affine":
			return (v) => v * alpha + beta;
	}
}

export function binaryFn(op: BinaryOp): (a: number, b: number) => number {
	switch (op) {
		case "add":
			return (a, b) => a + b;
		case "sub":
			return (a, b) => a - b;
		case "mul":
			return (a, b) => a * b;
		case "div":
			return (a, b) => a / b;
		case "max":
			return (a, b) => (a > b || Number.isNaN(a) ? a : b);
		case "min":
			return (a, b) => (a < b || Number.isNaN(a) ? a : b);
		case "pow":
			return (a, b) => a ** b;
		case "eq":
			return (a, b) => +(a === b);
		case "ne":
			return (a, b) => +(a !== b);
		case "gt":
			return (a, b) => +(a > b);
		case "ge":
			return (a, b) => +(a >= b);
		case "lt":
			return (a, b) => +(a < b);
		case "le":
			return (a, b) => +(a <= b);
	}
}

/** Visits every index of `shape` in row-major order with the matching offset for each stride set. */
function forEachStrided(
	shape: readonly number[],
	strideSets: readonly (readonly number[])[],
	fn: (i: number, offs: number[]) => void,
) {
	const r = shape.length;
	const n = numel(shape);
	const idx = new Array<number>(r).fill(0);
	const offs = strideSets.map(() => 0);
	for (let i = 0; i < n; i++) {
		fn(i, offs);
		for (let d = r - 1; d >= 0; d--) {
			idx[d]++;
			for (let s = 0; s < strideSets.length; s++) offs[s] += strideSets[s][d];
			if (idx[d] < shape[d]) break;
			for (let s = 0; s < strideSets.length; s++)
				offs[s] -= strideSets[s][d] * shape[d];
			idx[d] = 0;
		}
	}
}

function bstrides(shape: readonly number[], out: readonly number[]) {
	const s = stridesOf(shape);
	const r = out.length;
	const res = new Array<number>(r).fill(0);
	for (let i = 0; i < shape.length; i++) {
		const o = r - shape.length + i;
		res[o] = shape[i] === 1 && out[o] !== 1 ? 0 : s[i];
	}
	return res;
}

export class CpuNn extends BaseNn<CpuTensor> {
	readonly backend: NnBackend = { kind: "cpu", f16: false };

	async loadWeights(
		file: string,
		opts: {
			signal?: AbortSignal;
			onProgress?: (loaded: number, total: number) => void;
		} = {},
	): Promise<Weights> {
		return this.weightsFromBytes(await fetchModel(file, opts));
	}
	weightsFromBytes(bytes: ArrayBuffer | Uint8Array): Weights {
		const st = parseSafetensors(bytes);
		const { plain, quantized } = splitQuantized(st.entries, st.metadata);
		const map = new Map<string, CpuTensor>();
		for (const e of plain) map.set(e.name, t(e.shape, entryF32(e)));
		for (const { name, info, q, scale } of quantized)
			map.set(name, t(info.shape, dequantize(q, entryF32(scale), info)));
		return new CpuWeights(map, st.metadata);
	}
	fromArray(
		data: Float32Array | readonly number[],
		shape: readonly number[],
	): CpuTensor {
		if (data.length !== numel(shape))
			throw new Error(
				`nn: fromArray ${data.length} values for [${shape.join(",")}]`,
			);
		return t(shape, Float32Array.from(data));
	}
	async read(x: Tensor): Promise<Float32Array> {
		return (x as CpuTensor).data.slice();
	}
	dispose(): void {
		// garbage collected
	}
	async forward<R>(fn: () => R): Promise<R> {
		return fn();
	}

	pFull(shape: number[], value: number) {
		const o = t(shape);
		o.data.fill(value);
		return o;
	}

	/** Fast paths (cpu-conv.ts, cpu-fast.ts); false selects the naive loops (the spec oracle). */
	fastConv = true;

	pConv(
		x: CpuTensor,
		w: CpuTensor,
		b: CpuTensor | null,
		p: ConvParams,
		transpose: boolean,
	): CpuTensor {
		const {
			N,
			Cin,
			H,
			W,
			Cout,
			kh,
			kw,
			sh,
			sw,
			ph,
			pw,
			dh,
			dw,
			groups,
			Ho,
			Wo,
		} = p;
		const X = x.data;
		const Wt = w.data;
		const cig = Cin / groups;
		const cog = Cout / groups;
		if (!transpose) {
			const O = (this.fastConv ? conv2dFast : conv2dReference)(
				X,
				Wt,
				b ? b.data : null,
				p,
			);
			return t([N, Cout, Ho, Wo], O);
		}
		if (this.fastConv && groups === 1)
			return t(
				[N, Cout, Ho, Wo],
				convTranspose2dFast(X, Wt, b ? b.data : null, p),
			);
		// transpose: scatter each input pixel through the kernel (the reference)
		const out = t([N, Cout, Ho, Wo]);
		const O = out.data;
		const acc = new Float64Array(N * Cout * Ho * Wo);
		for (let n = 0; n < N; n++)
			for (let ci = 0; ci < Cin; ci++) {
				const g = Math.floor(ci / cig);
				for (let iy = 0; iy < H; iy++)
					for (let ix = 0; ix < W; ix++) {
						const xv = X[((n * Cin + ci) * H + iy) * W + ix];
						for (let cl = 0; cl < cog; cl++) {
							const co = g * cog + cl;
							for (let ky = 0; ky < kh; ky++) {
								const oy = iy * sh - ph + ky * dh;
								if (oy < 0 || oy >= Ho) continue;
								for (let kx = 0; kx < kw; kx++) {
									const ox = ix * sw - pw + kx * dw;
									if (ox < 0 || ox >= Wo) continue;
									acc[((n * Cout + co) * Ho + oy) * Wo + ox] +=
										xv * Wt[((ci * cog + cl) * kh + ky) * kw + kx];
								}
							}
						}
					}
			}
		for (let i = 0; i < acc.length; i++)
			O[i] = acc[i] + (b ? b.data[Math.floor(i / (Ho * Wo)) % Cout] : 0);
		return out;
	}

	pDeform(
		x: CpuTensor,
		offset: CpuTensor,
		mask: CpuTensor | null,
		w: CpuTensor,
		b: CpuTensor | null,
		p: ConvParams,
	): CpuTensor {
		const {
			N,
			Cin,
			H,
			W,
			Cout,
			kh,
			kw,
			sh,
			sw,
			ph,
			pw,
			dh,
			dw,
			groups,
			Ho,
			Wo,
			dg,
		} = p;
		const X = x.data;
		const OF = offset.data;
		const M = mask?.data;
		const cig = Cin / groups;
		const cog = Cout / groups;
		const cpg = Cin / dg; // channels per offset group
		const K = kh * kw;
		const out = t([N, Cout, Ho, Wo]);
		// torchvision bilinear: zero outside, partial corners inside (-1, H) × (-1, W)
		const sample = (base: number, y: number, xx: number) => {
			if (y <= -1 || y >= H || xx <= -1 || xx >= W) return 0;
			const y0 = Math.floor(y);
			const x0 = Math.floor(xx);
			const ly = y - y0;
			const lx = xx - x0;
			let v = 0;
			const at = (yy: number, xc: number) =>
				yy >= 0 && yy < H && xc >= 0 && xc < W ? X[base + yy * W + xc] : 0;
			v += (1 - ly) * (1 - lx) * at(y0, x0);
			v += (1 - ly) * lx * at(y0, x0 + 1);
			v += ly * (1 - lx) * at(y0 + 1, x0);
			v += ly * lx * at(y0 + 1, x0 + 1);
			return v;
		};
		const col = new Float64Array(Cin * K);
		for (let n = 0; n < N; n++)
			for (let oy = 0; oy < Ho; oy++)
				for (let ox = 0; ox < Wo; ox++) {
					for (let ci = 0; ci < Cin; ci++) {
						const g = Math.floor(ci / cpg);
						for (let k = 0; k < K; k++) {
							const ky = Math.floor(k / kw);
							const kx = k % kw;
							const oc =
								(n * 2 * dg * K + (g * K + k) * 2) * Ho * Wo + oy * Wo + ox;
							const offy = OF[oc];
							const offx = OF[oc + Ho * Wo];
							const m = M
								? M[((n * dg + g) * K + k) * Ho * Wo + oy * Wo + ox]
								: 1;
							const y = oy * sh - ph + ky * dh + offy;
							const xx = ox * sw - pw + kx * dw + offx;
							col[ci * K + k] = m * sample((n * Cin + ci) * H * W, y, xx);
						}
					}
					for (let co = 0; co < Cout; co++) {
						const g = Math.floor(co / cog);
						let s = b ? b.data[co] : 0;
						const wb = co * cig * K;
						const cb = g * cig * K;
						for (let j = 0; j < cig * K; j++) s += w.data[wb + j] * col[cb + j];
						out.data[((n * Cout + co) * Ho + oy) * Wo + ox] = s;
					}
				}
		return out;
	}

	pMatmul(
		a: CpuTensor,
		b: CpuTensor,
		bias: CpuTensor | null,
		p: MatmulParams,
	): CpuTensor {
		const { batch, aBatchStrides, bBatchStrides, M, N, K, transB } = p;
		const out = t([...batch, M, N]);
		const A = a.data;
		const B = b.data;
		const O = out.data;
		const row = new Float64Array(N);
		forEachStrided(batch, [aBatchStrides, bBatchStrides], (bi, [ao, bo]) => {
			if (this.fastConv) {
				matmulTiled(
					A,
					ao,
					B,
					bo,
					transB ? 1 : N,
					transB ? K : 1,
					bias ? bias.data : null,
					O,
					bi * M * N,
					M,
					N,
					K,
				);
				return;
			}
			for (let m = 0; m < M; m++) {
				if (bias) for (let n = 0; n < N; n++) row[n] = bias.data[n];
				else row.fill(0);
				const ar = ao + m * K;
				if (transB)
					for (let n = 0; n < N; n++) {
						let s = 0;
						const br = bo + n * K;
						for (let k = 0; k < K; k++) s += A[ar + k] * B[br + k];
						row[n] += s;
					}
				else
					for (let k = 0; k < K; k++) {
						const av = A[ar + k];
						if (av === 0) continue;
						const br = bo + k * N;
						for (let n = 0; n < N; n++) row[n] += av * B[br + n];
					}
				O.set(row, (bi * M + m) * N);
			}
		});
		return out;
	}

	pBinary(
		op: BinaryOp,
		a: CpuTensor | number,
		b: CpuTensor | number,
		out: number[],
	): CpuTensor {
		const f = binaryFn(op);
		const o = t(out);
		const O = o.data;
		if (typeof a === "number") {
			const B = (b as CpuTensor).data;
			for (let i = 0; i < O.length; i++) O[i] = f(a, B[i]);
		} else if (typeof b === "number") {
			const A = a.data;
			for (let i = 0; i < O.length; i++) O[i] = f(A[i], b);
		} else if (
			this.fastConv &&
			a.data.length === O.length &&
			b.data.length === O.length &&
			binarySameShape(op, a.data, b.data, O)
		) {
			// same-shape fast path (done)
		} else {
			const A = a.data;
			const B = b.data;
			forEachStrided(
				out,
				[bstrides(a.shape, out), bstrides(b.shape, out)],
				(i, [ia, ib]) => {
					O[i] = f(A[ia], B[ib]);
				},
			);
		}
		return o;
	}

	pWhere(
		c: CpuTensor,
		a: CpuTensor | number,
		b: CpuTensor | number,
		out: number[],
	): CpuTensor {
		const o = t(out);
		const sa =
			typeof a === "number" ? out.map(() => 0) : bstrides(a.shape, out);
		const sb =
			typeof b === "number" ? out.map(() => 0) : bstrides(b.shape, out);
		const va = (i: number) => (typeof a === "number" ? a : a.data[i]);
		const vb = (i: number) => (typeof b === "number" ? b : b.data[i]);
		forEachStrided(out, [bstrides(c.shape, out), sa, sb], (i, [ic, ia, ib]) => {
			o.data[i] = c.data[ic] !== 0 ? va(ia) : vb(ib);
		});
		return o;
	}

	pUnary(op: UnaryPrim, x: CpuTensor, alpha: number, beta: number) {
		const o = t(x.shape);
		if (op === "relu" && this.fastConv) {
			reluInto(x.data, o.data);
			return o;
		}
		const f = unaryFn(op, alpha, beta);
		for (let i = 0; i < o.data.length; i++) o.data[i] = f(x.data[i]);
		return o;
	}

	pSoftmax(
		x: CpuTensor,
		outer: number,
		len: number,
		inner: number,
		log: boolean,
	) {
		const o = t(x.shape);
		const X = x.data;
		for (let a = 0; a < outer; a++)
			for (let c = 0; c < inner; c++) {
				const base = a * len * inner + c;
				let m = Number.NEGATIVE_INFINITY;
				for (let i = 0; i < len; i++) m = Math.max(m, X[base + i * inner]);
				let s = 0;
				for (let i = 0; i < len; i++) s += Math.exp(X[base + i * inner] - m);
				const ls = Math.log(s);
				for (let i = 0; i < len; i++) {
					const v = X[base + i * inner] - m;
					o.data[base + i * inner] = log ? v - ls : Math.exp(v) / s;
				}
			}
		return o;
	}

	pLayerNorm(
		x: CpuTensor,
		w: CpuTensor | null,
		b: CpuTensor | null,
		rows: number,
		C: number,
		eps: number,
	) {
		const o = t(x.shape);
		for (let r = 0; r < rows; r++) {
			let m = 0;
			for (let c = 0; c < C; c++) m += x.data[r * C + c];
			m /= C;
			let v = 0;
			for (let c = 0; c < C; c++) v += (x.data[r * C + c] - m) ** 2;
			const inv = 1 / Math.sqrt(v / C + eps);
			for (let c = 0; c < C; c++)
				o.data[r * C + c] =
					(x.data[r * C + c] - m) * inv * (w ? w.data[c] : 1) +
					(b ? b.data[c] : 0);
		}
		return o;
	}

	pGroupNorm(
		x: CpuTensor,
		w: CpuTensor | null,
		b: CpuTensor | null,
		N: number,
		C: number,
		G: number,
		inner: number,
		eps: number,
	) {
		const o = t(x.shape);
		const cpg = C / G;
		const len = cpg * inner;
		for (let n = 0; n < N; n++)
			for (let g = 0; g < G; g++) {
				const base = (n * C + g * cpg) * inner;
				let m = 0;
				for (let i = 0; i < len; i++) m += x.data[base + i];
				m /= len;
				let v = 0;
				for (let i = 0; i < len; i++) v += (x.data[base + i] - m) ** 2;
				const inv = 1 / Math.sqrt(v / len + eps);
				for (let i = 0; i < len; i++) {
					const c = g * cpg + Math.floor(i / inner);
					o.data[base + i] =
						(x.data[base + i] - m) * inv * (w ? w.data[c] : 1) +
						(b ? b.data[c] : 0);
				}
			}
		return o;
	}

	pL2Norm(
		x: CpuTensor,
		outer: number,
		len: number,
		inner: number,
		eps: number,
	) {
		const o = t(x.shape);
		for (let a = 0; a < outer; a++)
			for (let c = 0; c < inner; c++) {
				const base = a * len * inner + c;
				let s = 0;
				for (let i = 0; i < len; i++) s += x.data[base + i * inner] ** 2;
				const d = Math.max(Math.sqrt(s), eps);
				for (let i = 0; i < len; i++)
					o.data[base + i * inner] = x.data[base + i * inner] / d;
			}
		return o;
	}

	pAttention(
		q: CpuTensor,
		k: CpuTensor,
		v: CpuTensor,
		mask: CpuTensor | null,
		p: AttentionParams,
	) {
		const { B, H, Nq, Nk, D, Dv, scale, maskStrides } = p;
		const o = t([B, H, Nq, Dv]);
		const s = new Float64Array(Nk);
		for (let bh = 0; bh < B * H; bh++) {
			const bi = Math.floor(bh / H);
			const hi = bh % H;
			for (let i = 0; i < Nq; i++) {
				const qo = (bh * Nq + i) * D;
				let m = Number.NEGATIVE_INFINITY;
				for (let j = 0; j < Nk; j++) {
					const ko = (bh * Nk + j) * D;
					let d = 0;
					for (let c = 0; c < D; c++) d += q.data[qo + c] * k.data[ko + c];
					d *= scale;
					if (mask && maskStrides)
						d +=
							mask.data[
								bi * maskStrides[0] +
									hi * maskStrides[1] +
									i * maskStrides[2] +
									j * maskStrides[3]
							];
					s[j] = d;
					if (d > m) m = d;
				}
				let z = 0;
				for (let j = 0; j < Nk; j++) {
					s[j] = Math.exp(s[j] - m);
					z += s[j];
				}
				const oo = (bh * Nq + i) * Dv;
				for (let c = 0; c < Dv; c++) {
					let acc = 0;
					for (let j = 0; j < Nk; j++)
						acc += s[j] * v.data[(bh * Nk + j) * Dv + c];
					o.data[oo + c] = acc / z;
				}
			}
		}
		return o;
	}

	pRotary(
		x: CpuTensor,
		cos: CpuTensor,
		sin: CpuTensor,
		interleaved: boolean,
		cs: number[],
		ss: number[],
	) {
		const o = t(x.shape);
		const D = x.shape[x.shape.length - 1];
		const half = D / 2;
		forEachStrided(x.shape, [cs, ss], (i, [ic, is]) => {
			const d = i % D;
			let partner: number;
			let sign: number;
			if (interleaved) {
				partner = d % 2 ? i - 1 : i + 1;
				sign = d % 2 ? 1 : -1;
			} else {
				partner = d < half ? i + half : i - half;
				sign = d < half ? -1 : 1;
			}
			o.data[i] =
				x.data[i] * cos.data[ic] + sign * x.data[partner] * sin.data[is];
		});
		return o;
	}

	pPool(kind: "max" | "avg", x: CpuTensor, p: PoolParams) {
		const {
			N,
			C,
			H,
			W,
			kh,
			kw,
			sh,
			sw,
			ph,
			pw,
			dh,
			dw,
			Ho,
			Wo,
			countIncludePad,
		} = p;
		const o = t([N, C, Ho, Wo]);
		if (this.fastConv && poolInside(kind, x.data, o.data, p)) return o;
		for (let nc = 0; nc < N * C; nc++)
			for (let oy = 0; oy < Ho; oy++)
				for (let ox = 0; ox < Wo; ox++) {
					let m = Number.NEGATIVE_INFINITY;
					let s = 0;
					let cnt = 0;
					for (let ky = 0; ky < kh; ky++)
						for (let kx = 0; kx < kw; kx++) {
							const iy = oy * sh - ph + ky * dh;
							const ix = ox * sw - pw + kx * dw;
							if (iy < 0 || iy >= H || ix < 0 || ix >= W) continue;
							const v = x.data[(nc * H + iy) * W + ix];
							if (v > m || Number.isNaN(v)) m = v;
							s += v;
							cnt++;
						}
					let div = cnt;
					if (countIncludePad) {
						// PyTorch: the window clipped to the padded extent
						const y0 = oy * sh - ph;
						const x0 = ox * sw - pw;
						const y1 = Math.min(y0 + kh, H + ph);
						const x1 = Math.min(x0 + kw, W + pw);
						div = (y1 - y0) * (x1 - x0);
					}
					o.data[(nc * Ho + oy) * Wo + ox] = kind === "max" ? m : s / div;
				}
		return o;
	}

	pInterpolate(x: CpuTensor, p: InterpParams) {
		const { N, C, H, W, Ho, Wo, mode, alignCorners, scaleH, scaleW } = p;
		const o = t([N, C, Ho, Wo]);
		if (this.fastConv && resizeFast(x.data, o.data, p)) return o;
		const src = (d: number, s: number, cubic: boolean) =>
			alignCorners
				? d * s
				: cubic || mode === "bilinear"
					? (d + 0.5) * s - 0.5
					: d * s;
		for (let nc = 0; nc < N * C; nc++) {
			const base = nc * H * W;
			const at = (y: number, xx: number) =>
				x.data[
					base +
						Math.min(H - 1, Math.max(0, y)) * W +
						Math.min(W - 1, Math.max(0, xx))
				];
			for (let oy = 0; oy < Ho; oy++)
				for (let ox = 0; ox < Wo; ox++) {
					let v: number;
					if (mode === "nearest") {
						const iy = Math.min(H - 1, Math.floor(oy * scaleH));
						const ix = Math.min(W - 1, Math.floor(ox * scaleW));
						v = x.data[base + iy * W + ix];
					} else if (mode === "bilinear") {
						const fy = Math.max(0, src(oy, scaleH, false));
						const fx = Math.max(0, src(ox, scaleW, false));
						const y0 = Math.min(H - 1, Math.floor(fy));
						const x0 = Math.min(W - 1, Math.floor(fx));
						const y1 = Math.min(H - 1, y0 + 1);
						const x1 = Math.min(W - 1, x0 + 1);
						const ly = fy - y0;
						const lx = fx - x0;
						v =
							(1 - ly) * ((1 - lx) * at(y0, x0) + lx * at(y0, x1)) +
							ly * ((1 - lx) * at(y1, x0) + lx * at(y1, x1));
					} else {
						const fy = src(oy, scaleH, true);
						const fx = src(ox, scaleW, true);
						const y0 = Math.floor(fy);
						const x0 = Math.floor(fx);
						const wy = cubicWeights(fy - y0);
						const wx = cubicWeights(fx - x0);
						v = 0;
						for (let i = 0; i < 4; i++) {
							let r = 0;
							for (let j = 0; j < 4; j++)
								r += wx[j] * at(y0 - 1 + i, x0 - 1 + j);
							v += wy[i] * r;
						}
					}
					o.data[(nc * Ho + oy) * Wo + ox] = v;
				}
		}
		return o;
	}

	pGridSample(x: CpuTensor, grid: CpuTensor, p: GridSampleParams) {
		const { N, C, H, W, Ho, Wo, mode, padding, alignCorners } = p;
		const o = t([N, C, Ho, Wo]);
		const unnorm = (g: number, size: number) =>
			alignCorners ? ((g + 1) / 2) * (size - 1) : ((g + 1) * size - 1) / 2;
		for (let n = 0; n < N; n++)
			for (let oy = 0; oy < Ho; oy++)
				for (let ox = 0; ox < Wo; ox++) {
					const gi = ((n * Ho + oy) * Wo + ox) * 2;
					let fx = unnorm(grid.data[gi], W);
					let fy = unnorm(grid.data[gi + 1], H);
					if (padding === "border") {
						fx = Math.min(W - 1, Math.max(0, fx));
						fy = Math.min(H - 1, Math.max(0, fy));
					}
					for (let c = 0; c < C; c++) {
						const base = (n * C + c) * H * W;
						const at = (yy: number, xx: number) =>
							yy >= 0 && yy < H && xx >= 0 && xx < W
								? x.data[base + yy * W + xx]
								: 0;
						let v: number;
						if (mode === "nearest") {
							// torch uses nearbyint (half to even)
							const ry =
								fy - Math.floor(fy) === 0.5
									? 2 * Math.round(fy / 2)
									: Math.round(fy);
							const rx =
								fx - Math.floor(fx) === 0.5
									? 2 * Math.round(fx / 2)
									: Math.round(fx);
							v = at(ry, rx);
						} else {
							const x0 = Math.floor(fx);
							const y0 = Math.floor(fy);
							const lx = fx - x0;
							const ly = fy - y0;
							v =
								(1 - ly) * ((1 - lx) * at(y0, x0) + lx * at(y0, x0 + 1)) +
								ly * ((1 - lx) * at(y0 + 1, x0) + lx * at(y0 + 1, x0 + 1));
						}
						o.data[((n * C + c) * Ho + oy) * Wo + ox] = v;
					}
				}
		return o;
	}

	pNms(x: CpuTensor, radius: number) {
		const [N, C, H, W] = x.shape;
		const o = t(x.shape);
		for (let nc = 0; nc < N * C; nc++)
			for (let y = 0; y < H; y++)
				for (let xx = 0; xx < W; xx++) {
					const v = x.data[(nc * H + y) * W + xx];
					let m = Number.NEGATIVE_INFINITY;
					for (let dy = -radius; dy <= radius; dy++)
						for (let dx = -radius; dx <= radius; dx++) {
							const yy = y + dy;
							const xc = xx + dx;
							if (yy < 0 || yy >= H || xc < 0 || xc >= W) continue;
							m = Math.max(m, x.data[(nc * H + yy) * W + xc]);
						}
					o.data[(nc * H + y) * W + xx] = v === m ? v : 0;
				}
		return o;
	}

	pView(x: CpuTensor, shape: number[]) {
		return new CpuTensor(shape, x.data);
	}

	pCopy(x: CpuTensor, out: number[], strides: number[], offset: number) {
		const o = t(out);
		forEachStrided(out, [strides], (i, [s]) => {
			o.data[i] = x.data[offset + s];
		});
		return o;
	}

	pConcat(xs: CpuTensor[], axis: number, out: number[]) {
		const o = t(out);
		const outer = numel(out.slice(0, axis));
		const inner = numel(out.slice(axis + 1));
		const rowOut = out[axis] * inner;
		let at = 0;
		for (const x of xs) {
			const row = x.shape[axis] * inner;
			for (let a = 0; a < outer; a++)
				o.data.set(x.data.subarray(a * row, (a + 1) * row), a * rowOut + at);
			at += row;
		}
		return o;
	}

	pGather(
		x: CpuTensor,
		idx: CpuTensor,
		outer: number,
		len: number,
		inner: number,
		out: number[],
	) {
		const o = t(out);
		const n = idx.data.length;
		for (let a = 0; a < outer; a++)
			for (let j = 0; j < n; j++) {
				let i = Math.trunc(idx.data[j]);
				if (i < 0) i += len;
				if (i < 0 || i >= len)
					throw new Error(`nn: gather index ${i} of ${len}`);
				o.data.set(
					x.data.subarray((a * len + i) * inner, (a * len + i + 1) * inner),
					(a * n + j) * inner,
				);
			}
		return o;
	}

	pPad(
		x: CpuTensor,
		pads: [number, number][],
		mode: "constant" | "reflect" | "replicate",
		value: number,
		out: number[],
	) {
		const o = t(out);
		if (
			this.fastConv &&
			mode === "constant" &&
			out.length > 0 &&
			pads.every(([a, b]) => a >= 0 && b >= 0)
		) {
			padConstantRows(
				x.data,
				o.data,
				x.shape,
				out,
				pads as [number, number][],
				value,
			);
			return o;
		}
		const r = out.length;
		const xs = stridesOf(x.shape);
		const idx = new Array<number>(r).fill(0);
		for (let i = 0; i < o.data.length; i++) {
			let rem = i;
			for (let d = r - 1; d >= 0; d--) {
				idx[d] = rem % out[d];
				rem = Math.floor(rem / out[d]);
			}
			let off = 0;
			let inside = true;
			for (let d = 0; d < r; d++) {
				let s = idx[d] - pads[d][0];
				const n = x.shape[d];
				if (s < 0 || s >= n) {
					if (mode === "constant") {
						inside = false;
						break;
					}
					if (mode === "replicate") s = Math.min(n - 1, Math.max(0, s));
					else s = s < 0 ? -s : 2 * (n - 1) - s;
				}
				off += s * xs[d];
			}
			o.data[i] = inside ? x.data[off] : value;
		}
		return o;
	}

	pReduce(
		op: ReducePrim,
		x: CpuTensor,
		outer: number,
		len: number,
		inner: number,
		out: number[],
	) {
		const o = t(out);
		for (let a = 0; a < outer; a++)
			for (let c = 0; c < inner; c++) {
				const base = a * len * inner + c;
				let acc =
					op === "max" || op === "argmax"
						? Number.NEGATIVE_INFINITY
						: op === "min"
							? Number.POSITIVE_INFINITY
							: 0;
				let arg = 0;
				for (let i = 0; i < len; i++) {
					const v = x.data[base + i * inner];
					if (op === "sum" || op === "mean") acc += v;
					else if (op === "min") acc = Math.min(acc, v);
					else if (v > acc) {
						acc = v;
						arg = i;
					}
				}
				o.data[a * inner + c] =
					op === "mean" ? acc / len : op === "argmax" ? arg : acc;
			}
		return o;
	}

	pTopk(x: CpuTensor, rows: number, len: number, k: number, out: number[]) {
		const values = t(out);
		const indices = t(out);
		const order = new Uint32Array(len);
		for (let r = 0; r < rows; r++) {
			const base = r * len;
			for (let i = 0; i < len; i++) order[i] = i;
			order.sort((i, j) => x.data[base + j] - x.data[base + i] || i - j);
			for (let i = 0; i < k; i++) {
				values.data[r * k + i] = x.data[base + order[i]];
				indices.data[r * k + i] = order[i];
			}
		}
		return { values, indices };
	}
}
