// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The GPU backend's runtime: lazy tensors, recordings and their lowering onto ONE core ComputeGraph
// per forward.
// - An op records a node (kernel spec, input / output storages, parameter words, workgroups) and
//   returns tensors whose storage is pending.
// - flush() turns a recording into a graph: storages that already hold a buffer (weights, fromArray,
//   earlier outputs) are imports, the recording's outputs are imports bound to buffers from the
//   runtime's free list, everything else is a graph transient (aliased by the graph compiler, so a
//   forward reuses scratch). Parameter words of all nodes live in one constant buffer owned by the
//   graph. Graphs are cached by their structure (cachedGraph group: the runtime's graphGroup, "nn" by
//   default; eager recordings under `${graphGroup}/once`), so a repeated forward with the same shapes
//   re-encodes a compiled graph.
// - Every GPU step (writes, graph runs, readback copies) goes through one promise chain, so queue
//   order is program order and buffers can be recycled as soon as a tensor is disposed.

import { Buffer, type Device, type Texture } from "@luma.gl/core";
import {
	purgeBuffers,
	recycleBuffer,
	takeBuffer,
} from "#/lib/gpu/core/buffer-pool";
import { type ComputeGraph, cachedGraph } from "#/lib/gpu/core/graph";
import type { KernelSpec } from "#/lib/gpu/core/kernel";
import type { GraphDataView } from "#/lib/gpu/core/luma";
import { submit } from "#/lib/gpu/core/queue";
import { stageReads } from "#/lib/gpu/core/readback";
import { numel } from "../shape";
import type { DType, Tensor } from "../types";
import { fuseElementwise, fuseLayerNorm } from "./fusion";
import type { EwDesc } from "./k-elementwise";
import type { LayerNormDesc } from "./k-fused";

const STORAGE = Buffer.STORAGE | Buffer.COPY_SRC | Buffer.COPY_DST;

export type StorageState = "pending" | "ready" | "dead" | "disposed";

export class Storage {
	static next = 0;
	readonly id = Storage.next++;
	buffer: Buffer | null = null;
	state: StorageState;
	/** recording that produces it (pending only) */
	rec: Recording | null;
	/** user disposed it while pending: not an output of an implicit flush */
	dropped = false;
	/** weights: freed with their Weights, not by dispose(tensor) */
	pinned = false;
	/** an output that gets its own exactly sized buffer instead of a pooled one (load-time weights) */
	exact = false;
	/** an input living in a caller's ComputeGraph (fromView), or the output view of a forwardInto */
	view: GraphDataView<"float32"> | null = null;
	viewGraph: ComputeGraph | null = null;
	constructor(
		readonly bytes: number,
		readonly dtype: DType,
		rec: Recording | null,
	) {
		this.rec = rec;
		this.state = rec ? "pending" : "ready";
	}
}

export class GpuTensor implements Tensor {
	constructor(
		readonly shape: readonly number[],
		readonly dtype: DType,
		readonly st: Storage,
	) {}
}

/** A slot of a luma operator node: `len` elements read / written as `format` (same bytes as the f32 storage). */
export type LumaSlot = {
	len: number;
	format: "float32" | "uint32" | "float32x2";
};

/**
 * A node run by a luma operator (GPUMatMul-style contributor) instead of an nn kernel: `add` puts it
 * in the graph with views of its input / output storages. `key` identifies the operator and its
 * parameters (it is part of the graph cache key).
 */
export type LumaCall = {
	key: string;
	ins: LumaSlot[];
	outs: LumaSlot[];
	add(g: ComputeGraph, ins: GraphDataView[], outs: GraphDataView[]): void;
};

/** `binding` (a graph buffer handle, or already a view of the caller's graph) as a typed view. */
function asView(
	g: ComputeGraph,
	binding: unknown,
	slot: LumaSlot,
): GraphDataView {
	if (binding && typeof binding === "object" && "format" in binding)
		return binding as GraphDataView;
	return g.view(binding as never, slot.format as never, slot.len);
}

