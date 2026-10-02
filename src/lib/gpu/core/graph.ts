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
//   const r = g.runNow(p, { buffers });                  // no lease, sync up to submit: transient-free graphs
//                                                          // whose imports the caller writes right before
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
import { abortable } from "./abort";
import { type ClearAudit, clearLintError } from "./clear-lint";
import { observeCompiledGraph } from "./inspector";
import {
	type BindKind,
	encodeDispatchMemo,
	isTextureKind,
	type Kernel,
	type KernelSpec,
	kernel,
	kernelAsync,
	newBindGroupMemo,
} from "./kernel";
import { onLost, untilLost } from "./lifecycle";
import {
	type CompiledGPUCommandGraph,
	createGPUComputeCommandNode,
	createTransientView,
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
	type GPUCommandNodeProducer,
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
import { registerPurger, watchOutOfMemory } from "./oom";
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
 * GPUSort, GPUHistogram, GPUScan, … via getCommandNodes(graph); luma 10, visgl/luma.gl#3258), a raw command node, or a group of them.
 */
export type GraphOp<P> = GPUNode<P>;

/** Options of ComputeGraph.run() / runNow(). */
export type GraphRunOptions<P> = {
	buffers?: Record<string, GraphImportedBuffer>;
	/** imported textures by id (e.g. render targets), overriding the defaults */
	textures?: Record<string, GraphImportedTexture>;
	/** importFrameTexture handles by id ({ texture, frameId }, frameId strictly increasing) */
	frameTextures?: GraphEncodeExtras<P>["frameTextures"];
	read?: ReadRange[];
	timings?: boolean;
	/**
	 * Cancel: run() skips the work if it aborts before the lease is granted, skips the submit if it
	 * aborts before it, and rejects with the reason at once if it aborts during the read (the staged
	 * slots still return to the ring when their maps settle). Use isAbortError to tell it from a failure.
	 */
	signal?: AbortSignal;
};

/** What ComputeGraph.run() / runNow() resolve. */
export type GraphRunResult = {
	data: ArrayBuffer[];
	/** read-node results by node id */
	reads: Record<string, ArrayBuffer[]>;
	timings?: GPUCommandGraphTimingReport;
};

const USE: Record<
	Exclude<BindKind, "texture" | "texture-array">,
	GraphBufferUsage
> = {
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

/**
 * The byte range of a GraphDataView inside `buffer` (the Buffer that backs its import handle), as a
 * ReadRange for run({ read }) / stageReads, or a `{ buffer, offset, size }` binding for encodeDispatch:
 * the Rigi side of the GraphDataView interop. Size is padded to 4 bytes like the graph's own ranges.
 */
export function viewRange(view: GraphDataView, buffer: Buffer) {
	return { buffer, ...rangeOf(view, undefined) };
}

/**
 * The compute node of a KernelNode (validation, resources, the encode closure, the direct-dispatch
 * geometry), plus the handles it writes partially / atomically (for the clear lint). Shared by
 * ComputeGraph.addKernel and KernelOp.getCommandNodes, so a Rigi kernel is the same node either way.
 */
function buildKernelNode<P>(label: string, node: KernelNode<P>) {
	const { spec } = node;
	for (const [name, kind] of spec.layout) {
		const v = node.bindings[name];
		if (!v) throw new Error(`${label}: no binding for "${name}"`);
		if (isTextureKind(kind) !== isTexture(v))
			throw new Error(
				`${label}: "${name}" is a ${kind} binding, bound to a ${isTexture(v) ? "texture" : "buffer"}`,
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
			throw new Error(`${label}: "${name}" is not a storage output`);
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
	const executable = (k: Kernel): GPUCommandGraphComputeExecutable<P> => {
		const memo = newBindGroupMemo();
		return {
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
				encodeDispatchMemo(computePass, k, b, w[0], w[1] ?? 1, w[2] ?? 1, memo);
			},
		};
	};
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
	// (upstream's setter is not exported from @luma.gl/gpgpu/gpu-core, re-checked on rigi.3; this applies its validation,
	// non-negative safe integers, but skips the annotation instead of throwing, so an existing node
	// with other values still compiles exactly as before)
	if (Array.isArray(node.workgroups)) {
		const [x, y = 1, z = 1] = node.workgroups;
		if ([x, y, z].every((v) => Number.isSafeInteger(v) && v >= 0))
			Object.assign(computeNode, {
				dispatchWorkgroups: Object.freeze([x, y, z]),
			});
	}
	return { computeNode, partial };
}

/**
 * A Rigi kernel as a luma contributor: `getCommandNodes(graph)` yields its compute node, so a
 * defineKernel kernel can sit inside any luma op tree or plain GPUCommandGraph (`graph.add(op)`),
 * next to gpgpu / gpu-raster ops, with views from the same graph. ComputeGraph.add(op) routes it
 * through addKernel (clear audit included).
 */
export class KernelOp<P = void> implements GPUCommandNodeProducer<P> {
	constructor(readonly node: KernelNode<P>) {}
	getCommandNodes(
		graph: GPUCommandGraph<P>,
	): readonly GPUCommandGraphNode<P>[] {
		void graph;
		return [
			createGPUComputeCommandNode(
				buildKernelNode(`kernel-op/${this.node.id}`, this.node).computeNode,
			),
		];
	}
}

/** A gpu-raster style op: it adds its nodes itself, given the graph that owns its views. */
export type AddToGraphOp<P> = { addToGraph(graph: GPUCommandGraph<P>): void };

const isAddToGraphOp = <P>(op: unknown): op is AddToGraphOp<P> =>
	typeof (op as AddToGraphOp<P>)?.addToGraph === "function";

export class ComputeGraph<P = void> {
	readonly device: Device;
	readonly id: string;
	/** the underlying gpu-core graph, for ops this wrapper does not cover */
	readonly graph: GPUCommandGraph<P>;
	/** the graph's own mutators, which ignore the addToGraph interception of add() */
	private readonly rawGraph: {
		add(node: GPUNode<P>): void;
		addComputePass(node: Omit<GPUCommandGraphComputeNode<P>, "type">): void;
		addCopyPass(node: Omit<GPUCommandGraphCopyNode<P>, "type">): void;
		addRenderPass(node: Omit<GPUCommandGraphRenderNode<P>, "type">): void;
	};
	/** the graph's mutators captured before an addToGraph op's shadowing (null outside one) */
	private bypass: GPUCommandGraph<P> | null = null;
	private compiled: CompiledGPUCommandGraph<P> | null = null;
	private compiling: Promise<CompiledGPUCommandGraph<P>> | null = null;
	private timestamps: QuerySet | null = null;
	/** a timed run is in flight (its encoding owns the timestamp query set until its timings are read) */
	private timing = false;
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
		// the graph's mutators as they are NOW (a program compiler's lowering scope may have patched
		// them), or, while an addToGraph op runs, the ones captured before they were shadowed
		this.rawGraph = {
			add: (n) => (this.bypass ?? this.graph).add(n),
			addComputePass: (n) => (this.bypass ?? this.graph).addComputePass(n),
			addCopyPass: (n) => (this.bypass ?? this.graph).addCopyPass(n),
			addRenderPass: (n) => (this.bypass ?? this.graph).addRenderPass(n),
		};
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
		const { computeNode, partial } = buildKernelNode(
			`${this.id}/${node.id}`,
			node,
		);
		this.recordAudit(
			node.id,
			computeNode.resources ?? [],
			partial,
			node.condition,
		);
		this.rawGraph.addComputePass(computeNode);
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
		this.rawGraph.addCopyPass({
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
		this.rawGraph.addCopyPass({
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
		this.rawGraph.addComputePass(rest);
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
		this.rawGraph.addCopyPass(rest);
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
		this.rawGraph.addRenderPass(rest);
		return this;
	}

	/**
	 * Add a luma op built on this graph's handles, or a Rigi kernel contributor:
	 * - a producer (`getCommandNodes(graph)`: GPUReduction, GPUSort, GPUHistogram, GPUElementwise, …),
	 *   a group (`getNodes()`), a raw command node, or an array of those;
	 * - a KernelOp (a defineKernel kernel as a contributor), added through addKernel;
	 * - a gpu-raster style op (`addToGraph(graph)`: GPURasterEdges, GPURasterThreshold, …): its
	 *   addToGraph runs against this graph with the graph's add* mutators routed through this wrapper,
	 *   so its nodes join the clear lint like any other.
	 * Each command node's declared resources and condition join the clear lint; `uses` adds buffers an
	 * op reads without declaring them. The op's views must come from THIS graph (graph.view,
	 * importView, transientView).
	 */
	add(
		op: GraphOp<P> | KernelOp<P> | AddToGraphOp<P>,
		opts: { uses?: GraphBufferHandle[] } = {},
	): this {
		// flattened the way GPUCommandGraph.add does (getNodes children, getCommandNodes(graph), raw
		// nodes, arrays; same nodes, same order), so each command node's declared resources and
		// condition join the clear lint
		const flat = (n: GraphOp<P> | KernelOp<P> | AddToGraphOp<P>) => {
			if (n instanceof KernelOp) this.addKernel(n.node);
			else if (isAddToGraphOp<P>(n)) this.addViaAddToGraph(n);
			else if ("getNodes" in n) for (const child of n.getNodes()) flat(child);
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
			this.rawGraph.add(c);
		};
		flat(op);
		return this;
	}

	/** Run an `addToGraph(graph)` op with this graph's mutators shadowed by the audited wrappers. */
	private addViaAddToGraph(op: AddToGraphOp<P>) {
		const g = this.graph as unknown as Record<string, unknown>;
		const audited = {
			add: (n: GraphOp<P> | KernelOp<P> | AddToGraphOp<P>) => this.add(n),
			addComputePass: (n: Omit<GPUCommandGraphComputeNode<P>, "type">) =>
				this.addComputePass(n),
			addCopyPass: (n: Omit<GPUCommandGraphCopyNode<P>, "type">) =>
				this.addCopyPass(n),
			addRenderPass: (n: Omit<GPUCommandGraphRenderNode<P>, "type">) =>
				this.addRenderPass(n),
		};
		// own properties shadow the prototype methods; removed again below. The graph identity stays
		// the real one: ops compare `view.buffer.graph !== graph`
		const current = this.graph;
		const had = Object.keys(audited).filter((k) => Object.hasOwn(g, k));
		const saved = Object.fromEntries(had.map((k) => [k, g[k]]));
		this.bypass = {
			add: current.add.bind(current),
			addComputePass: current.addComputePass.bind(current),
			addCopyPass: current.addCopyPass.bind(current),
			addRenderPass: current.addRenderPass.bind(current),
		} as unknown as GPUCommandGraph<P>;
		Object.assign(g, audited);
		try {
			op.addToGraph(this.graph);
		} finally {
			for (const k of Object.keys(audited)) delete g[k];
			Object.assign(g, saved);
			this.bypass = null;
		}
	}

	/**
	 * Import a Rigi buffer (core/pool.ts lease, storage(), any luma Buffer) as a typed GraphDataView,
	 * without a copy. The view's `.buffer` is the import handle: pass the same id in run({ buffers })
	 * to bind another Buffer later (a grown pooled slot). `byteOffset` must be a multiple of 4.
	 */
	importView<T extends GPUScalarFormat>(
		id: string,
		buffer: Buffer,
		format: T,
		length: number,
		byteOffset = 0,
	): GraphDataView<T> {
		const handle = this.importBuffer(
			id,
			buffer.byteLength,
			buffer,
			buffer.usage,
		);
		return this.view(handle, format, length, byteOffset);
	}

	/** Graph-owned scratch as a packed typed view (luma's createTransientView over this graph). */
	transientView<T extends GPUScalarFormat>(
		id: string,
		format: T,
		length: number,
		usage = STORAGE,
	): GraphDataView<T> {
		return createTransientView(this.graph, id, format, length, usage);
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
		// nodes added through this wrapper that an adopting program compiler gated afterwards
		// (GPUProgramCompiler: a GPUConditionalOperation around a fixed-workgroup kernel adds its own
		// indirect gate): the gate joins the audit from the preflight, one stand-in handle per gate
		// buffer (identity is all the lint compares; the gate buffer is the compiler's transient)
		const standIns = new Map<string, GraphBufferHandle>();
		for (const n of c.preflight.nodes) {
			const g = n.condition;
			if (g?.source !== "gpu" || !g.bufferId) continue;
			if (this.audit.gates.has(n.id) || !this.audit.uses.has(n.id)) continue;
			let h = standIns.get(g.bufferId);
			if (!h) {
				h = { id: g.bufferId, transient: true } as unknown as GraphBufferHandle;
				standIns.set(g.bufferId, h);
			}
			this.audit.gates.set(n.id, { buffer: h, byteOffset: g.byteOffset ?? 0 });
			this.audit.uses.get(n.id)?.push(h);
		}
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

	/** Whether a compileAsync() is in flight (compile() throws until it settles). */
	get isCompiling() {
		return this.compiling !== null;
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
	run(parameters: P, opts: GraphRunOptions<P> = {}): Promise<GraphRunResult> {
		return withLease(`graph:${this.id}`, () => this.execute(parameters, opts), {
			signal: opts.signal,
		});
	}

	/**
	 * run() without the graph lease, for graphs WITHOUT transients (every buffer and texture is an
	 * import, so two encodings share no graph-owned state): compile (sync, when compileAsync() has
	 * not finished), encode, stage and submit happen synchronously in this call, so a caller may write
	 * its imports with queue.writeBuffer right before it and a concurrent call's writes land after
	 * this submit in queue order. Runs are not serialised: the returned promise only reads back.
	 * Per-node timings are taken only when no other timed run of this graph is in flight (the
	 * timestamp query set is shared); a cache eviction (destroy) during a timed run rejects it.
	 * Throws (synchronously) on a graph with transients.
	 */
	runNow(
		parameters: P,
		opts: GraphRunOptions<P> = {},
	): Promise<GraphRunResult> {
		const s = this.compile().compiled?.stats;
		if (s && (s.logicalTransientBufferCount || s.logicalTransientTextureCount))
			throw new Error(`${this.id}: runNow() needs a graph without transients`);
		return this.execute(parameters, opts);
	}

	/**
	 * A frame loop's run: like runNow() but also for graphs WITH transients. Compile, encode, stage and
	 * submit happen synchronously in this call (a caller may queue.writeBuffer its imports right before
	 * it), and nothing is serialised through the lease, so back-to-back calls are encoded and submitted
	 * back to back while earlier reads still map. Safe because queue order already serialises the GPU
	 * work that shares the transients; the caller must not destroy the graph (or a cache evict it)
	 * while a run is in flight, i.e. the graph is owned, not in cachedGraph. The returned promise only
	 * reads back.
	 */
	runOwned(
		parameters: P,
		opts: GraphRunOptions<P> = {},
	): Promise<GraphRunResult> {
		return this.execute(parameters, opts);
	}

	/** run()'s body: synchronous up to the submit, then the reads (and timings) as a promise. */
	private execute(
		parameters: P,
		opts: GraphRunOptions<P>,
	): Promise<GraphRunResult> {
		if (opts.signal?.aborted) return Promise.reject(opts.signal.reason);
		const compiled = this.compile().compiled as CompiledGPUCommandGraph<P>;
		const prof = profiling(this.device);
		const timed =
			(opts.timings || prof) &&
			this.device.features.has("timestamp-query") &&
			!this.timing;
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
		const finish = () => {
			// whatever threw (staging, submit, a checked submit's validation error, a read, the
			// timings), no staged slot stays reserved: cancel is a no-op on reads already taken
			staged?.cancel();
			nodeReads.cancel();
			if (timed) this.timing = false;
		};
		if (timed) this.timing = true;
		try {
			staged = stageReads(this.device, enc, opts.read ?? []);
			opts.signal?.throwIfAborted(); // nothing submitted yet: finish() returns the slots
			submit(this.device, enc);
		} catch (e) {
			finish();
			return Promise.reject(e);
		}
		const pending = staged;
		const result = (async () => {
			try {
				const [data, reads] = await Promise.all([
					pending.read(),
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
				finish();
			}
		})();
		return abortable(result, opts.signal);
	}

	/**
	 * Resources the graph's builder created for it (constant buffers, textures): destroyed with the graph
	 * (a cachedGraph eviction, device-loss cleanup, releaseCachedGraphs). The collection is read at
	 * destroy time, so a builder may keep pushing to the array it passed.
	 */
	own(resources: Iterable<{ destroy(): void }>): this {
		this.owned.push(resources);
		return this;
	}

	private owned: Iterable<{ destroy(): void }>[] = [];

	/** Bytes of the builder-owned resources that report a `byteLength` (see own()). */
	ownedBytes(): number {
		let n = 0;
		for (const resources of this.owned)
			for (const r of resources)
				n += (r as { byteLength?: number }).byteLength ?? 0;
		return n;
	}

	/** Bytes this graph holds that its cache entry can free: physical transients plus owned resources. */
	residentBytes(): number {
		const s = this.compiled?.stats;
		return (
			(s?.physicalTransientBytes ?? 0) +
			(s?.physicalTransientTextureBytes ?? 0) +
			this.ownedBytes()
		);
	}

	/** Free the compiled graph's transients, pipelines and timestamp slots (and what it owns). */
	destroy() {
		for (const resources of this.owned) for (const r of resources) r.destroy();
		this.owned = [];
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
/** Default per-device budget of compiled transient + owned bytes across all cached graphs. */
export const GRAPH_CACHE_BUDGET_BYTES = 512 * 1024 * 1024;
let defaultBudget = GRAPH_CACHE_BUDGET_BYTES;
const budgets = new WeakMap<Device, number>();
/** global recency stamp per entry (higher = more recently looked up) */
const stamps = new WeakMap<CachedGraph<unknown, unknown>, number>();
let clock = 0;
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
 * `create(id)` builds the ComputeGraph instead of `new ComputeGraph(device, id)`, e.g. one adopting a
 * GPUProgramCompiler's lowering graph whose nodes are added while the program compiles (haze-argmin).
 */
export function cachedGraph<P, X = undefined>(
	device: Device,
	group: string,
	key: string,
	build: (g: ComputeGraph<P>) => X,
	max = MAX_CACHED,
	create?: (id: string) => ComputeGraph<P>,
): CachedGraph<P, X> {
	return cachedGraphFrom(
		device,
		group,
		key,
		(id) => {
			const graph = create ? create(id) : new ComputeGraph<P>(device, id);
			return { graph, extra: build(graph) };
		},
		max,
	);
}

/**
 * cachedGraph for a graph the caller creates itself: `make(id)` returns the graph (id `${group}|${key}`,
 * not compiled) and the extra. Same cache, LRU, lease and device-loss rules as cachedGraph.
 */
export function cachedGraphFrom<P, X = undefined>(
	device: Device,
	group: string,
	key: string,
	make: (id: string) => { graph: ComputeGraph<P>; extra: X },
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
		watchOutOfMemory(device);
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
	} else e = { ...make(`${group}|${key}`), hit: false };
	m.set(key, e as CachedGraph<unknown, unknown>);
	stamps.set(e as CachedGraph<unknown, unknown>, ++clock);
	while (m.size > Math.max(1, max)) {
		const [k0, old] = m.entries().next().value as [
			string,
			CachedGraph<unknown, unknown>,
		];
		m.delete(k0);
		void old.graph.lease(() => old.graph.destroy());
	}
	evictToBudget(device, budgetOf(device), e as CachedGraph<unknown, unknown>);
	return e;
}

const budgetOf = (device: Device) => budgets.get(device) ?? defaultBudget;

/**
 * Byte budget of the compiled graphs cached for `device` (or the default for every device without
 * its own when `device` is null): when a lookup pushes the resident bytes over it, the globally
 * least recently used graphs are evicted (never the one returned). The per-group count `max` still
 * applies. Lowering it evicts at once.
 */
export function setGraphCacheBudget(
	device: Device | null,
	bytes: number,
): void {
	if (device) {
		budgets.set(device, bytes);
		evictToBudget(device, bytes);
	} else defaultBudget = bytes;
}

/** Resident bytes of the cached graphs of `device` (compiled transients + owned resources). */
export function cachedGraphBytes(device: Device): number {
	let n = 0;
	for (const m of caches.get(device)?.values() ?? [])
		for (const e of m.values()) n += e.graph.residentBytes();
	return n;
}

/**
 * Evict least-recently-used graphs of `device` (across groups) until at most `limit` bytes remain,
 * sparing `keep`. Each is destroyed under its lease, i.e. after any run in flight. Entries that are
 * not compiled hold nothing and stay.
 */
function evictToBudget(
	device: Device,
	limit: number,
	keep?: CachedGraph<unknown, unknown>,
): void {
	const groups = caches.get(device);
	if (!groups) return;
	let total = cachedGraphBytes(device);
	while (total > limit) {
		let victim: CachedGraph<unknown, unknown> | undefined;
		let victimMap: Map<string, CachedGraph<unknown, unknown>> | undefined;
		let victimKey = "";
		let victimGroup = "";
		let best = Number.POSITIVE_INFINITY;
		for (const [group, m] of groups)
			for (const [k, e] of m) {
				if (e === keep || e.graph.residentBytes() === 0) continue;
				const st = stamps.get(e) ?? 0;
				if (st < best) {
					best = st;
					victim = e;
					victimMap = m;
					victimKey = k;
					victimGroup = group;
				}
			}
		if (!victim || !victimMap) return;
		total -= victim.graph.residentBytes();
		victimMap.delete(victimKey);
		const g = victim.graph;
		// Another group's caller may hold this graph between its lookup and its run (e.g. across an
		// await compileAsync()) inside its own group lease (the cachedGraph contract): destroy only
		// after that lease and then the graph's own, so such a caller's run still finds it alive.
		void withLease(victimGroup, () => g.lease(() => g.destroy()));
	}
}

// memory pressure (core/oom.ts): cached graphs down to half the budget
registerPurger((device) => evictToBudget(device, budgetOf(device) / 2));

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
