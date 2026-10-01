// Multi-pass compute pipelines with GPU-resident intermediates, over gpu-core's GPUCommandGraph
// (experimental, WebGPU only; imported via core/luma.ts). The graph infers pass ordering from the
// declared buffer uses, aliases transient scratch across disjoint lifetimes, and times each node.
//
//   const g = new ComputeGraph<Params>(device, "relief");
//   const dem = g.importBuffer("dem", bytes);            // caller-owned, bound per run
//   const tmp = g.transientBuffer("tmp", bytes);         // graph-owned scratch
//   g.addKernel({ id: "grad", spec: GRAD, bindings: { dem, out: tmp }, workgroups: (p) => [p.n / 64] });
//   g.add(new GPUReduction({ input: g.view(tmp, "float32", n), output: g.view(ext, "float32", 2), operation: "extent" }));
//   g.compile();                                          // once
//   const { data } = await g.run(params, { buffers: { dem: demBuf, ext: extBuf }, read: [{ buffer: extBuf, size: 8 }] });
//
// Compile once, run many times; runs are serialised (the graph's scratch and timestamp slots are
// shared). Imported buffers can be read back through run({ read }); transients through a read node.
//
// Additions for the worker-realm graph migration (solve coarse, horizon march):
//   g.clearNode("zero-acc", acc);                          // zero a transient range before atomics / partial writes
//   g.addKernel({ ..., bindings: { acc }, writes: { acc: "atomic" } }); // compile() throws unless a clearNode
//                                                          // is scheduled before every use of "acc"
//   g.readNode("read", [acc, { buffer: out, size: (p) => p.n * 4 }]); // transient → readback slot
//   const { reads } = await g.run(p);                      // reads.read = [ArrayBuffer, ArrayBuffer]
//   await g.compileAsync();                                 // pipelines via createComputePipelineAsync
//   const e = cachedGraph(device, "solve", key, (g) => {...}); // shape-keyed LRU (transients have fixed sizes)
//   g.addKernel({ ..., condition: { id: "sun", source: "cpu", evaluate: (p) => !p.flat } }); // per-run skip
//
// Transients are NEVER zeroed by the graph, and a transient can alias another one whose lifetime ended
// earlier in the same encoding (or a previous encoding's bytes): anything read-modify-written
// (atomics, partial writes, accumulators) needs a clearNode first.
import {
	Buffer,
	type CommandEncoder,
	type Device,
	type QuerySet,
} from "@luma.gl/core";
import {
	type BindKind,
	encodeDispatch,
	type Kernel,
	type KernelSpec,
	kernel,
	kernelAsync,
} from "./kernel";
import { onLost, untilLost } from "./lifecycle";
import {
	type CompiledGPUCommandGraph,
	GPUCommandGraph,
	type GPUCommandGraphComputeExecutable,
	type GPUCommandGraphComputeNode,
	type GPUCommandGraphEncoding,
	type GPUCommandGraphTimingReport,
	type GPUNode,
	type GPUScalarFormat,
	GraphBufferHandle,
	type GraphBufferUsage,
	GraphDataView,
	type GraphImportedBuffer,
	type GraphImportedTexture,
	type GraphTextureDescriptor,
	type GraphTextureHandle,
} from "./luma";
import { clear, withLease } from "./pool";
import { profiling, recordGpuTime } from "./profile";
import { submit } from "./queue";
import { type ReadRange, type StagedRead, stageReads } from "./readback";

/** A graph buffer or a typed range of one (range offsets must be multiples of 256). */
export type GraphBinding = GraphBufferHandle | GraphDataView;

export type Workgroups = [number, number?, number?];

/**
 * A compute node running a core kernel. A binding is a handle (bound with its declared byteLength),
 * a data view (its exact range) or a GraphRange with a per-run size (e.g. capacity-keyed graphs that
 * bind exactly the bytes a call uses).
 */