function addLuma(
	g: ComputeGraph,
	call: LumaCall,
	ins: unknown[],
	outs: unknown[],
) {
	call.add(
		g,
		ins.map((b, i) => asView(g, b, call.ins[i])),
		outs.map((b, i) => asView(g, b, call.outs[i])),
	);
}

export type Node = {
	/** kernel nodes; absent on a luma node */
	spec?: KernelSpec;
	/** a node run by a luma operator (spec, textures, meta and wg unused) */
	luma?: LumaCall;
	/** sampled textures, bound to the spec's texture entries (before the storage inputs) */
	textures?: Texture[];
	inputs: Storage[];
	outputs: Storage[];
	meta: number[];
	wg: [number, number, number];
	/** a unary elementwise node: its op (a candidate for epilogue fusion) */
	act?: Activation;
	/** an elementwise node (unary / binary / where, also a luma add / mul): fusable (fusion.ts) */
	ew?: EwDesc;
	/** a layerNorm node: what fusion needs to rebuild it around a producer (fusion.ts) */
	ln?: LayerNormDesc;
	/** the caller's `nn.scope(name, …)` path when it was recorded (profiler labels) */
	scope?: string;
	/** a node with an activation epilogue: the same node with `act` fused into its output */
	fuse?: (act: Activation) => {
		spec: KernelSpec;
		meta: number[];
		wg: [number, number, number];
	};
};

export type Activation = { op: string; alpha: number; beta: number };

/**
 * Epilogue fusion: a unary node whose input is the single output of a fusable node (GEMM / conv),
 * consumed by nothing else and not a forward output, folds into that node's store. Returns the node
 * list without the folded unary nodes.
 */
export function fuseEpilogues(nodes: Node[], outputs: Set<Storage>): Node[] {
	const consumers = new Map<Storage, number>();
	const producers = new Map<Storage, Node[]>();
	for (const n of nodes) {
		for (const s of n.inputs) consumers.set(s, (consumers.get(s) ?? 0) + 1);
		for (const s of n.outputs) {
			const l = producers.get(s);
			if (l) l.push(n);
			else producers.set(s, [n]);
		}
	}
	const dropped = new Set<Node>();
	for (const u of nodes) {
		if (!u.act) continue;
		const src = u.inputs[0];
		const ps = producers.get(src);
		const p = ps?.length === 1 ? ps[0] : null;
		if (!p?.fuse || p.outputs.length !== 1) continue;
		if (consumers.get(src) !== 1 || outputs.has(src)) continue;
		Object.assign(p, p.fuse(u.act));
		p.fuse = undefined;
		p.outputs = [u.outputs[0]];
		dropped.add(u);
	}
	return dropped.size ? nodes.filter((n) => !dropped.has(n)) : nodes;
}

/**
 * A graph node's id: scope path, position and op name (`encoder.block3/n12:ew-bin-add-ff`), so the
 * profiler (getGpuProfile `${graph}/${node}`) and the /dev/graph inspector rows map to layers.
 */
