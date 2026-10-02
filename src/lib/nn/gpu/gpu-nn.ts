// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// GpuNn: the WebGPU backend of `Nn`. Ops record kernel nodes (runtime.ts); forward() lowers them to
// one ComputeGraph submission. Ops called outside forward() are recorded too and flushed (all of
// their results kept) before the next forward, read, or explicit sync().

import type { Buffer, Device, Texture } from "@luma.gl/core";
import { ComputeGraph } from "#/lib/gpu/core/graph";
import type { GraphDataView } from "#/lib/gpu/core/luma";
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
import { splitQuantized } from "../quant";
import {
	entryF32,
	halfToFloat32,
	parseSafetensors,
	type SafeTensorEntry,
} from "../safetensors";
import {
	broadcastStrides,
	type ConvParams,
	numel,
	type PoolParams,
	stridesOf,
} from "../shape";
import { collectTensors, mapTensors } from "../tree";
import type {
	BinaryOp,
	CompiledForward,
	CompiledInput,
	DType,
	NnBackend,
	Readback,
	Tensor,
	Weights,
} from "../types";
import { attentionKernel } from "./k-attention";
import {
	binaryExpr,
	coalesce,
	copyIntoKernel,
	type EwDesc,
	ewKernel,
	fillKernel,
	type KernelCall,
	naryDesc,
	type Operand,
	stridedCopyKernel,
	unaryDesc,
	unaryKernel,
} from "./k-elementwise";
import {
	convDirectKernel,
	convGemmKernel,
	type Epilogue,
	matmulKernel,
} from "./k-gemm";
import { dequantKernel } from "./k-quant";
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
import { capsFromFeatures, getKernelCaps, setKernelCaps } from "./kernel-caps";
import {
	irfftKernels,
	LUMA_REDUCE_MIN,
	LUMA_TOPK_MIN,
	lumaBinary,
	lumaBinaryOp,
	lumaFft2d,
	lumaReduce,
	lumaTopkPlan,
	lumaTranspose,
	rfftKernels,
} from "./luma-ops";
import {
	type Activation,
	GpuTensor,
	type LumaCall,
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
	/**
	 * Which ops run on luma operators (luma-ops.ts) and from what size: `enabled: false` forces every
	 * nn kernel (benches, A/B). Thresholds are element counts of the reduced row / sorted row.
	 */
	readonly lumaOps = {
		enabled: true,
		reduceMin: LUMA_REDUCE_MIN,
		topkMin: LUMA_TOPK_MIN,
	};
	private rec: Recording | null = null;
	private implicit: Recording | null = null;
	/** the active `scope()` path, stamped on recorded nodes */
	private scopePath: string | undefined;
	private readonly compiledForwards = new Map<
		string,
		Promise<GpuCompiled<unknown>>
	>();

	/** `graphGroup`: the cachedGraph group of this runtime's graphs (default "nn"; nn/registry.ts gives each consumer its own). */
	constructor(
		readonly device: Device,
		opts: { graphGroup?: string } = {},
	) {
		super();
		this.runtime = new Runtime(device, opts.graphGroup);
		this.backend = { kind: "gpu", f16: device.features.has("shader-f16") };
		setKernelCaps(capsFromFeatures((f) => device.features.has(f as never)));
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
		extra: Pick<Node, "act" | "fuse" | "ew" | "ln"> = {},
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
			scope: this.scopePath,
			...extra,
		});
		return outs;
	}
	private one(
		call: KernelCall,
		inputs: GpuTensor[],
		shape: number[],
		extra: Pick<Node, "act" | "fuse" | "ew" | "ln"> = {},
	): GpuTensor {
		return this.node(call, inputs, [shape], extra)[0];
	}

	/** Record a node run by a luma operator producing new f32 tensors of `shapes`. */
	private lumaNode(
		call: LumaCall,
		inputs: GpuTensor[],
		shapes: number[][],
		ew?: EwDesc,
	): GpuTensor[] {
		const rec = this.current();
		const outs = shapes.map((sh) => {
			const st = new Storage(Math.max(4, numel(sh) * 4), "f32", rec);
			rec.produced.push(st);
			return new GpuTensor(sh, "f32", st);
		});
		rec.nodes.push({
			luma: call,
			inputs: inputs.map((t) => t.st),
			outputs: outs.map((t) => t.st),
			meta: [],
			wg: [1, 1, 1],
			scope: this.scopePath,
			ew,
		});
		return outs;
	}

	private flushImplicit(): Promise<void> {
		const rec = this.implicit;
		if (!rec) return Promise.resolve();
		this.implicit = null;
		const outs = new Set(rec.produced.filter((s) => !s.dropped));
		// eager ops (weight loads, one-off uploads): a group of their own, so they never evict forwards
		return this.runtime.flush(rec, outs, true);
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
		const w = this.weightsFromBytes(await fetchModel(file, opts));
		// quantized files: surface a failed dequant submission here, not at the first forward
		await this.dequantDone;
		return w;
	}

	/** The last weightsFromBytes' dequant submission (resolved when it had none). */
	private dequantDone: Promise<void> = Promise.resolve();

	weightsFromBytes(bytes: ArrayBuffer | Uint8Array): Weights {
		const st = parseSafetensors(bytes);
		const { plain, quantized } = splitQuantized(st.entries, st.metadata);
		const map = new Map<string, GpuTensor>();
		const upload = (e: SafeTensorEntry) => {
			let data: ArrayBufferView;
			let dtype: DType = "f32";
			if (e.half && this.backend.f16) {
				data = e.half;
				dtype = "f16";
			} else data = e.data ?? entryF32(e);
			const s = this.runtime.upload(data, dtype, true);
			return new GpuTensor(e.shape, dtype, s);
		};
		for (const e of plain) {
			const t = upload(e);
			t.st.pinned = true;
			map.set(e.name, t);
		}
		if (quantized.length) {
			// one dequant node per weight on the implicit recording, submitted right away; the packed
			// words and scales are freed once that submission is queued
			const packed: GpuTensor[] = [];
			const out: DType = this.backend.f16 ? "f16" : "f32";
			for (const { name, info, q, scale } of quantized) {
				const numel = info.shape.reduce((a, v) => a * v, 1);
				const qt = new GpuTensor(
					[q.byteLength],
					"f32",
					this.runtime.upload(q, "f32", true),
				);
				const sc = upload(scale);
				packed.push(qt, sc);
				const rows = info.shape[0] ?? 1;
				const call = dequantKernel(
					info.bits,
					out,
					sc.dtype,
					numel,
					numel / rows,
					info.group,
				);
				const rec = this.current();
				const bytesOut = Math.max(
					4,
					Math.ceil((numel * (out === "f16" ? 2 : 4)) / 4) * 4,
				);
				const s = new Storage(bytesOut, out, rec);
				s.exact = true;
				s.pinned = true;
				rec.produced.push(s);
				rec.nodes.push({
					spec: call.spec,
					inputs: [qt.st, sc.st],
					outputs: [s],
					meta: call.meta,
					wg: call.wg,
				});
				map.set(name, new GpuTensor(info.shape, out, s));
			}
			const done = this.flushImplicit();
			this.dequantDone = done;
			done.then(
				() => this.freePacked(packed),
				() => this.freePacked(packed),
			);
		}
		return new GpuWeights(map, st.metadata);
	}

	private freePacked(ts: GpuTensor[]) {
		for (const t of ts) {
			t.st.buffer?.destroy();
			t.st.buffer = null;
			t.st.state = "disposed";
		}
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
			scope: this.scopePath,
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

	/**
	 * A GraphDataView<"float32"> of a caller's ComputeGraph (an `importView` / `transientView` / another
	 * op's output) as a [shape] f32 tensor, no copy. It can only be consumed inside
	 * `forwardInto(graph, …)` of the graph that owns the view.
	 */
	fromView(
		graph: ComputeGraph,
		view: GraphDataView<"float32">,
		shape: readonly number[],
	): GpuTensor {
		const n = numel(shape);
		if (view.length < n)
			throw new Error(
				`nn: fromView ${view.length} f32 for [${shape.join(",")}]`,
			);
		const st = new Storage(Math.max(4, n * 4), "f32", null);
		st.view = view;
		st.viewGraph = graph;
		st.pinned = true;
		return new GpuTensor([...shape], "f32", st);
	}

	/**
	 * Record `fn` (nn ops) straight into `graph`, a caller's ComputeGraph, instead of a graph of its
	 * own: photoprep / gpu-raster / gpgpu nodes before and after share the one submission and every
	 * buffer, with no copy. Synchronous; nothing is compiled or run here. Tensors reachable from the
	 * result are outputs: read them as views with `toView(graph, t)` (bind them in later nodes, or
	 * `run({ read: [viewRange(view, nn.bufferOf(t))] })`). They hold valid data after the graph ran;
	 * `dispose` them after that. Everything else is graph scratch.
	 */
	forwardInto<R>(graph: ComputeGraph, fn: () => R): R {
		if (this.rec) return fn();
		void this.flushImplicit();
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
		this.runtime.lowerInto(graph, rec, this.collectOutputs(out, rec));
		return out;
	}

	/** The view of a tensor in `graph`: an output of forwardInto, or a ready tensor imported on demand. */
	toView(graph: ComputeGraph, t: Tensor): GraphDataView<"float32"> {
		const g = t as GpuTensor;
		const st = g.st;
		if (st.view && st.viewGraph === graph) return st.view;
		if (st.state !== "ready" || !st.buffer || g.dtype !== "f32")
			throw new Error(`nn: toView of a ${st.state} ${g.dtype} tensor`);
		const view = graph.importView(
			`nn-view${st.id}`,
			st.buffer,
			"float32",
			numel(g.shape),
		);
		if (!st.pinned) {
			st.view = view;
			st.viewGraph = graph;
		}
		return view;
	}

	private collectOutputs(out: unknown, rec: Recording): Set<Storage> {
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
		return outs;
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

	/**
	 * Give the runtime's free-list GPU memory back (in queue order, after pending steps). Live tensors and
	 * weights stay; the runtime remains usable (nn/registry.ts releaseNn drops it from the registry).
	 */
	release(): Promise<void> {
		return this.runtime.enqueue(() => this.runtime.trim());
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
		const outs = this.collectOutputs(out, rec);
		await Promise.all([pending, this.runtime.flush(rec, outs)]);
		return out;
	}

	scope<R>(name: string, fn: () => R): R {
		const outer = this.scopePath;
		this.scopePath = outer ? `${outer}/${name}` : name;
		try {
			return fn();
		} finally {
			this.scopePath = outer;
		}
	}

	async readLater(t: Tensor, into?: Float32Array): Promise<Float32Array> {
		const values = await this.read(t);
		if (!into) return values;
		into.set(values);
		return into;
	}

	compile<R>(
		key: string,
		inputShapes: readonly (readonly number[])[],
		fn: (inputs: Tensor[]) => R,
	): Promise<GpuCompiled<R>> {
		const id = `${key}|${inputShapes.map((s) => s.join("x")).join(";")}`;
		let c = this.compiledForwards.get(id);
		if (!c) {
			c = this.buildCompiled(id, inputShapes, fn as (i: Tensor[]) => unknown);
			this.compiledForwards.set(id, c);
			c.catch(() => this.compiledForwards.delete(id));
		}
		return c as Promise<GpuCompiled<R>>;
	}

	private async buildCompiled(
		id: string,
		inputShapes: readonly (readonly number[])[],
		fn: (inputs: Tensor[]) => unknown,
	): Promise<GpuCompiled<unknown>> {
		await this.flushImplicit();
		if (this.rec) throw new Error("nn: compile() inside forward()");
		const rec = new Recording();
		const inputs = inputShapes.map((shape) => {
			const st = new Storage(Math.max(4, numel(shape) * 4), "f32", null);
			st.buffer = this.runtime.allocateExact(st.bytes);
			st.pinned = true;
			return new GpuTensor([...shape], "f32", st);
		});
		this.rec = rec;
		let out: unknown;
		try {
			out = fn(inputs);
		} catch (e) {
			for (const s of rec.produced) s.state = "dead";
			for (const t of inputs) t.st.buffer?.destroy();
			throw e;
		} finally {
			this.rec = null;
		}
		const outs = this.collectOutputs(out, rec);
		for (const s of outs) s.pinned = true;
		const graph = new ComputeGraph<void>(this.device, `nn-compiled/${id}`);
		const imported = this.runtime.lowerInto(graph, rec, outs);
		await graph.compileAsync();
		return new GpuCompiled(this, graph, id, inputs, imported, out, outs);
	}

	/** @internal GpuCompiled */
	forgetCompiled(id: string) {
		this.compiledForwards.delete(id);
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
		const lumaOp = lumaBinaryOp(op);
		const desc = naryDesc(
			`bin-${op}`,
			["a", "b"],
			[this.operand(a, out), this.operand(b, out)],
			out,
			binaryExpr(op),
		);
		if (
			this.lumaOps.enabled &&
			lumaOp &&
			typeof a !== "number" &&
			typeof b !== "number" &&
			a.dtype === "f32" &&
			b.dtype === "f32" &&
			numel(a.shape) === numel(out) &&
			numel(b.shape) === numel(out)
		)
			return this.lumaNode(
				lumaBinary(lumaOp, numel(out)),
				[a, b],
				[out],
				desc,
			)[0];
		const ins = [a, b].filter((v): v is GpuTensor => typeof v !== "number");
		return this.one(ewKernel(desc), ins, out, { ew: desc });
	}

	pWhere(
		c: GpuTensor,
		a: GpuTensor | number,
		b: GpuTensor | number,
		out: number[],
	) {
		const desc = naryDesc(
			"where",
			["c", "a", "b"],
			[this.operand(c, out), this.operand(a, out), this.operand(b, out)],
			out,
			"select(b, a, c != 0.0)",
		);
		const ins = [c, a, b].filter((v): v is GpuTensor => typeof v !== "number");
		return this.one(ewKernel(desc), ins, out, { ew: desc });
	}

	pUnary(op: UnaryPrim, x: GpuTensor, alpha: number, beta: number) {
		return this.one(
			unaryKernel(op, x.dtype, numel(x.shape), alpha, beta),
			[x],
			[...x.shape],
			{
				act: { op, alpha, beta },
				ew: unaryDesc(op, x.dtype, [...x.shape], alpha, beta),
			},
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
			{
				ln: {
					dw: w?.dtype ?? null,
					db: b?.dtype ?? null,
					rows,
					C,
					eps,
				},
			},
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
		// a 2-D transpose of a plain f32 matrix runs on luma's GPUTranspose (bench: 1.4-2x faster)
		if (
			this.lumaOps.enabled &&
			x.dtype === "f32" &&
			offset === 0 &&
			numel(out) === numel(x.shape)
		) {
			const c = coalesce(out, [strides]);
			if (
				c.shape.length === 2 &&
				c.sets[0][0] === 1 &&
				c.sets[0][1] === c.shape[0]
			)
				return this.lumaNode(
					lumaTranspose(c.shape[1], c.shape[0]),
					[x],
					[out],
				)[0];
		}
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
				scope: this.scopePath,
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
		// one long row: GPUReduction is multi-workgroup (bench: 2.5x at 2^20, 10x at 2^22)
		if (
			this.lumaOps.enabled &&
			x.dtype === "f32" &&
			outer === 1 &&
			inner === 1 &&
			len >= this.lumaOps.reduceMin &&
			(op === "sum" || op === "mean" || op === "max" || op === "min")
		) {
			const r = this.lumaNode(
				lumaReduce(op === "mean" ? "sum" : op, len),
				[x],
				[out],
			)[0];
			return op === "mean" ? this.scale(r, 1 / len) : r;
		}
		return this.one(reduceKernel(op, x.dtype, outer, len, inner), [x], out);
	}

	private fftDims(h: number, w: number) {
		for (const [name, n] of [
			["H", h],
			["W", w],
		] as const)
			if (n < 2 || n > 2048 || (n & (n - 1)) !== 0)
				throw new Error(
					`nn: rfft2 ${name}=${n} must be a power of two from 2 to 2048 (luma GPUFFT2D)`,
				);
	}

	rfft2(x: Tensor): GpuTensor {
		const g = x as GpuTensor;
		const r = g.shape.length;
		if (r < 2) throw new Error("nn: rfft2 needs at least 2 dims");
		const [h, w] = g.shape.slice(-2);
		this.fftDims(h, w);
		const batch = numel(g.shape) / (h * w);
		const k = rfftKernels(batch, h, w);
		const n2 = [batch * h * w * 2];
		const [z] = this.node(k.pack, [g], [n2]);
		const [f] = this.lumaNode(lumaFft2d("forward", batch, h, w), [z], [n2]);
		return this.node(
			k.crop,
			[f],
			[[...g.shape.slice(0, -2), h, (w >> 1) + 1, 2]],
		)[0];
	}

	irfft2(x: Tensor, o: { width?: number } = {}): GpuTensor {
		const g = x as GpuTensor;
		const r = g.shape.length;
		if (r < 3 || g.shape[r - 1] !== 2)
			throw new Error("nn: irfft2 needs [..., H, W/2+1, 2]");
		const [h, wf] = g.shape.slice(-3, -1);
		const w = o.width ?? 2 * (wf - 1);
		if ((w >> 1) + 1 !== wf)
			throw new Error(`nn: irfft2 width ${w} does not match ${wf} bins`);
		this.fftDims(h, w);
		const batch = numel(g.shape) / (h * wf * 2);
		const k = irfftKernels(batch, h, w);
		const n2 = [batch * h * w * 2];
		const [z] = this.node(k.expand, [g], [n2]);
		const [f] = this.lumaNode(lumaFft2d("inverse", batch, h, w), [z], [n2]);
		return this.node(k.real, [f], [[...g.shape.slice(0, -3), h, w]])[0];
	}

	pTopk(x: GpuTensor, rows: number, len: number, k: number, out: number[]) {
		if (
			this.lumaOps.enabled &&
			(x.dtype === "f32" || !getKernelCaps().legacy) &&
			rows === 1 &&
			len >= this.lumaOps.topkMin
		) {
			// luma GPUSort (stable radix) of (key, index): 3x faster than the bitonic nodes at 786k (f16 inputs
			// widen in the key transform, so they take this path too)
			const plan = lumaTopkPlan(len, k, x.dtype);
			const [keys, idx] = this.node(plan.init, [x], [[len], [len]]);
			const [sk, sv] = this.lumaNode(plan.sort, [keys, idx], [[len], [len]]);
			const [values, indices] = this.node(plan.final, [sk, sv], [out, out]);
			return { values, indices };
		}
		const plan = topkPlan(x.dtype, rows, len, k);
		const [keys, idx] = this.node(
			plan.init,
			[x],
			[[rows * plan.P], [rows * plan.P]],
		);
		const rec = this.current();
		for (const s of plan.steps)
			rec.nodes.push({
				scope: this.scopePath,
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

/**
 * A forward compiled by GpuNn.compile: one owned ComputeGraph over persistent input buffers (written
 * with queue writes) and persistent output buffers (`outputs`, valid after a run's submit, overwritten
 * by the next run: read them on the GPU in queue order, or through run()). Every call is encoded and
 * submitted synchronously when the runtime is idle, so calls pipeline: while run N's readback maps,
 * run N+1 is already on the queue.
 */
export class GpuCompiled<R> implements CompiledForward<R> {
	private readonly tensors: GpuTensor[];
	private readonly reads: { buffer: Buffer; size: number }[];
	private disposed = false;

	constructor(
		private readonly nn: GpuNn,
		private readonly graph: ComputeGraph<void>,
		private readonly id: string,
		private readonly inputs: GpuTensor[],
		private readonly imported: Map<Storage, string>,
		/** the persistent output tensors, shaped like fn's return value */
		readonly outputs: R,
		private readonly outStorages: Set<Storage>,
	) {
		this.tensors = collectTensors(outputs) as GpuTensor[];
		this.reads = this.tensors.map((t) => {
			if (t.st.state !== "ready" || !t.st.buffer)
				throw new Error(`nn: compiled output is a ${t.st.state} tensor`);
			return {
				buffer: t.st.buffer,
				size: numel(t.shape) * (t.dtype === "f16" ? 2 : 4),
			};
		});
	}

	/** Write / rebind the inputs; the buffer overrides for graph.runOwned. */
	private bind(values: readonly CompiledInput[]) {
		let buffers: Record<string, Buffer> | undefined;
		values.forEach((v, i) => {
			const input = this.inputs[i];
			if (!input)
				throw new Error(
					`nn: compiled forward has ${this.inputs.length} inputs`,
				);
			if (v instanceof Float32Array) {
				if (v.length !== numel(input.shape))
					throw new Error(
						`nn: compiled input ${i} has ${v.length} values for [${input.shape.join(",")}]`,
					);
				(input.st.buffer as Buffer).write(v);
				return;
			}
			const t = v as GpuTensor;
			// rebinding an imported buffer builds a new bind group for the nodes that read it
			if (t.st.state !== "ready" || !t.st.buffer || t.dtype !== "f32")
				throw new Error(
					`nn: compiled input ${i} is a ${t.st.state} ${t.dtype} tensor`,
				);
			const handle = this.imported.get(input.st);
			if (handle) {
				buffers ??= {};
				buffers[handle] = t.st.buffer;
			}
		});
		return buffers;
	}

	run(values: readonly CompiledInput[] = []): Promise<Readback<R>> {
		return this.nn.runtime
			.enqueue(() => ({
				// wrapped: enqueue must not wait for the readback (the next frame encodes meanwhile)
				done: this.graph.runOwned(undefined, {
					buffers: this.bind(values),
					read: this.reads,
				}),
			}))
			.then(({ done }) => done)
			.then(({ data }) => {
				const out = new Map<Tensor, Float32Array>();
				this.tensors.forEach((t, i) => {
					const n = numel(t.shape);
					out.set(
						t,
						t.dtype === "f16"
							? halfToFloat32(new Uint16Array(data[i], 0, n))
							: new Float32Array(data[i], 0, n),
					);
				});
				return mapTensors(this.outputs, (t) => out.get(t)) as Readback<R>;
			});
	}

	submit(values: readonly CompiledInput[] = []): Promise<void> {
		return this.nn.runtime
			.enqueue(() => ({
				done: this.graph.runOwned(undefined, { buffers: this.bind(values) }),
			}))
			.then(({ done }) => done)
			.then(() => undefined);
	}

	dispose() {
		if (this.disposed) return;
		this.disposed = true;
		this.nn.forgetCompiled(this.id);
		this.graph.destroy();
		for (const t of this.inputs) t.st.buffer?.destroy();
		for (const s of this.outStorages) {
			if (s.buffer) {
				if (s.exact) s.buffer.destroy();
				else this.nn.runtime.recycle(s.buffer);
			}
			s.buffer = null;
			s.state = "disposed";
		}
	}
}