export type KernelNode<P> = {
	id: string;
	spec: KernelSpec;
	/** one graph buffer / view per layout name of `spec` */
	bindings: Record<string, GraphBinding | GraphRange<P>>;
	/** fixed, or per run from the parameters */
	workgroups: Workgroups | ((parameters: P) => Workgroups);
	/** explicit predecessors beyond the ones inferred from buffer uses */
	dependsOn?: string[];
	/**
	 * How the kernel writes its storage bindings (default "full": every element later read is written
	 * by this dispatch). A transient written "partial" or "atomic" must have a clearNode scheduled
	 * before this node and before any other use of it in the encoding, or compile() throws (graph
	 * transients are never zeroed and alias other transients' bytes).
	 */
	writes?: Record<string, WriteMode>;
	/** Shorthand: these bindings are written "partial" (read-modify-write, needs a clear). */
	cleared?: string[];
	/**
	 * Record this dispatch only when `evaluate(parameters)` is true (GPUCommandGraph CPU condition,
	 * checked per encoding). A skipped node keeps its place in the schedule, so transient lifetimes,
	 * aliasing and the clear lint are those of the graph with the node; its outputs are then whatever
	 * the earlier nodes left (e.g. a clear node's zeros).
	 */
	condition?: KernelCondition<P>;
};

/** A KernelNode's CPU condition (GPUCommandGraph's CPU condition shape). */
export type KernelCondition<P> = Extract<
	NonNullable<GPUCommandGraphComputeNode<P>["condition"]>,
	{ source: "cpu" }
>;

/** How a kernel writes one of its storage bindings (KernelNode.writes). */
export type WriteMode = "full" | "partial" | "atomic";

/**
 * A byte range of a graph buffer for clearNode / readNode: a whole handle, a data view, or an explicit
 * { buffer, offset, size } whose size may depend on the run's parameters (copy sizes are CPU-side).
 */
export type GraphRange<P> =
	| GraphBufferHandle
	| GraphDataView
	| {
			buffer: GraphBufferHandle;
			offset?: number;
			size: number | ((parameters: P) => number);
	  };

/** Staged read-node copies of one encoding: read() resolves one ArrayBuffer per range, by node id. */
export type GraphReads = {
	/** staged slots neither read nor cancelled yet (a caller that drops these leaks the slots) */
	readonly pending: number;
	read: () => Promise<Record<string, ArrayBuffer[]>>;
	/** Return the slots unread (only when the encoder was NOT submitted). */
	cancel: () => void;
};

/**
 * Anything gpu-core's GPUCommandGraph.add takes: an op producing command nodes (GPUReduction,
 * GPUSort, GPUHistogram, GPUScan, … via getCommandNodes(graph); luma 10, visgl/luma.gl#3258
 * replaced 9.4's op.addToGraph(graph)), a raw command node, or a group of them.
 */
export type GraphOp<P> = GPUNode<P>;

const USE: Record<Exclude<BindKind, "texture">, GraphBufferUsage> = {
	uniform: "uniform",
	"read-only-storage": "storage-read",
	storage: "storage-read-write",
};

const STORAGE = Buffer.STORAGE | Buffer.COPY_SRC | Buffer.COPY_DST;

const handleOf = <P>(r: GraphRange<P>): GraphBufferHandle =>
	r instanceof GraphDataView || !(r instanceof GraphBufferHandle)
		? r.buffer
		: r;

/** Byte range of `r` for this run (views: their exact binding range, 4-byte padded). */
function rangeOf<P>(r: GraphRange<P>, parameters: P) {
	if (r instanceof GraphDataView)
		return {
			offset: r.byteOffset,
			size:
				Math.ceil(((r.length - 1) * r.byteStride + r.rowByteLength) / 4) * 4,
		};
	if (r instanceof GraphBufferHandle) return { offset: 0, size: r.byteLength };
	const size = typeof r.size === "function" ? r.size(parameters) : r.size;
	return { offset: r.offset ?? 0, size };
}

export class ComputeGraph<P = void> {
	readonly device: Device;
	readonly id: string;
	/** the underlying gpu-core graph, for ops this wrapper does not cover */
	readonly graph: GPUCommandGraph<P>;
	private compiled: CompiledGPUCommandGraph<P> | null = null;
	private compiling: Promise<CompiledGPUCommandGraph<P>> | null = null;
	private timestamps: QuerySet | null = null;
	/** clear audit: node id → handles it clears / writes partially or atomically / uses at all */
	private audit = {
		clears: new Map<string, GraphBufferHandle[]>(),
		partial: new Map<string, GraphBufferHandle[]>(),
		uses: new Map<string, GraphBufferHandle[]>(),
	};
	private readNodes = 0;
	/** read-node staging of the encoding in progress (set by encodeReads) */
	private staging: { id: string; staged: StagedRead }[] | null = null;

	constructor(device: Device, id: string) {
		this.device = device;
		this.id = id;
		this.graph = new GPUCommandGraph<P>(device, { id });
	}

