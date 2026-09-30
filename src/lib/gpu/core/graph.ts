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
// shared). Only imported (caller-owned) buffers can be read back.
import {
	Buffer,
	type CommandEncoder,
	type Device,
	type QuerySet,
} from "@luma.gl/core";
import {
	type BindKind,
	encodeDispatch,
	type KernelSpec,
	kernel,
} from "./kernel";
import { untilLost } from "./lifecycle";
import {
	type CompiledGPUCommandGraph,
	GPUCommandGraph,
	type GPUCommandGraphComputeNode,
	type GPUCommandGraphEncoding,
	type GPUCommandGraphTimingReport,
	type GPUScalarFormat,
	type GraphBufferHandle,
	type GraphBufferUsage,
	GraphDataView,
	type GraphImportedBuffer,
	type GraphImportedTexture,
	type GraphTextureDescriptor,
	type GraphTextureHandle,
} from "./luma";
import { withLease } from "./pool";
import { profiling, recordGpuTime } from "./profile";
import { submit } from "./queue";
import { type ReadRange, stageReads } from "./readback";

/** A graph buffer or a typed range of one (range offsets must be multiples of 256). */
export type GraphBinding = GraphBufferHandle | GraphDataView;

export type Workgroups = [number, number?, number?];

/** A compute node running a core kernel. */
export type KernelNode<P> = {
	id: string;
	spec: KernelSpec;
	/** one graph buffer / view per layout name of `spec` */
	bindings: Record<string, GraphBinding>;
	/** fixed, or per run from the parameters */
	workgroups: Workgroups | ((parameters: P) => Workgroups);
	/** explicit predecessors beyond the ones inferred from buffer uses */
	dependsOn?: string[];
};

/** Anything with gpu-core's addToGraph (GPUReduction, GPUSort, GPUHistogram, GPUScan, …). */
export type GraphOp<P> = { addToGraph: (graph: GPUCommandGraph<P>) => void };

const USE: Record<BindKind, GraphBufferUsage> = {
	uniform: "uniform",
	"read-only-storage": "storage-read",
	storage: "storage-read-write",
};

const STORAGE = Buffer.STORAGE | Buffer.COPY_SRC | Buffer.COPY_DST;

export class ComputeGraph<P = void> {
	readonly device: Device;
	readonly id: string;
	/** the underlying gpu-core graph, for ops this wrapper does not cover */
	readonly graph: GPUCommandGraph<P>;
	private compiled: CompiledGPUCommandGraph<P> | null = null;
	private timestamps: QuerySet | null = null;

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
		for (const [name] of spec.layout)
			if (!node.bindings[name])
				throw new Error(`${this.id}/${node.id}: no binding for "${name}"`);
		this.graph.addComputePass({
			id: node.id,
			dependsOn: node.dependsOn,
			resources: spec.layout.map(([name, kind]) => ({
				buffer: node.bindings[name],
				usage: USE[kind],
			})),
			compile: ({ device }) => {
				const k = kernel(device, spec);
				return {
					encode: ({ computePass, getBuffer, parameters }) => {
						const b: Record<
							string,
							{ buffer: Buffer; offset: number; size: number }
						> = {};
						for (const [name] of spec.layout) {
							const v = node.bindings[name];
							b[name] =
								v instanceof GraphDataView
									? {
											buffer: getBuffer(v),
											offset: v.byteOffset,
											size:
												Math.ceil(
													((v.length - 1) * v.byteStride + v.rowByteLength) / 4,
												) * 4,
										}
									: { buffer: getBuffer(v), offset: 0, size: v.byteLength };
						}
						const w =
							typeof node.workgroups === "function"
								? node.workgroups(parameters)
								: node.workgroups;
						encodeDispatch(computePass, k, b, w[0], w[1] ?? 1, w[2] ?? 1);
					},
				};
			},
		});
		return this;
	}

	/** Add a raw gpu-core compute node (custom encode). */
	addComputePass(node: Omit<GPUCommandGraphComputeNode<P>, "type">): this {
		this.graph.addComputePass(node);
		return this;
	}

	/** Add a gpu-core op (GPUReduction, GPUSort, …) built on this graph's handles. */
	add(op: GraphOp<P>): this {
		op.addToGraph(this.graph);
		return this;
	}

	/** Compile (once): schedules nodes, allocates transients, creates pipelines. */
	compile(): this {
		this.compiled ??= this.graph.compile();
		return this;
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
		return this.compiled.encode(enc, { parameters, buffers, textures });
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
	): Promise<{ data: ArrayBuffer[]; timings?: GPUCommandGraphTimingReport }> {
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
			const encoding = compiled.encode(enc, {
				parameters,
				buffers: opts.buffers,
				textures: opts.textures,
			});
			const staged = stageReads(this.device, enc, opts.read ?? []);
			try {
				submit(this.device, enc);
			} catch (e) {
				staged.cancel();
				throw e;
			}
			const data = await staged.read();
			if (!timed || !encoding.canReadGPUTimings) return { data };
			const timings = await untilLost(this.device, encoding.readTimings());
			if (prof)
				for (const n of timings.nodes)
					if (n.gpuTimeMilliseconds !== undefined)
						recordGpuTime(`${this.id}/${n.id}`, n.gpuTimeMilliseconds);
			return { data, timings };
		});
	}

	/** Free the compiled graph's transients, pipelines and timestamp slots. */
	destroy() {
		this.compiled?.destroy();
		this.compiled = null;
		this.timestamps?.destroy();
		this.timestamps = null;
	}
}
