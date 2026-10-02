// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// GpuNn: the WebGPU backend of `Nn`. Ops record kernel nodes (runtime.ts); forward() lowers them to
// one ComputeGraph submission. Ops called outside forward() are recorded too and flushed (all of
// their results kept) before the next forward, read, or explicit sync().

import type { Buffer, Device, Texture } from "@luma.gl/core";
import {
	type AttentionParams,
	BaseNn,
	type GridSampleParams,
	type InterpParams,
	type MatmulParams,
	type ReducePrim,
	type UnaryPrim,
} from "../base";
import { fetchModel } from "../fetch";
import { halfToFloat32, parseSafetensors } from "../safetensors";
import {
	broadcastStrides,
	type ConvParams,
	numel,
	type PoolParams,
	stridesOf,
} from "../shape";
import type { BinaryOp, DType, NnBackend, Tensor, Weights } from "../types";
import { attentionKernel } from "./k-attention";
import {
	binaryExpr,
	copyIntoKernel,
	fillKernel,
	type KernelCall,
	naryKernel,
	type Operand,
	stridedCopyKernel,
	unaryKernel,
} from "./k-elementwise";
import {
	convDirectKernel,
	convGemmKernel,
	type Epilogue,
	matmulKernel,
} from "./k-gemm";
import {
	groupNormKernel,
	l2NormKernel,
	layerNormKernel,
	reduceKernel,
	softmaxKernel,
} from "./k-reduce";
import {
	gatherKernel,
	gridSampleKernel,
	interpolateKernel,
	nmsKernel,
	padKernel,
	poolKernel,
	rotaryKernel,
	textureKernel,
} from "./k-spatial";
import { topkPlan } from "./k-topk";
import {
	type Activation,
	GpuTensor,
	type Node,
	Recording,
	Runtime,
	Storage,
} from "./runtime";

class GpuWeights implements Weights {
	constructor(
		readonly map: Map<string, GpuTensor>,
		readonly metadata: Record<string, string>,
	) {}
	get names() {
		return [...this.map.keys()];
	}
	has(name: string) {
		return this.map.has(name);
	}
	get(name: string): GpuTensor {
		const t = this.map.get(name);
		if (!t) throw new Error(`nn: no weight "${name}"`);
		return t;
	}
}

/** A Node.fuse for a kernel maker taking an epilogue. */
const fuser =
	(make: (e: Epilogue) => KernelCall) =>
	(a: Activation): KernelCall =>
		make({ op: a.op as UnaryPrim, alpha: a.alpha, beta: a.beta });

/** Convs whose per-group output channel count is below this run the direct kernel. */
const DIRECT_CONV_COG = 8;

export class GpuNn extends BaseNn<GpuTensor> {
	readonly backend: NnBackend;
	readonly runtime: Runtime;
	private rec: Recording | null = null;
	private implicit: Recording | null = null;

	constructor(readonly device: Device) {
		super();
		this.runtime = new Runtime(device);
		this.backend = { kind: "gpu", f16: device.features.has("shader-f16") };
	}

	// ---- tensors ------------------------------------------------------------------------------
	private current(): Recording {
		if (this.rec) return this.rec;
		this.implicit ??= new Recording();
		return this.implicit;
	}

	/** Record one kernel node producing new f32 tensors of `shapes`. */
	private node(
		call: KernelCall,
		inputs: GpuTensor[],
		shapes: number[][],
		extra: Pick<Node, "act" | "fuse"> = {},
	): GpuTensor[] {
		const rec = this.current();
		const outs = shapes.map((s) => {
			const st = new Storage(Math.max(4, numel(s) * 4), "f32", rec);
			rec.produced.push(st);
			return new GpuTensor(s, "f32", st);
		});
		rec.nodes.push({
			spec: call.spec,
			inputs: inputs.map((t) => t.st),
			outputs: outs.map((t) => t.st),
			meta: call.meta,
			wg: call.wg,
			...extra,
		});
		return outs;
	}
	private one(
		call: KernelCall,
		inputs: GpuTensor[],
		shape: number[],
		extra: Pick<Node, "act" | "fuse"> = {},
	): GpuTensor {
		return this.node(call, inputs, [shape], extra)[0];
	}

