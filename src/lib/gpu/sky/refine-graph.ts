// The GPU sky refine (refine.ts) on gpu-core's GPUCommandGraph, via core/graph.ts ComputeGraph.
// Selected per call with `refineSkyGpu(device, { …, graph: true })`; the default stays the pooled
// dispatchAll path in refine.ts.
//
// Same seven kernels (the KernelSpecs of refine.ts, unchanged WGSL), same workgroup counts, same
// dispatch order (a linear chain, so the graph's topological order is the insertion order and the
// seven dispatches coalesce into one compute pass exactly like dispatchAll). What changes:
// - the ten intermediates (t, ab, band, abH, bandH, abS, pb, u4, u2, q) and the byte mask are graph
//   TRANSIENTS, sized exactly (the pool rounds each to a power of two) and aliased by lifetime: the
//   low-res t / ab / band / … die before the full-res u4 / u2 / q / bytes are born;
// - the inputs (params, guideLo, P(sky), rgba, axis taps, LUT) are graph IMPORTS, still pooled under
//   the "sky-refine" lease (graph imports are caller-owned). ORT's output GPUBuffer is imported per
//   run (wrapped, not owned), so the model output never leaves the GPU;
// - the byte mask (and the float mask when asked) are read by a local read node on the graph's
//   encoder (transients cannot be read through ComputeGraph.run, which reads imports only);
// - compiled graphs are cached by shape (lw, lh, W, H) in a small per-device LRU (radius / eps / band
//   are uniforms, so they do not key the cache).
//
// Clear audit (aliasing hands a transient another transient's stale bytes, and transients are never
// zeroed per encoding): every kernel here writes every element of its outputs' logical ranges and
// none uses atomics (see refine.wgsl.ts: each output is written once per invocation index < count,
// and the dispatch covers the whole count), so no clear node is needed. The rule is enforced, not
// assumed: every storage binding carries a write mode (default "full"); a transient written
// "partial" or "atomic" without a preceding clear node makes build() throw (lintClears). The
// generic helpers here (clearNode, readNode, lintClears, ShapeCache) should move into core/graph.ts.
import { Buffer, type CommandEncoder, type Device } from "@luma.gl/core";
import { ComputeGraph, type KernelNode } from "#/lib/gpu/core/graph";
import { onLost } from "#/lib/gpu/core/lifecycle";
import type {
	CompiledGPUCommandGraph,
	GraphBufferHandle,
} from "#/lib/gpu/core/luma";

type GPUCommandGraphStats = CompiledGPUCommandGraph<unknown>["stats"];

import {
	clear,
	pooledStorage,
	pooledUniform,
	withLease,
} from "#/lib/gpu/core/pool";
import { type StagedRead, stageReads } from "#/lib/gpu/core/readback";
import {
	axisTable,
	isFloats,
	K_LO_H,
	K_LO_H2,
	K_LO_V,
	K_LO_V2,
	K_PACK,
	K_UP_H,
	K_UP_V,
	lutTable,
	type SkyRefineInput,
	type SkyRefineOutput,
} from "./refine";

// ---- generic graph helpers (candidates for core/graph.ts) ----

/** How a kernel writes one of its storage bindings. */
export type WriteMode = "full" | "partial" | "atomic";

/** A KernelNode whose storage outputs declare how they are written (default "full"). */
export type AuditedKernelNode<P> = KernelNode<P> & {
	writes?: Record<string, WriteMode>;
};

/** Per-run sink the read nodes fill (the graph's parameters carry it). */
export type ReadSink = { reads: StagedRead[] };

type Audit = {
	/** node id → transient ids it clears */
	clears: Map<string, GraphBufferHandle[]>;
	/** node id → transients written partially / atomically */
	partial: Map<string, GraphBufferHandle[]>;
	/** node id → every buffer the node touches */
	uses: Map<string, GraphBufferHandle[]>;
};

const STORAGE = Buffer.STORAGE | Buffer.COPY_SRC | Buffer.COPY_DST;

/**
 * ComputeGraph plus the pieces core/graph.ts does not have yet: audited kernels, clear nodes, read
 * nodes for transients, and the clear lint.
 */
export class AuditedGraph<P extends ReadSink> {
	readonly g: ComputeGraph<P>;
	private readonly audit: Audit = {
		clears: new Map(),
		partial: new Map(),
		uses: new Map(),
	};

	constructor(device: Device, id: string) {
		this.g = new ComputeGraph<P>(device, id);
	}