	/** A caller-owned buffer, bound per run by `id` (or once via `buffer`). */
	importBuffer(
		id: string,
		byteLength: number,
		buffer?: GraphImportedBuffer,
		usage = STORAGE,
	): GraphBufferHandle {
		return this.graph.importBuffer({ id, byteLength, usage }, buffer);
	}

	/** Graph-owned scratch (aliased with other transients whose lifetimes do not overlap). */
	transientBuffer(id: string, byteLength: number, usage = STORAGE) {
		return this.graph.createTransientBuffer({ id, byteLength, usage });
	}

	/** A typed range over a graph buffer (what gpu-core ops take as input / output). */
	view<T extends GPUScalarFormat>(
		buffer: GraphBufferHandle,
		format: T,
		length: number,
		byteOffset = 0,
	): GraphDataView<T> {
		return this.graph.createDataView(buffer, { format, length, byteOffset });
	}

	/** A caller-owned texture (passthrough to GPUCommandGraph.importTexture). */
	importTexture(
		descriptor: GraphTextureDescriptor,
		texture?: GraphImportedTexture,
	): GraphTextureHandle {
		return this.graph.importTexture(descriptor, texture);
	}

	/** Add a compute node that dispatches a core kernel. */
	addKernel(node: KernelNode<P>): this {
		const { spec } = node;
		for (const [name, kind] of spec.layout)
			if (kind === "texture")
				throw new Error(
					`${this.id}/${node.id}: "${name}" is a texture binding (not supported in a graph)`,
				);
		for (const [name] of spec.layout)
			if (!node.bindings[name])
				throw new Error(`${this.id}/${node.id}: no binding for "${name}"`);
		const modes: Record<string, WriteMode> = { ...node.writes };
		for (const name of node.cleared ?? []) modes[name] ??= "partial";
		const partial: GraphBufferHandle[] = [];
		for (const [name, mode] of Object.entries(modes)) {
			const kind = spec.layout.find(([n]) => n === name)?.[1];
			if (kind !== "storage")
				throw new Error(
					`${this.id}/${node.id}: "${name}" is not a storage output`,
				);
			if (mode !== "full") partial.push(handleOf(node.bindings[name]));
		}
		this.audit.partial.set(node.id, partial);
		this.audit.uses.set(
			node.id,
			spec.layout.map(([name]) => handleOf(node.bindings[name])),
		);
		const executable = (k: Kernel): GPUCommandGraphComputeExecutable<P> => ({
			encode: ({ computePass, getBuffer, parameters }) => {
				const b: Record<
					string,
					{ buffer: Buffer; offset: number; size: number }
				> = {};
				for (const [name] of spec.layout) {
					// handles: their declared byteLength; views: their exact range; explicit ranges: the
					// run's { offset, size } (a binding narrower than a capacity-keyed buffer)
					const v = node.bindings[name];
					b[name] = {
						buffer: getBuffer(v instanceof GraphDataView ? v : handleOf(v)),
						...rangeOf(v, parameters),
					};
				}
				const w =
					typeof node.workgroups === "function"
						? node.workgroups(parameters)
						: node.workgroups;
				encodeDispatch(computePass, k, b, w[0], w[1] ?? 1, w[2] ?? 1);
			},
		});
		this.graph.addComputePass({
			id: node.id,
			dependsOn: node.dependsOn,
			condition: node.condition,
			resources: spec.layout.map(([name, kind]) => {
				const v = node.bindings[name];
				return {
					buffer: v instanceof GraphDataView ? v : handleOf(v),
					usage: USE[kind as keyof typeof USE],
				};
			}),
			compile: ({ device }) => executable(kernel(device, spec)),
			// same WGSL, module and descriptor as kernel(): identical results (core selftest)
			compileAsync: async ({ device }) =>
				executable(await kernelAsync(device, spec)),
		});
		return this;
	}

	/**
	 * Zero `target` (a whole transient / import, a view, or a parameter-sized range; offset and size
	 * must be multiples of 4) with the encoder's clearBuffer, ordered before every later node that
	 * uses the buffer. Required before any kernel that read-modify-writes a transient (see `cleared`).
	 */
	clearNode(
		id: string,
		target: GraphRange<P>,
		opts: { dependsOn?: string[] } = {},
	): this {
		const h = handleOf(target);
		this.graph.addCopyPass({
			id,
			dependsOn: opts.dependsOn,
			resources: [{ buffer: h, usage: "copy-destination" }],
			compile: () => ({
				encode: ({ commandEncoder, getBuffer, parameters }) => {
					const { offset, size } = rangeOf(target, parameters);
					if (offset % 4 || size % 4)
						throw new Error(
							`${this.id}/${id}: clear range ${offset}+${size} is not 4-byte aligned`,
						);
					if (size > 0) clear(commandEncoder, getBuffer(h), offset, size);
				},
			}),
		});
		this.audit.clears.set(id, [h]);
		this.audit.uses.set(id, [h]);
		return this;
	}

