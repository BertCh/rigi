// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

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
// W0.1 widening (all additive; graphs that do not use these encode exactly as before):
//   g.addKernel({ ..., condition: { id: "tail", source: "gpu", mode: "indirect", buffer: cmd } });
//                                                          // GPU-sized / GPU-skipped dispatch (see the GPU-condition lint)
//   g.addKernel({ ..., bindings: { tex: g.transientTexture({...}) } }); // "texture" layout entries
//   g.addKernel({ ..., workload: { maximumInvocationCount: n } }); g.preflight?.fitsDeviceLimits
//   new ComputeGraph(device, id, { graph });               // adopt an external / compiler-made GPUCommandGraph
//   g.addComputePass({ ..., cleared: [acc] }); g.addCopyPass(...); g.addRenderPass(...); // audited raw nodes
//   g.importFrameTexture(...) + run(p, { frameTextures }); listCachedGraphs(device)
//
// W0.2 inspection (opt-in, recording only): g.inspect() / core/inspect.ts inspectGraphs() observe the
// compiled graph on its device's upstream GPUCommandGraphInspector (core/inspector.ts); profiled
// encodes observe it too. An observed graph encodes through the observation handle (the same
// compiled.encode, then the CPU encode times are recorded), and timed runs hand their one timing read
// to it. Unobserved graphs (the default) encode exactly as before.
//
// Transients are NEVER zeroed by the graph, and a transient can alias another one whose lifetime ended
// earlier in the same encoding (or a previous encoding's bytes): anything read-modify-written
// (atomics, partial writes, accumulators) needs a clearNode first.
import {
	type Bindings,
	Buffer,
	type CommandEncoder,
	type Device,
	type QuerySet,
} from "@luma.gl/core";
import { type ClearAudit, clearLintError } from "./clear-lint";
import { observeCompiledGraph } from "./inspector";
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
	type GPUCommandGraphCopyNode,
	type GPUCommandGraphCPUCondition,
	type GPUCommandGraphEncodeOptions,
	type GPUCommandGraphEncoding,
	type GPUCommandGraphGPUIndirectCondition,
	type GPUCommandGraphInspectorObservation,
	type GPUCommandGraphNode,
	type GPUCommandGraphNodeCondition,
	type GPUCommandGraphNodeWorkloadEstimate,
	type GPUCommandGraphPreflightReport,
	type GPUCommandGraphRenderNode,
	type GPUCommandGraphTimingReport,
	type GPUNode,
	type GPUScalarFormat,
	GraphBufferHandle,
	type GraphBufferUsage,
	GraphDataView,
	type GraphImportedBuffer,
	type GraphImportedTexture,
	type GraphResourceUse,
	type GraphTextureDescriptor,
	GraphTextureHandle,
	GraphTextureView,
	type GraphTextureViewProps,
} from "./luma";
import { clear, withLease } from "./pool";
import { profileRequested, profiling, recordGpuTime } from "./profile";
import { submit } from "./queue";
import { type ReadRange, type StagedRead, stageReads } from "./readback";

/** A graph buffer or a typed range of one (range offsets must be multiples of 256). */
export type GraphBinding = GraphBufferHandle | GraphDataView;

/** A graph texture or a view of one (bound to a kernel's "texture" layout entry, sampled). */
export type GraphTexture = GraphTextureHandle | GraphTextureView;

export type Workgroups = [number, number?, number?];

/**
 * A compute node running a core kernel. A binding is a handle (bound with its declared byteLength),
 * a data view (its exact range) or a GraphRange with a per-run size (e.g. capacity-keyed graphs that
 * bind exactly the bytes a call uses).
 */