export function nodeLabel(n: Node, i: number): string {
	const op = n.luma ? n.luma.key : (n.spec as KernelSpec).id;
	const name = op.replace(/^nn\//, "").replace(/\|.*$/, "").slice(0, 48);
	return `${n.scope ? `${n.scope}/` : ""}n${i}:${name}`;
}

export class Recording {
	nodes: Node[] = [];
	produced: Storage[] = [];
}

/** 53-bit string hash (cyrb53). */
function hash(s: string): string {
	let h1 = 0xdeadbeef;
	let h2 = 0x41c6ce57;
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		h1 = Math.imul(h1 ^ c, 2654435761);
		h2 = Math.imul(h2 ^ c, 1597334677);
	}
	h1 =
		Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^
		Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 =
		Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^
		Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

const graphSerial = new WeakMap<ComputeGraph, number>();

const pad4 = (n: number) => Math.max(4, Math.ceil(n / 4) * 4);

export type RuntimeStats = {
	graphs: number;
	graphHits: number;
	nodes: number;
	freeBuffers: number;
	liveBytes: number;
};

/** Cached forward graphs per group (LRU), and eager one-off graphs per `${group}/once`. */
const FORWARD_GRAPHS = 48;
const ONCE_GRAPHS = 8;

export class Runtime {
	private chain: Promise<unknown> = Promise.resolve();
	private align: number;
	readonly stats: RuntimeStats = {
		graphs: 0,
		graphHits: 0,
		nodes: 0,
		freeBuffers: 0,
		liveBytes: 0,
	};

	constructor(
		readonly device: Device,
		readonly graphGroup = "nn",
	) {
		this.align = device.limits.minStorageBufferOffsetAlignment || 256;
	}

	/** Steps queued or running (a synchronous step on an idle runtime runs at once, in the caller's turn). */
	private active = 0;

	/**
	 * Run `step` after every earlier step; its error goes to its caller only. With nothing queued the
	 * step starts right now, so a synchronous step (a persistent forward's write + encode + submit)
	 * is on the GPU queue before this returns: a frame loop's N+1 never waits a microtask hop on N.
	 */
	enqueue<T>(step: () => T | Promise<T>): Promise<T> {
		if (this.active === 0) {
			let r: T | Promise<T>;
			try {
				r = step();
			} catch (e) {
				return Promise.reject(e);
			}
			if (!(r instanceof Promise)) return Promise.resolve(r);
			this.active++;
			const settle = () => {
				this.active--;
			};
			this.chain = r.then(settle, settle);
			return r;
		}
		this.active++;
		const p = this.chain.then(step);
		const settle = () => {
			this.active--;
		};
		this.chain = p.then(settle, settle);
		return p;
	}

	/** A buffer of at least `bytes` from the device's shared free pool (power-of-two capacities). */
	allocate(bytes: number): Buffer {
		const b = takeBuffer(this.device, bytes, STORAGE, "nn-tensor");
		this.stats.liveBytes += b.byteLength;
		return b;
	}

	/**
	 * Hand a buffer back to the shared pool once every step queued so far has run. Queue-safe: each
	 * enqueued step submits its work synchronously before it resolves (a graph run submits inside
	 * run(), a readback inside its step, a write is queue.writeBuffer), so when this step runs the
	 * chain has submitted every earlier user of `b`; another owner taking it afterwards writes after
	 * those commands in queue order. (Recycling at once, as the private free list did, is only safe
	 * within one runtime.)
	 */
	recycle(b: Buffer) {
		// stats: freeBuffers = hand-backs queued behind the chain, liveBytes = taken and not yet back
		this.stats.freeBuffers++;
		const device = this.device;
		void this.enqueue(() => {
			this.stats.freeBuffers--;
			this.stats.liveBytes -= b.byteLength;
			recycleBuffer(device, b);
		});
	}

	/** Destroy every idle buffer of the shared pool (memory pressure / teardown). */
	trim() {
		purgeBuffers(this.device);
	}

	/** Live exact (weight) buffers, for the device memory ledger (weightBytes). */
	private exactBuffers = new Set<Buffer>();

	/** A dedicated buffer of exactly `bytes` (weights; destroyed, never recycled). */
	allocateExact(bytes: number): Buffer {
		const b = this.device.createBuffer({
			id: "nn-weight",
			usage: STORAGE,
			byteLength: bytes,
		});
		this.exactBuffers.add(b);
		return b;
	}

	/** Bytes of the live weight buffers (destroyed ones are pruned here). */
	weightBytes(): number {
		let n = 0;
		for (const b of this.exactBuffers)
			if (b.destroyed) this.exactBuffers.delete(b);
			else n += b.byteLength;
		return n;
	}

	/** A ready storage holding `data` (written in queue order). */

	upload(data: ArrayBufferView, dtype: DType, exact = false): Storage {
		const st = new Storage(pad4(data.byteLength), dtype, null);
		st.buffer = exact ? this.allocateExact(st.bytes) : this.allocate(st.bytes);
		const buf = st.buffer;
		let bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
		if (bytes.byteLength % 4) {
			const p = new Uint8Array(pad4(bytes.byteLength));
			p.set(bytes);
			bytes = p;
		}
		const copy = bytes.slice();
		void this.enqueue(() => buf.write(copy));
		return st;
	}

	/** Copy a storage back (queued after every earlier step). */
	read(st: Storage): Promise<ArrayBuffer> {
		const buf = st.buffer;
		if (!buf) throw new Error("nn: read of a tensor without storage");
		return this.enqueue(() => {
			const enc = this.device.createCommandEncoder({ id: "nn-read" });
			const staged = stageReads(this.device, enc, [
				{ buffer: buf, size: st.bytes },
			]);
			try {
				submit(this.device, enc);
			} catch (e) {
				staged.cancel();
				throw e;
			}
			// the copy is in the queue: later steps may proceed while this maps
			return { read: staged.read };
		}).then(async ({ read }) => (await read())[0]);
	}

	/**
	 * Lower `rec` onto a ComputeGraph and queue its run. `outputs` (storages produced by `rec`) get
	 * buffers now; every other produced storage becomes dead scratch.
	 */
	/** Dead-code elimination, epilogue fusion and storage states; the nodes that remain. */
	private prepare(rec: Recording, outputs: Set<Storage>, warm = false): Node[] {
		// dead-code elimination: keep nodes that (transitively) feed an output
		const live = new Set<Storage>(outputs);
		const keep: Node[] = [];
		const nodes = fuseLayerNorm(
			fuseElementwise(fuseEpilogues(rec.nodes, outputs), outputs),
			outputs,
		);
		for (let i = nodes.length - 1; i >= 0; i--) {
			const n = nodes[i];
			if (!n.outputs.some((o) => live.has(o))) continue;
			keep.push(n);
			for (const s of n.inputs) live.add(s);
		}
		keep.reverse();
		for (const s of rec.produced) {
			s.rec = null;
			if (outputs.has(s) && !warm) {
				s.buffer = s.exact
					? this.allocateExact(s.bytes)
					: this.allocate(s.bytes);
				s.state = "ready";
			} else s.state = "dead";
		}
		return keep;
	}

	/**
	 * Lower `rec` into a caller's ComputeGraph (no cache, no submit): inputs made by fromView bind as
	 * the caller's views, ready buffers are imported, outputs get buffers from the free list and a view
	 * (`Storage.view`), the rest is graph scratch. The caller compiles and runs the graph; outputs are
	 * valid after that run.
	 */
	lowerInto(
		g: ComputeGraph,
		rec: Recording,
		outputs: Set<Storage>,
	): Map<Storage, string> {
		const keep = this.prepare(rec, outputs);
		const imported = new Map<Storage, string>();
		if (!keep.length) return imported;
		const k = (graphSerial.get(g) ?? 0) + 1;
		graphSerial.set(g, k);
		const pre = `nn${k}/`;
		const produced = new Set(rec.produced);
		const bound = new Map<Storage, unknown>();
		const meta: number[] = [];
		const metaAt: number[] = [];
		const words = this.align / 4;
		for (const n of keep) {
			metaAt.push(meta.length);
			const len = Math.ceil(Math.max(1, n.meta.length) / words) * words;
			for (let i = 0; i < len; i++) meta.push(n.meta[i] ?? 0);
		}
		const metaBuf = this.device.createBuffer({
			id: "nn-meta",
			usage: STORAGE,
			data: new Uint32Array(meta),
		});
		g.own([metaBuf]);
		const mh = g.importBuffer(`${pre}meta`, metaBuf.byteLength, metaBuf);
		const texs = new Map<Texture, ReturnType<ComputeGraph["importTexture"]>>();
		const name = (s: Storage) => {
			let b = bound.get(s);
			if (b) return b;
			const id = `${pre}s${s.id}`;
			if (s.view) {
				if (s.viewGraph !== g)
					throw new Error("nn: a fromView tensor from another graph");
				b = s.view;
			} else if (outputs.has(s)) {
				const buf = s.buffer as Buffer;
				b = g.importBuffer(id, s.bytes, buf);
				s.view = g.view(b as never, "float32", s.bytes / 4);
				s.viewGraph = g;
			} else if (s.state === "ready" && !produced.has(s)) {
				b = g.importBuffer(id, s.bytes, s.buffer as Buffer);
				imported.set(s, id);
			} else if (s.state === "dead" && produced.has(s)) {
				b = g.transientBuffer(id, s.bytes);
			} else
				throw new Error(
					`nn: a forward used a tensor that is ${s.state} (disposed, or scratch of an earlier forward)`,
				);
			bound.set(s, b);
			return b;
		};
		keep.forEach((n, i) => {
			if (n.luma) {
				addLuma(g, n.luma, n.inputs.map(name), n.outputs.map(name));
				return;
			}
			const spec = n.spec as KernelSpec;
			const bindings: Record<string, unknown> = {
				M: g.view(mh, "uint32", Math.max(1, n.meta.length), metaAt[i] * 4),
			};
			const tex = n.textures ?? [];
			tex.forEach((t, j) => {
				let h = texs.get(t);
				if (!h) {
					h = g.importTexture(
						{
							id: `${pre}tex${texs.size}`,
							format: t.format,
							width: t.width,
							height: t.height,
							usage: t.props.usage,
							dimension: "2d",
							depth: 1,
							mipLevels: 1,
							samples: 1,
						} as never,
						t as never,
					);
					texs.set(t, h);
				}
				bindings[spec.layout[1 + j][0]] = h;
			});
			const names = spec.layout.map(([nm]) => nm).slice(1 + tex.length);
			const all = [...n.inputs, ...n.outputs];
			names.forEach((nm, j) => {
				bindings[nm] = name(all[j]);
			});
			g.addKernel({
				id: `${pre}${nodeLabel(n, i)}`,
				spec,
				bindings: bindings as never,
				workgroups: n.wg,
			});
		});
		this.stats.nodes += keep.length;
		return imported;
	}

	/** `once`: an eager (implicit) recording, cached under `${graphGroup}/once` with a small cap. */
	flush(
		rec: Recording,
		outputs: Set<Storage>,
		once = false,
		warm = false,
	): Promise<void> {
		// warm: build and cache the graph exactly as a real forward would (outputs keep their slot names,
		// but get no buffers and everything produced ends dead), compile it, never run it
		const keep = this.prepare(rec, outputs, warm);
		if (!keep.length) return Promise.resolve();
		const produced = new Set(rec.produced);
		// slots: imports (x), outputs (o), transients (t), in first-use order
		const slot = new Map<Storage, string>();
		const decl: string[] = [];
		const imports: Storage[] = [];
		const outs: Storage[] = [];
		const trans: Storage[] = [];
		const name = (s: Storage) => {
			let n = slot.get(s);
			if (n) return n;
			if (s.view && !s.buffer)
				throw new Error(
					"nn: a fromView tensor can only be used inside forwardInto(graph, …) of its graph",
				);
			if (outputs.has(s)) {
				n = `o${outs.length}`;
				outs.push(s);
			} else if (s.state === "ready" && !produced.has(s)) {
				n = `x${imports.length}`;
				imports.push(s);
			} else if (s.state === "dead" && produced.has(s)) {
				n = `t${trans.length}`;
				trans.push(s);
			} else
				throw new Error(
					`nn: a forward used a tensor that is ${s.state} (disposed, or scratch of an earlier forward)`,
				);
			slot.set(s, n);
			decl.push(`${n}:${s.bytes}`);
			return n;
		};
		const texSlot = new Map<Texture, string>();
		for (const n of keep)
			for (const t of n.textures ?? [])
				if (!texSlot.has(t)) {
					const id = `tex${texSlot.size}`;
					texSlot.set(t, id);
					decl.push(`${id}:${t.width}x${t.height}:${t.format}`);
				}
		const words = this.align / 4;
		const metaOffsets: number[] = [];
		let metaWords = 0;
		const parts: string[] = [];
		for (const n of keep) {
			const ins = [
				...(n.textures ?? []).map((t) => texSlot.get(t)),
				...n.inputs.map(name),
			].join(",");
			const os = n.outputs.map(name).join(",");
			metaOffsets.push(metaWords);
			metaWords += Math.ceil(Math.max(1, n.meta.length) / words) * words;
			parts.push(
				`${n.luma ? n.luma.key : (n.spec as KernelSpec).id}(${ins})>${os}@${n.meta.join(",")}/${n.wg.join(",")}${n.scope ? `#${n.scope}` : ""}`,
			);
		}
		const full = `${decl.join(" ")}\n${parts.join("\n")}`;
		const key = hash(full);
		this.stats.nodes += keep.length;

		const meta = new Uint32Array(metaWords);
		keep.forEach((n, i) => {
			meta.set(n.meta, metaOffsets[i]);
		});
		const device = this.device;
		const build = (g: ComputeGraph<void>) => {
			const handles = new Map<
				string,
				ReturnType<ComputeGraph["importBuffer"]>
			>();
			for (const [s, n] of slot) {
				const bytes = s.bytes;
				handles.set(
					n,
					n[0] === "t" ? g.transientBuffer(n, bytes) : g.importBuffer(n, bytes),
				);
			}
			const texHandles = new Map<
				Texture,
				ReturnType<ComputeGraph["importTexture"]>
			>();
			for (const [t, id] of texSlot)
				texHandles.set(
					t,
					g.importTexture({
						id,
						format: t.format,
						width: t.width,
						height: t.height,
						usage: t.props.usage,
						dimension: "2d",
						depth: 1,
						mipLevels: 1,
						samples: 1,
					} as never),
				);
			const metaBuf = device.createBuffer({
				id: "nn-meta",
				usage: STORAGE,
				data: meta,
			});
			g.own([metaBuf]);
			const mh = g.importBuffer("meta", meta.byteLength, metaBuf);
			keep.forEach((n, i) => {
				if (n.luma) {
					addLuma(
						g,
						n.luma,
						n.inputs.map((s) => handles.get(slot.get(s) as string)),
						n.outputs.map((s) => handles.get(slot.get(s) as string)),
					);
					return;
				}
				const spec = n.spec as KernelSpec;
				const bindings: Record<string, unknown> = {
					M: g.view(
						mh,
						"uint32",
						Math.max(1, n.meta.length),
						metaOffsets[i] * 4,
					),
				};
				const tex = n.textures ?? [];
				tex.forEach((t, j) => {
					bindings[spec.layout[1 + j][0]] = texHandles.get(t);
				});
				const names = spec.layout.map(([nm]) => nm).slice(1 + tex.length);
				const all = [...n.inputs, ...n.outputs];
				names.forEach((nm, j) => {
					bindings[nm] = handles.get(slot.get(all[j]) as string);
				});
				g.addKernel({
					id: nodeLabel(n, i),
					spec,
					bindings: bindings as never,
					workgroups: n.wg,
				});
			});
			return full;
		};
		const group = once ? `${this.graphGroup}/once` : this.graphGroup;
		const cap = once ? ONCE_GRAPHS : FORWARD_GRAPHS;
		let k = key;
		let c = cachedGraph<void, string>(device, group, k, build, cap);
		// a hash collision: rebuild under a disambiguated key
		for (let j = 1; c.extra !== full; j++) {
			k = `${key}~${j}`;
			c = cachedGraph<void, string>(device, group, k, build, cap);
		}
		if (c.hit) this.stats.graphHits++;
		else this.stats.graphs++;
		const graph = c.graph;
		if (warm) {
			// off the run queue: a real forward is never held up behind a warm-up compile (concurrent
			// compileAsync calls on one graph share a single compilation)
			return graph.isCompiled
				? Promise.resolve()
				: graph.compileAsync().then(() => undefined);
		}
		const buffers: Record<string, Buffer> = {};
		imports.forEach((s, i) => {
			buffers[`x${i}`] = s.buffer as Buffer;
		});
		outs.forEach((s, i) => {
			buffers[`o${i}`] = s.buffer as Buffer;
		});
		const textures: Record<string, Texture> = {};
		for (const [t, id] of texSlot) textures[id] = t;
		return this.enqueue(async () => {
			if (!graph.isCompiled) await graph.compileAsync();
			await graph.run(undefined, { buffers, textures });
		});
	}
}

/** Bytes of an f32 tensor of `shape`. */
export const f32Bytes = (shape: readonly number[]) => pad4(numel(shape) * 4);