	/** addKernel, recording which storage outputs are not fully written. */
	addKernel(node: AuditedKernelNode<P>): this {
		this.g.addKernel(node);
		const partial: GraphBufferHandle[] = [];
		const uses: GraphBufferHandle[] = [];
		for (const [name, kind] of node.spec.layout) {
			const b = node.bindings[name] as GraphBufferHandle;
			uses.push(b);
			const mode = node.writes?.[name] ?? "full";
			if (kind === "storage" && mode !== "full") partial.push(b);
			else if (kind !== "storage" && node.writes?.[name])
				throw new Error(`${node.id}: "${name}" is not a storage output`);
		}
		this.audit.partial.set(node.id, partial);
		this.audit.uses.set(node.id, uses);
		return this;
	}

	/** A copy-type node zero-filling `buffer` (encoder clearBuffer over its logical byte length). */
	clearNode(id: string, buffer: GraphBufferHandle, dependsOn?: string[]): this {
		this.g.graph.addCopyPass({
			id,
			dependsOn,
			resources: [{ buffer, usage: "copy-destination" }],
			compile: () => ({
				encode: ({ commandEncoder, getBuffer }) =>
					clear(commandEncoder, getBuffer(buffer), 0, buffer.byteLength),
			}),
		});
		this.audit.clears.set(id, [buffer]);
		this.audit.uses.set(id, [buffer]);
		return this;
	}

	/**
	 * A copy-type node staging reads of (transient or imported) buffers into readback.ts slots on the
	 * graph's encoder: one StagedRead per encoding, pushed onto `parameters.reads`. `ranges` picks
	 * the buffers and byte counts per run (all declared buffers are kept alive to this node).
	 */
	readNode(
		id: string,
		buffers: GraphBufferHandle[],
		ranges: (p: P) => { buffer: GraphBufferHandle; size: number }[],
	): this {
		const device = this.g.device;
		this.g.graph.addCopyPass({
			id,
			resources: buffers.map((buffer) => ({ buffer, usage: "copy-source" })),
			compile: () => ({
				encode: ({ commandEncoder, getBuffer, parameters }) => {
					parameters.reads.push(
						stageReads(
							device,
							commandEncoder as CommandEncoder,
							ranges(parameters).map(({ buffer, size }) => ({
								buffer: getBuffer(buffer),
								size,
							})),
						),
					);
				},
			}),
		});
		this.audit.uses.set(id, buffers);
		return this;
	}

	/** Compile, then check the clear rule against the scheduled order (throws; destroys on failure). */
	compile(): { stats: GPUCommandGraphStats } {
		this.g.compile();
		const compiled = (
			this.g as unknown as { compiled: CompiledGPUCommandGraph<P> }
		).compiled;
		try {
			lintClears(compiled.stats.nodeOrder, this.audit);
		} catch (e) {
			this.g.destroy();
			throw e;
		}
		return { stats: compiled.stats };
	}
}

/**
 * Every transient written "partial" or "atomic" needs a clear node scheduled before that write and
 * before any other use of it in the encoding (aliasing or a previous run left arbitrary bytes).
 */
export function lintClears(order: readonly string[], a: Audit) {
	for (const [node, bufs] of a.partial)
		for (const b of bufs) {
			if (!b.transient) continue;
			const at = order.indexOf(node);
			let cleared = false;
			for (const n of order.slice(0, at)) {
				if (a.clears.get(n)?.includes(b)) cleared = true;
				else if (!cleared && a.uses.get(n)?.includes(b))
					throw new Error(`clear lint: ${n} uses ${b.id} before its clear`);
			}
			if (!cleared)
				throw new Error(
					`clear lint: transient ${b.id} is written ${node} without a preceding clear node`,
				);
		}
}

/** A per-device LRU of compiled graphs keyed by shape (destroys evicted graphs). */
export class ShapeCache<V extends { destroy(): void }> {
	private readonly byDevice = new WeakMap<Device, Map<string, V>>();
	constructor(readonly maxEntries: number) {}

	get(device: Device, key: string, build: () => V): { value: V; hit: boolean } {
		let m = this.byDevice.get(device);
		if (!m) {
			const fresh = new Map<string, V>();
			this.byDevice.set(device, fresh);
			// a lost device's buffers are gone; forget (do not destroy) its graphs
			onLost(device, () => {
				fresh.clear();
				this.byDevice.delete(device);
			});
			m = fresh;
		}
		const v = m.get(key);
		if (v) {
			m.delete(key);
			m.set(key, v);
			return { value: v, hit: true };
		}
		const value = build();
		m.set(key, value);
		while (m.size > this.maxEntries) {
			const [k, old] = m.entries().next().value as [string, V];
			m.delete(k);
			old.destroy();
		}
		return { value, hit: false };
	}