	/**
	 * Copy `targets` (transients or imports) into ONE core/readback staging slot at this point of the
	 * graph, so transients can be read without being promoted to imports. The copies are resolved by
	 * run() (`reads[id]`) or by encodeReads().read(). The graph keeps the buffers alive up to this node,
	 * so a later transient cannot alias them before the copy.
	 */
	readNode(
		id: string,
		targets: GraphRange<P>[],
		opts: { dependsOn?: string[] } = {},
	): this {
		const handles = targets.map(handleOf);
		this.audit.uses.set(id, handles);
		this.graph.addCopyPass({
			id,
			dependsOn: opts.dependsOn,
			resources: handles.map((buffer) => ({ buffer, usage: "copy-source" })),
			compile: ({ device }) => ({
				encode: ({ commandEncoder, getBuffer, parameters }) => {
					if (!this.staging)
						throw new Error(
							`${this.id}/${id}: a graph with read nodes is encoded with encodeReads() or run()`,
						);
					const ranges: ReadRange[] = targets.map((t, i) => ({
						buffer: getBuffer(handles[i]),
						...rangeOf(t, parameters),
					}));
					this.staging.push({
						id,
						staged: stageReads(device, commandEncoder, ranges),
					});
				},
			}),
		});
		this.readNodes++;
		return this;
	}

	/** Add a raw gpu-core compute node (custom encode). */
	addComputePass(node: Omit<GPUCommandGraphComputeNode<P>, "type">): this {
		this.graph.addComputePass(node);
		return this;
	}

	/** Add a gpu-core op (GPUReduction, GPUSort, …) built on this graph's handles. */
	add(op: GraphOp<P>): this {
		this.graph.add(op);
		return this;
	}

	/** Compile (once): schedules nodes, allocates transients, creates pipelines. */
	compile(): this {
		if (!this.compiled && this.compiling)
			throw new Error(`${this.id}: compileAsync() in flight`);
		if (!this.compiled) this.compiled = this.linted(this.graph.compile());
		return this;
	}

	/**
	 * The clear rule, against the scheduled order: every transient written "partial" / "atomic" needs a
	 * clearNode before that write and before any other use of it in the encoding. Destroys and throws.
	 */
	private linted(c: CompiledGPUCommandGraph<P>) {
		const order = c.stats.nodeOrder;
		const { clears, partial, uses } = this.audit;
		for (const [node, bufs] of partial)
			for (const b of bufs) {
				if (!b.transient) continue;
				const at = order.indexOf(node);
				let cleared = false;
				for (const n of order.slice(0, at)) {
					if (clears.get(n)?.includes(b)) cleared = true;
					else if (!cleared && uses.get(n)?.includes(b)) {
						c.destroy();
						throw new Error(
							`${this.id}: clear lint: ${n} uses transient "${b.id}" before its clear node`,
						);
					}
				}
				if (!cleared) {
					c.destroy();
					throw new Error(
						`${this.id}: clear lint: transient "${b.id}" is written partially / atomically by ${node} without a clear node before it`,
					);
				}
			}
		return c;
	}

	/**
	 * compile() with every node's pipeline created through createComputePipelineAsync (in parallel),
	 * so the thread is not blocked. Idempotent; concurrent callers share one compilation.
	 */
	async compileAsync(): Promise<this> {
		if (this.compiled) return this;
		this.compiling ??= untilLost(this.device, this.graph.compileAsync()).then(
			(c) => this.linted(c),
		);
		const p = this.compiling;
		const c = await p.catch((e) => {
			if (this.compiling === p) this.compiling = null; // a failed compile must be retryable
			throw e;
		});
		if (this.compiling !== p)
			throw new Error(`${this.id}: destroyed while compiling`);
		this.compiled ??= c;
		return this;
	}

	/** Whether compile() / compileAsync() has finished. */
	get isCompiled() {
		return !!this.compiled;
	}

	/**
	 * The compiled graph's stats (undefined before compile): node order and count, logical vs physical
	 * transient buffers and bytes (aliasing), imported bytes. The public way to inspect a graph.
	 */
	get stats() {
		const s = this.compiled?.stats;
		return s && { ...s, nodeCount: s.nodeOrder.length };
	}