export type KernelNode<P> = {
	id: string;
	spec: KernelSpec;
	/**
	 * one graph buffer / view per layout name of `spec`; a "texture" layout entry takes a graph texture
	 * or texture view (declared "sampled", bound as its TextureView)
	 */
	bindings: Record<string, GraphBinding | GraphRange<P> | GraphTexture>;
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
	 * CPU condition `{ source: "cpu", evaluate }`: record this dispatch only when `evaluate(parameters)`
	 * is true (checked per encoding). A skipped node keeps its place in the schedule, so transient
	 * lifetimes, aliasing and the clear lint are those of the graph with the node; its outputs are then
	 * whatever the earlier nodes left (e.g. a clear node's zeros).
	 *
	 * GPU condition `{ source: "gpu", mode: "indirect", buffer, byteOffset? }`: the dispatch becomes
	 * dispatchIndirect(buffer, byteOffset) (3 × u32 written on the GPU; x = 0 skips it). `workgroups`
	 * is still evaluated and limit-checked, but the GPU command decides the count. The graph adds the
	 * buffer's "indirect" use. GPU-condition lint (compile() throws): a transient this node writes and
	 * a later node uses must be cleared WHOLE (clearNode of the whole buffer) before this node, since a
	 * skipped or shortened dispatch leaves aliased garbage in it, unless every later user (up to the
	 * next whole clear of it) is gated by the same indirect command (same buffer and byteOffset) and
	 * comes before any rewrite of that command buffer. Nodes the lint cannot see (raw g.graph.* or
	 * adopted-graph nodes not declared with declareNode) count as ungated users.
	 * "Same gate" assumes such a reader reads only what the gated writer wrote for that same x (e.g.
	 * element i < x × workgroup size): a same-gated reader that reads past it reads garbage, and the
	 * lint cannot see that.
	 */
	condition?: KernelCondition<P>;
	/** Upstream preflight annotation (GPUCommandGraph workload; see ComputeGraph.preflight). */
	workload?: GPUCommandGraphNodeWorkloadEstimate;
};

/** A KernelNode's condition: a CPU condition, or a GPU indirect condition (compute nodes only). */
export type KernelCondition<P> = GPUCommandGraphNodeCondition<P>;
export type KernelCPUCondition<P> = GPUCommandGraphCPUCondition<P>;
export type KernelGPUCondition = GPUCommandGraphGPUIndirectCondition;

/**
 * Clear-lint declarations for raw nodes (addComputePass / addCopyPass / addRenderPass): the buffers
 * the node writes partially or atomically (read-modify-write), as KernelNode.cleared. Every declared
 * buffer use counts for the lint ("storage-write", "storage-read-write" and "copy-destination" as
 * writes for the GPU-condition rule).
 */
export type RawNodeAudit = {
	cleared?: (GraphBufferHandle | GraphDataView)[];
};

/** Extra encode options passed through to CompiledGPUCommandGraph.encode. */
export type GraphEncodeExtras<P> = Pick<
	GPUCommandGraphEncodeOptions<P>,
	"frameTextures" | "externalTextures" | "coalesceComputePasses"
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

const isTexture = (v: unknown): v is GraphTexture =>
	v instanceof GraphTextureHandle || v instanceof GraphTextureView;

const WRITE_USES = new Set<GraphBufferUsage>([
	"storage-write",
	"storage-read-write",
	"copy-destination",
]);

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
	/**
	 * clear audit: node id → handles it clears / writes partially or atomically / uses at all / writes
	 * at all, and the indirect command of GPU-conditioned nodes
	 */
	private audit: ClearAudit<GraphBufferHandle> = {
		clears: new Map(),
		wholeClears: new Map(),
		partial: new Map(),
		uses: new Map(),
		writes: new Map(),
		gates: new Map(),
	};
	private readNodes = 0;
	/** the upstream inspector's handle on the compiled graph (null: not observed, the default) */
	private observation: GPUCommandGraphInspectorObservation<P> | null = null;
	/** read-node staging of the encoding in progress (set by encodeReads) */
	private staging: { id: string; staged: StagedRead }[] | null = null;

	/**
	 * `opts.graph` adopts an existing GPUCommandGraph (built elsewhere, e.g. by a program compiler) of
	 * the same device instead of creating one: this wrapper's nodes are added to it, and compile()
	 * compiles (and freezes) it. Nodes added to it directly are outside the clear lint.
	 */
	constructor(
		device: Device,
		id: string,
		opts: { graph?: GPUCommandGraph<P> } = {},
	) {
		this.device = device;
		this.id = id;
		if (opts.graph && opts.graph.device !== device)
			throw new Error(`${id}: the adopted graph is on another device`);
		this.graph = opts.graph ?? new GPUCommandGraph<P>(device, { id });
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

	/**
	 * A caller-owned texture supplied on EVERY encode with a strictly increasing frameId
	 * (run({ frameTextures }) / the encode extras); passthrough to GPUCommandGraph.importFrameTexture.
	 */
	importFrameTexture(descriptor: GraphTextureDescriptor): GraphTextureHandle {
		return this.graph.importFrameTexture(descriptor);
	}

	/**
	 * Graph-owned texture scratch (passthrough to createTransientTexture): never cleared, and reused
	 * by compatible transient textures with disjoint lifetimes (the clear lint covers buffers only).
	 */
	transientTexture(descriptor: GraphTextureDescriptor): GraphTextureHandle {
		return this.graph.createTransientTexture(descriptor);
	}

	/** A view of a graph texture (mip / layer / aspect range; passthrough to createTextureView). */
	textureView(
		texture: GraphTextureHandle,
		props?: GraphTextureViewProps,
	): GraphTextureView {
		return this.graph.createTextureView(texture, props);
	}

	/** Record a node's buffer uses, writes, partial writes and GPU gate for the clear lint. */
	private recordAudit(
		id: string,
		resources: readonly GraphResourceUse[],
		partial: GraphBufferHandle[],
		condition?: { source: "cpu" | "gpu" },
	) {
		const uses: GraphBufferHandle[] = [];
		const writes: GraphBufferHandle[] = [];
		for (const r of resources)
			if ("buffer" in r) {
				const h = handleOf(r.buffer);
				uses.push(h);
				if (WRITE_USES.has(r.usage)) writes.push(h);
			}
		if (condition?.source === "gpu") {
			const c = condition as GPUCommandGraphGPUIndirectCondition;
			uses.push(c.buffer);
			this.audit.gates.set(id, {
				buffer: c.buffer,
				byteOffset: c.byteOffset ?? 0,
			});
		}
		for (const h of partial) if (!uses.includes(h)) uses.push(h);
		this.audit.uses.set(id, uses);
		this.audit.writes.set(id, writes);
		this.audit.partial.set(id, partial);
	}

	/** Add a compute node that dispatches a core kernel. */
	addKernel(node: KernelNode<P>): this {
		const { spec } = node;
		for (const [name, kind] of spec.layout) {
			const v = node.bindings[name];
			if (!v)
				throw new Error(`${this.id}/${node.id}: no binding for "${name}"`);
			if ((kind === "texture") !== isTexture(v))
				throw new Error(
					`${this.id}/${node.id}: "${name}" is a ${kind} binding, bound to a ${isTexture(v) ? "texture" : "buffer"}`,
				);
		}
		const buffer = (name: string) =>
			node.bindings[name] as GraphBinding | GraphRange<P>;
		const modes: Record<string, WriteMode> = { ...node.writes };
		for (const name of node.cleared ?? []) modes[name] ??= "partial";
		const partial: GraphBufferHandle[] = [];
		for (const [name, mode] of Object.entries(modes)) {
			const kind = spec.layout.find(([n]) => n === name)?.[1];
			if (kind !== "storage")
				throw new Error(
					`${this.id}/${node.id}: "${name}" is not a storage output`,
				);
			if (mode !== "full") partial.push(handleOf(buffer(name)));
		}
		const resources: GraphResourceUse[] = spec.layout.map(([name, kind]) => {
			const v = node.bindings[name];
			if (isTexture(v)) return { texture: v, usage: "sampled" };
			const b = buffer(name);
			return {
				buffer: b instanceof GraphDataView ? b : handleOf(b),
				usage: USE[kind as keyof typeof USE],
			};
		});
		this.recordAudit(node.id, resources, partial, node.condition);
		const executable = (k: Kernel): GPUCommandGraphComputeExecutable<P> => ({
			encode: ({ computePass, getBuffer, getTextureView, parameters }) => {
				const b: Bindings = {};
				for (const [name] of spec.layout) {
					// handles: their declared byteLength; views: their exact range; explicit ranges: the
					// run's { offset, size } (a binding narrower than a capacity-keyed buffer); textures:
					// their (or the view's) TextureView
					const v = node.bindings[name];
					if (isTexture(v)) {
						b[name] = getTextureView(v);
						continue;
					}
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
		const computeNode: Omit<GPUCommandGraphComputeNode<P>, "type"> = {
			id: node.id,
			dependsOn: node.dependsOn,
			condition: node.condition,
			resources,
			compile: ({ device }) => executable(kernel(device, spec)),
			// same WGSL, module and descriptor as kernel(): identical results (core selftest)
			compileAsync: async ({ device }) =>
				executable(await kernelAsync(device, spec)),
		};
		if (node.workload) computeNode.workload = node.workload;
		// fixed workgroups: the direct-dispatch geometry upstream program compilers read
		// (setGPUComputeDispatchWorkgroups's field) to put the node under a GPU predicate
		// (upstream's setter is not exported from @luma.gl/gpgpu/gpu-core; this applies its validation,
		// non-negative safe integers, but skips the annotation instead of throwing, so an existing node
		// with other values still compiles exactly as before)
		if (Array.isArray(node.workgroups)) {
			const [x, y = 1, z = 1] = node.workgroups;
			if ([x, y, z].every((v) => Number.isSafeInteger(v) && v >= 0))
				Object.assign(computeNode, {
					dispatchWorkgroups: Object.freeze([x, y, z]),
				});
		}
		this.graph.addComputePass(computeNode);
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
		// whole-buffer clear (what the GPU-condition rule needs): a handle, or a fixed range / view from
		// offset 0 covering its byteLength; parameter-sized ranges never count as whole
		const fixed =
			target instanceof GraphDataView
				? rangeOf(target, undefined as P)
				: target instanceof GraphBufferHandle
					? { offset: 0, size: h.byteLength }
					: typeof target.size === "number"
						? { offset: target.offset ?? 0, size: target.size }
						: null;
		const whole = !!fixed && fixed.offset === 0 && fixed.size >= h.byteLength;
		if (whole) this.audit.wholeClears.set(id, [h]);
		this.audit.uses.set(id, [h]);
		this.audit.writes.set(id, [h]);
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

	/**
	 * Add a raw gpu-core compute node (custom encode). Its declared buffer resources join the clear
	 * lint (`cleared`: buffers it writes partially / atomically), and a GPU condition gets the
	 * GPU-condition lint of KernelNode.condition.
	 */
	addComputePass(
		node: Omit<GPUCommandGraphComputeNode<P>, "type"> & RawNodeAudit,
	): this {
		const { cleared, ...rest } = node;
		this.recordAudit(
			rest.id,
			rest.resources ?? [],
			(cleared ?? []).map(handleOf),
			rest.condition,
		);
		this.graph.addComputePass(rest);
		return this;
	}

	/** Add a raw copy node (CPU conditions only); audited like addComputePass. */
	addCopyPass(
		node: Omit<GPUCommandGraphCopyNode<P>, "type"> & RawNodeAudit,
	): this {
		const { cleared, ...rest } = node;
		this.recordAudit(
			rest.id,
			rest.resources ?? [],
			(cleared ?? []).map(handleOf),
		);
		this.graph.addCopyPass(rest);
		return this;
	}

	/**
	 * Add a raw render node (CPU conditions only; graph attachments or a caller framebuffer); its
	 * buffer resources are audited like addComputePass (textures are outside the clear lint).
	 */
	addRenderPass(
		node: Omit<GPUCommandGraphRenderNode<P>, "type"> & RawNodeAudit,
	): this {
		const { cleared, ...rest } = node;
		this.recordAudit(
			rest.id,
			rest.resources ?? [],
			(cleared ?? []).map(handleOf),
		);
		this.graph.addRenderPass(rest);
		return this;
	}

	/** Add a gpu-core op (GPUReduction, GPUSort, …) built on this graph's handles. */
	add(op: GraphOp<P>, opts: { uses?: GraphBufferHandle[] } = {}): this {
		// flattened the way GPUCommandGraph.add does (getNodes children, getCommandNodes(graph), raw
		// nodes, arrays; same nodes, same order), so each command node's declared resources and
		// condition join the clear lint; `uses` adds buffers an op reads without declaring them
		const flat = (n: GraphOp<P>) => {
			if ("getNodes" in n) for (const child of n.getNodes()) flat(child);
			else if ("getCommandNodes" in n)
				for (const c of n.getCommandNodes(this.graph)) one(c);
			else if ("type" in n) one(n);
			else for (const child of n) flat(child);
		};
		const one = (c: GPUCommandGraphNode<P>) => {
			this.recordAudit(
				c.id,
				[
					...(c.resources ?? []),
					...(opts.uses ?? []).map((buffer) => ({
						buffer,
						usage: "storage-read" as const,
					})),
				],
				[],
				c.condition,
			);
			this.graph.add(c);
		};
		flat(op);
		return this;
	}

	/**
	 * Declare the buffer uses of a node added to `graph` directly (raw g.graph.* calls, or a node of
	 * an adopted graph), so the clear lint can see it. Undeclared nodes count as possible ungated
	 * users of every GPU-gated transient, and an undeclared GPU-conditioned node is refused.
	 */
	declareNode(
		id: string,
		audit: {
			uses?: GraphBufferHandle[];
			writes?: GraphBufferHandle[];
			cleared?: GraphBufferHandle[];
			condition?: KernelCondition<P>;
		},
	): this {
		this.recordAudit(
			id,
			[
				...(audit.uses ?? []).map((buffer) => ({
					buffer,
					usage: "storage-read" as const,
				})),
				...(audit.writes ?? []).map((buffer) => ({
					buffer,
					usage: "storage-write" as const,
				})),
			],
			audit.cleared ?? [],
			audit.condition,
		);
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
	 * clearNode before that write and before any other use of it in the encoding. A transient written
	 * by a GPU-conditioned node counts as written partially when a later node (up to the next clear
	 * of it) uses it without being gated by the same indirect command. Destroys and throws.
	 */
	private linted(c: CompiledGPUCommandGraph<P>) {
		const error = clearLintError(
			c.stats.nodeOrder,
			this.audit,
			c.preflight.nodes
				.filter((n) => n.condition?.source === "gpu")
				.map((n) => n.id),
		);
		if (error) {
			c.destroy();
			throw new Error(`${this.id}: clear lint: ${error}`);
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
	 * Upstream preflight of the compiled graph (undefined before compile): per-node workload and
	 * condition metadata (KernelNode.workload), totals, the largest buffer and binding, and
	 * `fitsDeviceLimits`.
	 */
	get preflight(): GPUCommandGraphPreflightReport | undefined {
		return this.compiled?.preflight;
	}

	/** Graph-relevant device capabilities and limits of the compiled graph (undefined before compile). */
	get capabilities() {
		return this.compiled?.capabilities;
	}

	/**
	 * Observe the compiled graph on its device's GPUCommandGraphInspector (core/inspector.ts) from now
	 * on: later encodes record their CPU encode times, and timed / profiled runs their GPU node times.
	 * Recording only: the commands are unchanged. undefined before compile.
	 */
	inspect(): GPUCommandGraphInspectorObservation<P> | undefined {
		if (!this.compiled) return undefined;
		this.observation ??= observeCompiledGraph(this.compiled);
		return this.observation;
	}

	/** What to encode through: the observation when observed (or profiling asks for one), else the graph. */
	private encoder(compiled: CompiledGPUCommandGraph<P>) {
		if (!this.observation && profileRequested()) this.inspect();
		return this.observation ?? compiled;
	}

	/** Whether the compiled graph's buffers fit the device limits (undefined before compile). */
	fitsDeviceLimits(): boolean | undefined {
		return this.compiled?.preflight.fitsDeviceLimits;
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
		extras?: GraphEncodeExtras<P>,
	): GPUCommandGraphEncoding {
		if (!this.compiled) throw new Error(`${this.id}: compile() first`);
		if (this.readNodes)
			throw new Error(
				`${this.id}: a graph with read nodes is encoded with encodeReads() or run()`,
			);
		return this.encoder(this.compiled).encode(enc, {
			...extras,
			parameters,
			buffers,
			textures,
		});
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
		extras?: GraphEncodeExtras<P>,
	): { encoding: GPUCommandGraphEncoding; reads: GraphReads } {
		if (!this.compiled) throw new Error(`${this.id}: compile() first`);
		const staging: { id: string; staged: StagedRead }[] = [];
		this.staging = staging;
		let encoding: GPUCommandGraphEncoding;
		try {
			encoding = this.encoder(this.compiled).encode(enc, {
				...extras,
				parameters,
				buffers,
				textures,
			});
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
			/** importFrameTexture handles by id ({ texture, frameId }, frameId strictly increasing) */
			frameTextures?: GraphEncodeExtras<P>["frameTextures"];
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
				opts.frameTextures ? { frameTextures: opts.frameTextures } : undefined,
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
				// an observed graph's inspector takes the one timing read (and returns the same report);
				// undefined (a replaced registration, or a failed read it swallowed) → read it here
				const obs = this.observation;
				const timings = await untilLost(
					this.device,
					obs
						? obs
								.recordGPUTimings(encoding)
								.then((r) => r ?? encoding.readTimings())
						: encoding.readTimings(),
				);
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
		this.observation?.detach();
		this.observation = null;
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
/** devices with a cache, for listCachedGraphs() without a device (weak: never keeps one alive) */
const cacheDevices = new Set<WeakRef<Device>>();

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
		const ref = new WeakRef(device);
		cacheDevices.add(ref);
		// the graphs die with the device; drop them so a new device rebuilds
		onLost(device, () => {
			for (const m of created.values())
				for (const e of m.values()) e.graph.destroy();
			created.clear();
			caches.delete(device);
			cacheDevices.delete(ref);
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

/** One cachedGraph entry, as listCachedGraphs reports it. */
export type CachedGraphInfo = {
	device: Device;
	group: string;
	key: string;
	/** the ComputeGraph id (`${group}|${key}`) */
	id: string;
	graph: ComputeGraph<unknown>;
	compiled: boolean;
	/** ComputeGraph.stats (undefined until compiled) */
	stats: ComputeGraph<unknown>["stats"];
};

/**
 * The cached graphs of `device` (every device with a cache when omitted), optionally of one `group`,
 * least recently used first within a group. Read-only: does not touch the LRU order (for the graph
 * inspector and the app graph manifest).
 */
export function listCachedGraphs(
	device?: Device,
	group?: string,
): CachedGraphInfo[] {
	const devices: Device[] = [];
	if (device) devices.push(device);
	else
		for (const ref of cacheDevices) {
			const d = ref.deref();
			if (d) devices.push(d);
			else cacheDevices.delete(ref);
		}
	const out: CachedGraphInfo[] = [];
	for (const d of devices)
		for (const [g, m] of caches.get(d) ?? [])
			if (!group || g === group)
				for (const [key, e] of m)
					out.push({
						device: d,
						group: g,
						key,
						id: e.graph.id,
						graph: e.graph,
						compiled: e.graph.isCompiled,
						stats: e.graph.stats,
					});
	return out;
}