	keys(device: Device) {
		return [...(this.byDevice.get(device)?.keys() ?? [])];
	}

	clear(device: Device) {
		const m = this.byDevice.get(device);
		if (!m) return;
		for (const v of m.values()) v.destroy();
		m.clear();
	}
}

// ---- the sky refine graph ----

const WG = 256;

type Params = ReadSink & { floats: boolean };

/** One compiled refine graph for one (lw, lh, W, H). */
export type SkyGraph = {
	key: string;
	graph: ComputeGraph<Params>;
	stats: GPUCommandGraphStats;
	destroy(): void;
};

/** Byte sizes of every intermediate (the old path's pooled scratch slots, before pow2 rounding). */
export function skyScratchBytes(lw: number, lh: number, W: number, H: number) {
	const n = lw * lh;
	const N = W * H;
	return {
		t: n * 64,
		ab: n * 16,
		band: n * 4,
		abH: n * 16,
		bandH: n * 4,
		abS: n * 16,
		pb: n * 8,
		u4: W * lh * 16,
		u2: W * lh * 8,
		q: N * 4,
		bytes: Math.ceil(N / 4) * 4,
	};
}

/** Build and compile the refine graph for one shape (the ORT / float P(sky) is imported per run). */
export function buildSkyGraph(
	device: Device,
	lw: number,
	lh: number,
	W: number,
	H: number,
): SkyGraph {
	const n = lw * lh;
	const N = W * H;
	const nWords = Math.ceil(N / 4);
	const key = `${lw}x${lh}>${W}x${H}`;
	const a = new AuditedGraph<Params>(device, `sky-refine/${key}`);
	const { g } = a;
	const prm = g.importBuffer(
		"prm",
		32,
		undefined,
		Buffer.UNIFORM | Buffer.COPY_DST,
	);
	const gl = g.importBuffer("gl", 3 * n * 4, undefined, Buffer.STORAGE);
	const gp = g.importBuffer("gp", n * 4, undefined, Buffer.STORAGE);
	const rgba = g.importBuffer("rgba", N * 4, undefined, Buffer.STORAGE);
	const axis = g.importBuffer(
		"axis",
		axisTable(lw, lh, W, H).byteLength,
		undefined,
		Buffer.STORAGE,
	);
	const lut = g.importBuffer("lut", 512 * 4, undefined, Buffer.STORAGE);
	const sz = skyScratchBytes(lw, lh, W, H);
	const tr = (id: keyof typeof sz) => g.transientBuffer(id, sz[id], STORAGE);
	const t = tr("t");
	const ab = tr("ab");
	const band = tr("band");
	const abH = tr("abH");
	const bandH = tr("bandH");
	const abS = tr("abS");
	const pb = tr("pb");
	const u4 = tr("u4");
	const u2 = tr("u2");
	const q = tr("q");
	const bytes = tr("bytes");
	const lo: [number] = [Math.ceil(n / WG)];
	// one texel (or packed word) per invocation, 1-D: past maxComputeWorkgroupsPerDimension · 256
	// (≈ 16.7 Mpx at the WebGPU default 65535) the up-v dispatch is invalid. Refuse (the worker then
	// takes the CPU refine) instead of submitting an invalid encoder.
	const maxWg = device.limits.maxComputeWorkgroupsPerDimension;
	if (Math.ceil(Math.max(N, W * lh, n) / WG) > maxWg)
		throw new Error(
			`refineSkyGraph: ${W}x${H} needs more than ${maxWg} workgroups per dispatch`,
		);
	a.addKernel({
		id: "lo-h",
		spec: K_LO_H,
		bindings: { prm, gl, gp, t },
		workgroups: lo,
	})
		.addKernel({
			id: "lo-v",
			spec: K_LO_V,
			bindings: { prm, t, gp, ab, band },
			workgroups: lo,
		})
		.addKernel({
			id: "lo-h2",
			spec: K_LO_H2,
			bindings: { prm, ab, band, abH, bandH },
			workgroups: lo,
		})
		.addKernel({
			id: "lo-v2",
			spec: K_LO_V2,
			bindings: { prm, abH, bandH, gp, abS, pb },
			workgroups: lo,
		})
		.addKernel({
			id: "up-h",
			spec: K_UP_H,
			bindings: { prm, axis, abS, pb, u4, u2 },
			workgroups: [Math.ceil((W * lh) / WG)],
		})
		.addKernel({
			id: "up-v",
			spec: K_UP_V,
			bindings: { prm, axis, u4, u2, rgba, lut, q },
			workgroups: [Math.ceil(N / WG)],
		})
		.addKernel({
			id: "pack",
			spec: K_PACK,
			bindings: { prm, q, lut, bytes },
			workgroups: [Math.ceil(nWords / WG)],
		})
		.readNode("read", [bytes, q], (p) =>
			p.floats
				? [
						{ buffer: bytes, size: nWords * 4 },
						{ buffer: q, size: N * 4 },
					]
				: [{ buffer: bytes, size: nWords * 4 }],
		);
	const { stats } = a.compile();
	return { key, graph: g, stats, destroy: () => g.destroy() };
}