	/** Serialise `fn` with this graph's runs (and a cache eviction's destroy): for callers of encodeReads(). */
	lease<T>(fn: () => Promise<T> | T): Promise<T> {
		return withLease(`graph:${this.id}`, fn);
	}

	/**
	 * Record every node into `enc` (no submit). Imported buffers / textures by id override the
	 * defaults.
	 */
	encode(
		enc: CommandEncoder,
		parameters: P,
		buffers?: Record<string, GraphImportedBuffer>,
		textures?: Record<string, GraphImportedTexture>,
	): GPUCommandGraphEncoding {
		if (!this.compiled) throw new Error(`${this.id}: compile() first`);
		if (this.readNodes)
			throw new Error(
				`${this.id}: a graph with read nodes is encoded with encodeReads() or run()`,
			);
		return this.compiled.encode(enc, { parameters, buffers, textures });
	}

	/**
	 * encode() for graphs with read nodes: records every node into `enc` (no submit) and returns the
	 * staged read-node copies. Submit `enc` with core submit() (a throwing submit cancels them), then
	 * call reads.read(). Hold lease() (or the caller's own lease covering every use of this graph)
	 * from encode to submit: transients are shared between encodings.
	 */
	encodeReads(
		enc: CommandEncoder,
		parameters: P,
		buffers?: Record<string, GraphImportedBuffer>,
		textures?: Record<string, GraphImportedTexture>,
	): { encoding: GPUCommandGraphEncoding; reads: GraphReads } {
		if (!this.compiled) throw new Error(`${this.id}: compile() first`);
		const staging: { id: string; staged: StagedRead }[] = [];
		this.staging = staging;
		let encoding: GPUCommandGraphEncoding;
		try {
			encoding = this.compiled.encode(enc, { parameters, buffers, textures });
		} catch (e) {
			for (const s of staging) s.staged.cancel();
			throw e;
		} finally {
			this.staging = null;
		}
		let taken = false;
		return {
			encoding,
			reads: {
				get pending() {
					return taken ? 0 : staging.length;
				},
				read: async () => {
					taken = true;
					const out: Record<string, ArrayBuffer[]> = {};
					// read every slot even if one rejects, so no slot stays busy
					const r = await Promise.allSettled(
						staging.map((s) => s.staged.read()),
					);
					r.forEach((x, i) => {
						if (x.status === "fulfilled") out[staging[i].id] = x.value;
					});
					const bad = r.find((x) => x.status === "rejected");
					if (bad) throw (bad as PromiseRejectedResult).reason;
					return out;
				},
				cancel: () => {
					taken = true;
					for (const s of staging) s.staged.cancel();
				},
			},
		};
	}

	/**
	 * Encode, stage `read` (imported buffers only) on the same encoder, submit once, read back.
	 * `timings` (or globalThis.__RIGI_GPU_PROFILE__) records per-node GPU time when the device has
	 * 'timestamp-query'; profiled runs also add `${id}/${node}` to getGpuProfile().
	 */
	run(
		parameters: P,
		opts: {
			buffers?: Record<string, GraphImportedBuffer>;
			/** imported textures by id (e.g. render targets), overriding the defaults */
			textures?: Record<string, GraphImportedTexture>;
			read?: ReadRange[];
			timings?: boolean;
		} = {},
	): Promise<{
		data: ArrayBuffer[];
		/** read-node results by node id */
		reads: Record<string, ArrayBuffer[]>;
		timings?: GPUCommandGraphTimingReport;
	}> {
		return withLease(`graph:${this.id}`, async () => {
			const compiled = this.compile().compiled as CompiledGPUCommandGraph<P>;
			const prof = profiling(this.device);
			const timed =
				(opts.timings || prof) && this.device.features.has("timestamp-query");
			if (timed && !this.timestamps)
				this.timestamps = this.device.createQuerySet({
					type: "timestamp",
					count: 2 * compiled.stats.nodeOrder.length + 2,
				});
			const enc = this.device.createCommandEncoder({
				id: this.id,
				...(timed ? { timeProfilingQuerySet: this.timestamps } : {}),
			});
			const { encoding, reads: nodeReads } = this.encodeReads(
				enc,
				parameters,
				opts.buffers,
				opts.textures,
			);
			let staged: StagedRead | null = null;
			try {
				staged = stageReads(this.device, enc, opts.read ?? []);
				submit(this.device, enc);
				const [data, reads] = await Promise.all([
					staged.read(),
					nodeReads.read(),
				]);
				if (!timed || !encoding.canReadGPUTimings) return { data, reads };
				const timings = await untilLost(this.device, encoding.readTimings());
				if (prof)
					for (const n of timings.nodes)
						if (n.gpuTimeMilliseconds !== undefined)
							recordGpuTime(`${this.id}/${n.id}`, n.gpuTimeMilliseconds);
				return { data, reads, timings };
			} finally {
				// whatever threw (staging, submit, a checked submit's validation error, a read, the
				// timings), no staged slot stays reserved: cancel is a no-op on reads already taken
				staged?.cancel();
				nodeReads.cancel();
			}
		});
	}