	private flushImplicit(): Promise<void> {
		const rec = this.implicit;
		if (!rec) return Promise.resolve();
		this.implicit = null;
		const outs = new Set(rec.produced.filter((s) => !s.dropped));
		return this.runtime.flush(rec, outs);
	}

	/** Submit pending eager ops now. */
	sync(): Promise<void> {
		return this.flushImplicit();
	}

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
		const map = new Map<string, GpuTensor>();
		for (const [name, e] of st.entries) {
			let data: ArrayBufferView;
			let dtype: DType = "f32";
			if (e.half && this.backend.f16) {
				data = e.half;
				dtype = "f16";
			} else data = e.data ?? halfToFloat32(e.half as Uint16Array);
			const s = this.runtime.upload(data, dtype, true);
			s.pinned = true;
			map.set(name, new GpuTensor(e.shape, dtype, s));
		}
		return new GpuWeights(map, st.metadata);
	}

	fromArray(
		data: Float32Array | readonly number[],
		shape: readonly number[],
	): GpuTensor {
		if (data.length !== numel(shape))
			throw new Error(
				`nn: fromArray ${data.length} values for [${shape.join(",")}]`,
			);
		const arr = data instanceof Float32Array ? data : Float32Array.from(data);
		return new GpuTensor([...shape], "f32", this.runtime.upload(arr, "f32"));
	}

	fromTexture(
		tex: unknown,
		opts: {
			shape: readonly number[];
			mean?: readonly number[];
			std?: readonly number[];
		},
	): GpuTensor {
		const t = tex as Texture;
		const [N, C, H, W] = opts.shape;
		if (opts.shape.length !== 4 || N !== 1 || C < 1 || C > 4)
			throw new Error("nn: fromTexture shape must be [1, C ≤ 4, H, W]");
		const call = textureKernel(
			C,
			t.width,
			t.height,
			H,
			W,
			opts.mean ?? [],
			opts.std ?? [],
		);
		const rec = this.current();
		const st = new Storage(C * H * W * 4, "f32", rec);
		rec.produced.push(st);
		rec.nodes.push({
			spec: call.spec,
			textures: [t],
			inputs: [],
			outputs: [st],
			meta: call.meta,
			wg: call.wg,
		});
		return new GpuTensor([1, C, H, W], "f32", st);
	}

	/**
	 * A caller-owned luma buffer (f32, row-major, at least numel(shape)·4 bytes, on this device) as a
	 * tensor, without a copy: the sky prep's normalised input stays where the prep kernels wrote it. The
	 * runtime never recycles or destroys it (dispose() is a no-op); the caller keeps it alive until the
	 * forwards that read it have resolved.
	 */
	fromBuffer(buffer: Buffer, shape: readonly number[]): GpuTensor {
		const bytes = Math.max(4, numel(shape) * 4);
		if (buffer.byteLength < bytes)
			throw new Error(
				`nn: fromBuffer ${buffer.byteLength} B for [${shape.join(",")}]`,
			);
		const st = new Storage(bytes, "f32", null);
		st.buffer = buffer;
		st.pinned = true;
		return new GpuTensor([...shape], "f32", st);
	}

	/**
	 * The luma buffer behind a ready f32 tensor (numel·4 bytes at offset 0, capacity may be larger), for
	 * GPU consumers of a forward's output (the sky refine). Valid until `dispose(t)`; read it only after
	 * the forward that produced it has resolved.
	 */
	bufferOf(t: Tensor): Buffer {
		const g = t as GpuTensor;
		if (g.st.state !== "ready" || !g.st.buffer)
			throw new Error(`nn: bufferOf a ${g.st.state} tensor`);
		return g.st.buffer;
	}

	async read(t: Tensor): Promise<Float32Array> {
		const g = t as GpuTensor;
		if (g.st.state === "pending") {
			if (g.st.rec === this.rec)
				throw new Error(
					"nn: read() inside forward(); return the tensor instead",
				);
			await this.flushImplicit();
		}
		if (g.st.state !== "ready")
			throw new Error(`nn: read of a ${g.st.state} tensor`);
		const buf = await this.runtime.read(g.st);
		const n = numel(g.shape);
		if (g.dtype === "f16") return halfToFloat32(new Uint16Array(buf, 0, n));
		return new Float32Array(buf, 0, n).slice();
	}

	dispose(t: Tensor | Weights | readonly Tensor[]): void {
		if (Array.isArray(t)) {
			for (const x of t) this.dispose(x);
			return;
		}
		if (t instanceof GpuWeights) {
			for (const w of t.map.values()) {
				w.st.buffer?.destroy();
				w.st.buffer = null;
				w.st.state = "disposed";
			}
			t.map.clear();
			return;
		}
		const st = (t as GpuTensor).st;
		if (st.pinned) return;
		if (st.state === "pending") st.dropped = true;
		else if (st.state === "ready" && st.buffer) {
			this.runtime.recycle(st.buffer);
			st.buffer = null;
			st.state = "disposed";
		}
	}

	async forward<R>(fn: () => R): Promise<R> {
		if (this.rec) return fn();
		const pending = this.flushImplicit();
		const rec = new Recording();
		this.rec = rec;
		let out: R;
		try {
			out = fn();
		} catch (e) {
			for (const s of rec.produced) s.state = "dead";
			throw e;
		} finally {
			this.rec = null;
		}
		const outs = new Set<Storage>();
		const visit = (v: unknown) => {
			if (v instanceof GpuTensor) {
				if (v.st.rec === rec) outs.add(v.st);
			} else if (Array.isArray(v)) v.forEach(visit);
			else if (
				v &&
				typeof v === "object" &&
				Object.getPrototypeOf(v) === Object.prototype
			)
				Object.values(v).forEach(visit);
		};
		visit(out);
		await Promise.all([pending, this.runtime.flush(rec, outs)]);
		return out;
	}

	// ---- primitives ---------------------------------------------------------------------------
	pFull(shape: number[], value: number) {
		return this.one(fillKernel(numel(shape), value), [], shape);
	}

	pConv(
		x: GpuTensor,
		w: GpuTensor,
		b: GpuTensor | null,
		p: ConvParams,
		transpose: boolean,
	) {
		return this.conv(x, w, b, p, transpose, null);
	}
	/** conv with an optional fused activation epilogue */
	conv(
		x: GpuTensor,
		w: GpuTensor,
		b: GpuTensor | null,
		p: ConvParams,
		transpose: boolean,
		ep: Epilogue,
	) {
		const shape = [p.N, p.Cout, p.Ho, p.Wo];
		const dt = { x: x.dtype, w: w.dtype, b: b?.dtype ?? null };
		const ins = [x, w, ...(b ? [b] : [])];
		const make = (e: Epilogue) =>
			!transpose && p.Cout / p.groups < DIRECT_CONV_COG
				? convDirectKernel(p, dt, e)
				: convGemmKernel(transpose ? "convT" : "conv", p, dt, e);
		return this.one(make(ep), ins, shape, ep ? {} : { fuse: fuser(make) });
	}

	pDeform(
		x: GpuTensor,
		offset: GpuTensor,
		mask: GpuTensor | null,
		w: GpuTensor,
		b: GpuTensor | null,
		p: ConvParams,
	) {
		const make = (e: Epilogue) =>
			convGemmKernel(
				"deform",
				p,
				{
					x: x.dtype,
					w: w.dtype,
					b: b?.dtype ?? null,
					off: offset.dtype,
					mask: mask?.dtype ?? null,
				},
				e,
			);
		return this.one(
			make(null),
			[x, offset, ...(mask ? [mask] : []), w, ...(b ? [b] : [])],
			[p.N, p.Cout, p.Ho, p.Wo],
			{ fuse: fuser(make) },
		);
	}

	pMatmul(a: GpuTensor, b: GpuTensor, bias: GpuTensor | null, p: MatmulParams) {
		const make = (e: Epilogue) =>
			matmulKernel(p, a.dtype, b.dtype, bias?.dtype ?? null, e);
		return this.one(
			make(null),
			[a, b, ...(bias ? [bias] : [])],
			[...p.batch, p.M, p.N],
			{ fuse: fuser(make) },
		);
	}

	private operand(v: GpuTensor | number, out: number[]): Operand {
		return typeof v === "number"
			? { kind: "scalar", value: v }
			: {
					kind: "tensor",
					dtype: v.dtype,
					strides: broadcastStrides(v.shape, out),
				};
	}

	pBinary(
		op: BinaryOp,
		a: GpuTensor | number,
		b: GpuTensor | number,
		out: number[],
	) {
		const call = naryKernel(
			`bin-${op}`,
			["a", "b"],
			[this.operand(a, out), this.operand(b, out)],
			out,
			binaryExpr(op),
		);
		const ins = [a, b].filter((v): v is GpuTensor => typeof v !== "number");
		return this.one(call, ins, out);
	}

	pWhere(
		c: GpuTensor,
		a: GpuTensor | number,
		b: GpuTensor | number,
		out: number[],
	) {
		const call = naryKernel(
			"where",
			["c", "a", "b"],
			[this.operand(c, out), this.operand(a, out), this.operand(b, out)],
			out,
			"select(b, a, c != 0.0)",
		);
		const ins = [c, a, b].filter((v): v is GpuTensor => typeof v !== "number");
		return this.one(call, ins, out);
	}

	pUnary(op: UnaryPrim, x: GpuTensor, alpha: number, beta: number) {
		return this.one(
			unaryKernel(op, x.dtype, numel(x.shape), alpha, beta),
			[x],
			[...x.shape],
			{ act: { op, alpha, beta } },
		);
	}

	pSoftmax(
		x: GpuTensor,
		outer: number,
		len: number,
		inner: number,
		log: boolean,
	) {
		return this.one(
			softmaxKernel(x.dtype, outer, len, inner, log),
			[x],
			[...x.shape],
		);
	}

	pLayerNorm(
		x: GpuTensor,
		w: GpuTensor | null,
		b: GpuTensor | null,
		rows: number,
		C: number,
		eps: number,
	) {
		return this.one(
			layerNormKernel(
				x.dtype,
				w?.dtype ?? null,
				b?.dtype ?? null,
				rows,
				C,
				eps,
			),
			[x, ...(w ? [w] : []), ...(b ? [b] : [])],
			[...x.shape],
		);
	}

	pGroupNorm(
		x: GpuTensor,
		w: GpuTensor | null,
		b: GpuTensor | null,
		N: number,
		C: number,
		G: number,
		inner: number,
		eps: number,
	) {
		return this.one(
			groupNormKernel(
				x.dtype,
				w?.dtype ?? null,
				b?.dtype ?? null,
				N,
				C,
				G,
				inner,
				eps,
			),
			[x, ...(w ? [w] : []), ...(b ? [b] : [])],
			[...x.shape],
		);
	}

	pL2Norm(
		x: GpuTensor,
		outer: number,
		len: number,
		inner: number,
		eps: number,
	) {
		return this.one(
			l2NormKernel(x.dtype, outer, len, inner, eps),
			[x],
			[...x.shape],
		);
	}

	pAttention(
		q: GpuTensor,
		k: GpuTensor,
		v: GpuTensor,
		mask: GpuTensor | null,
		p: AttentionParams,
	) {
		return this.one(
			attentionKernel(p, q.dtype, k.dtype, v.dtype, mask?.dtype ?? null),
			[q, k, v, ...(mask ? [mask] : [])],
			[p.B, p.H, p.Nq, p.Dv],
		);
	}

	pRotary(
		x: GpuTensor,
		cos: GpuTensor,
		sin: GpuTensor,
		interleaved: boolean,
		cs: number[],
		ss: number[],
	) {
		return this.one(
			rotaryKernel(x.dtype, cos.dtype, sin.dtype, x.shape, cs, ss, interleaved),
			[x, cos, sin],
			[...x.shape],
		);
	}

	pPool(kind: "max" | "avg", x: GpuTensor, p: PoolParams) {
		return this.one(poolKernel(kind, x.dtype, p), [x], [p.N, p.C, p.Ho, p.Wo]);
	}

	pInterpolate(x: GpuTensor, p: InterpParams) {
		return this.one(interpolateKernel(x.dtype, p), [x], [p.N, p.C, p.Ho, p.Wo]);
	}

	pGridSample(x: GpuTensor, grid: GpuTensor, p: GridSampleParams) {
		return this.one(
			gridSampleKernel(x.dtype, grid.dtype, p),
			[x, grid],
			[p.N, p.C, p.Ho, p.Wo],
		);
	}

	pNms(x: GpuTensor, radius: number) {
		return this.one(nmsKernel(x.dtype, x.shape, radius), [x], [...x.shape]);
	}

	pView(x: GpuTensor, shape: number[]) {
		return new GpuTensor(shape, x.dtype, x.st);
	}

	pCopy(x: GpuTensor, out: number[], strides: number[], offset: number) {
		return this.one(stridedCopyKernel(x.dtype, out, strides, offset), [x], out);
	}

	pConcat(xs: GpuTensor[], axis: number, out: number[]) {
		const rec = this.current();
		const st = new Storage(Math.max(4, numel(out) * 4), "f32", rec);
		rec.produced.push(st);
		const os = stridesOf(out);
		let at = 0;
		for (const x of xs) {
			const call = copyIntoKernel(x.dtype, [...x.shape], os, at * os[axis]);
			rec.nodes.push({
				spec: call.spec,
				inputs: [x.st],
				outputs: [st],
				meta: call.meta,
				wg: call.wg,
			});
			at += x.shape[axis];
		}
		return new GpuTensor(out, "f32", st);
	}

	pGather(
		x: GpuTensor,
		idx: GpuTensor,
		outer: number,
		len: number,
		inner: number,
		out: number[],
	) {
		return this.one(
			gatherKernel(x.dtype, idx.dtype, outer, len, inner, numel(idx.shape)),
			[x, idx],
			out,
		);
	}

	pPad(
		x: GpuTensor,
		pads: [number, number][],
		mode: "constant" | "reflect" | "replicate",
		value: number,
		out: number[],
	) {
		return this.one(
			padKernel(x.dtype, x.shape, pads, mode, value, out),
			[x],
			out,
		);
	}

	pReduce(
		op: ReducePrim,
		x: GpuTensor,
		outer: number,
		len: number,
		inner: number,
		out: number[],
	) {
		return this.one(reduceKernel(op, x.dtype, outer, len, inner), [x], out);
	}

	pTopk(x: GpuTensor, rows: number, len: number, k: number, out: number[]) {
		const plan = topkPlan(x.dtype, rows, len, k);
		const [keys, idx] = this.node(
			plan.init,
			[x],
			[[rows * plan.P], [rows * plan.P]],
		);
		const rec = this.current();
		for (const s of plan.steps)
			rec.nodes.push({
				spec: s.spec,
				inputs: [],
				outputs: [keys.st, idx.st],
				meta: s.meta,
				wg: s.wg,
			});
		const [values, indices] = this.node(plan.final, [keys, idx], [out, out]);
		return { values, indices };
	}
}