/**
 * Compiled graphs kept per device. Each holds its transients (≈ the old pool's scratch), so keep
 * this small: photos in one session mostly share a size; a new size evicts the oldest.
 */
export const skyGraphCache = new ShapeCache<SkyGraph>(2);

/** Last-run info for benches (cache hit, the compiled graph's stats). */
export let lastSkyGraphRun:
	| { key: string; hit: boolean; stats: GPUCommandGraphStats }
	| undefined;

/** refineSkyGpu's graph path: same inputs, same outputs, bit-identical. */
export async function refineSkyGraph(
	device: Device,
	input: SkyRefineInput,
): Promise<SkyRefineOutput> {
	const { W, H, lw, lh } = input;
	const n = lw * lh;
	const N = W * H;
	if (input.rgba.length !== 4 * N || input.guideLo.length !== 3 * n)
		throw new Error("refineSkyGraph: input sizes do not match");
	return withLease("sky-refine", async () => {
		const { value: sg, hit } = skyGraphCache.get(
			device,
			`${lw}x${lh}>${W}x${H}`,
			() => buildSkyGraph(device, lw, lh, W, H),
		);
		lastSkyGraphRun = { key: sg.key, hit, stats: sg.stats };
		const words = new ArrayBuffer(32);
		new Uint32Array(words, 0, 6).set([
			lw,
			lh,
			W,
			H,
			input.radius ?? 3,
			input.band ?? 3,
		]);
		new Float32Array(words, 24, 1)[0] = input.eps ?? 2e-3;
		const prm = pooledUniform(device, "sky-refine/prm", words);
		const gl = pooledStorage(device, "sky-refine/guideLo", input.guideLo);
		const gp: Buffer = isFloats(input.prob)
			? pooledStorage(device, "sky-refine/prob", input.prob)
			: // ORT's buffer, wrapped (not owned; destroying the wrapper leaves the handle alone)
				device.createBuffer({
					id: "sky-refine/ort-prob",
					handle: input.prob,
					byteLength: input.prob.size,
					usage: input.prob.usage,
				});
		const rgba8 = new Uint8Array(
			input.rgba.buffer,
			input.rgba.byteOffset,
			input.rgba.byteLength,
		);
		const rgba = pooledStorage(
			device,
			"sky-refine/rgba",
			rgba8.byteOffset % 4 ? rgba8.slice() : rgba8,
		);
		const axis = pooledStorage(
			device,
			"sky-refine/axis",
			axisTable(lw, lh, W, H),
		);
		const lut = pooledStorage(device, "sky-refine/lut", lutTable());
		const params: Params = { reads: [], floats: !!input.floats };
		let b: ArrayBuffer;
		let f: ArrayBuffer | undefined;
		let read = false;
		try {
			await sg.graph.run(params, {
				buffers: { prm, gl, gp, rgba, axis, lut },
			});
			const [staged] = params.reads;
			if (!staged || params.reads.length !== 1)
				throw new Error("refineSkyGraph: read node did not run once");
			read = true;
			[b, f] = await staged.read();
		} finally {
			// every staged read not read gives its slot back (run() can throw after the read node ran)
			for (const [i, r] of params.reads.entries())
				if (i > 0 || !read) r.cancel();
			if (gp.props.handle) gp.destroy();
		}
		return {
			bytes: N % 4 ? new Uint8Array(b, 0, N).slice() : new Uint8Array(b, 0, N),
			q: f ? new Float32Array(f) : undefined,
		};
	});
}