	/** Free the compiled graph's transients, pipelines and timestamp slots. */
	destroy() {
		this.compiled?.destroy();
		this.compiled = null;
		// a compileAsync still in flight: destroy what it produces
		this.compiling?.then(
			(c) => c.destroy(),
			() => {},
		);
		this.compiling = null;
		this.timestamps?.destroy();
		this.timestamps = null;
	}
}

// ---------- shape-keyed compiled-graph cache ----------

/**
 * luma primitives bake their sizes into WGSL constants and graph transients have a fixed byteLength at
 * compile(), so a graph is compiled per shape. cachedGraph keeps the last `max` graphs of a `group` per
 * device (LRU); an evicted graph is destroyed under its lease, i.e. after any run of it in flight.
 */
export type CachedGraph<P, X> = {
	graph: ComputeGraph<P>;
	extra: X;
	/** this lookup found the graph (false: built now) */
	hit?: boolean;
};

const MAX_CACHED = 4;
const caches = new WeakMap<
	Device,
	Map<string, Map<string, CachedGraph<unknown, unknown>>>
>();

/**
 * The graph of (`group`, `key`), built by `build(g)` on a fresh ComputeGraph with id `${group}|${key}`
 * (not compiled: call compile() / compileAsync()). Call it INSIDE the caller's own lease for `group`
 * and queue the graph's lease (run() / lease()) synchronously after it, so an eviction (destroy under
 * the same graph lease) always lands after the caller's use.
 */
export function cachedGraph<P, X = undefined>(
	device: Device,
	group: string,
	key: string,
	build: (g: ComputeGraph<P>) => X,
	max = MAX_CACHED,
): CachedGraph<P, X> {
	let groups = caches.get(device);
	if (!groups) {
		const created = new Map<
			string,
			Map<string, CachedGraph<unknown, unknown>>
		>();
		groups = created;
		caches.set(device, created);
		// the graphs die with the device; drop them so a new device rebuilds
		onLost(device, () => {
			for (const m of created.values())
				for (const e of m.values()) e.graph.destroy();
			created.clear();
			caches.delete(device);
		});
	}
	let m = groups.get(group);
	if (!m) {
		m = new Map();
		groups.set(group, m);
	}
	let e = m.get(key) as CachedGraph<P, X> | undefined;
	if (e) {
		m.delete(key);
		e.hit = true;
	} else {
		const graph = new ComputeGraph<P>(device, `${group}|${key}`);
		e = { graph, extra: build(graph), hit: false };
	}
	m.set(key, e as CachedGraph<unknown, unknown>);
	while (m.size > Math.max(1, max)) {
		const [k0, old] = m.entries().next().value as [
			string,
			CachedGraph<unknown, unknown>,
		];
		m.delete(k0);
		void old.graph.lease(() => old.graph.destroy());
	}
	return e;
}

/** Cached graphs of `device` (all groups, or one): for tests and stats. */
export function cachedGraphCount(device: Device, group?: string): number {
	const groups = caches.get(device);
	if (!groups) return 0;
	if (group) return groups.get(group)?.size ?? 0;
	let n = 0;
	for (const m of groups.values()) n += m.size;
	return n;
}

/** Destroy every cached graph of `device` in `group` (all groups when omitted), each after its runs. */
export async function releaseCachedGraphs(
	device: Device,
	group?: string,
): Promise<void> {
	const groups = caches.get(device);
	if (!groups) return;
	const olds: CachedGraph<unknown, unknown>[] = [];
	for (const [g, m] of groups)
		if (!group || g === group) {
			olds.push(...m.values());
			m.clear();
		}
	await Promise.all(olds.map((e) => e.graph.lease(() => e.graph.destroy())));
}
