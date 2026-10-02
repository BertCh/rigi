// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// GPU back-to-front sort of Gaussian splats, on the RENDER device (deck-webgpu/layers/splats.ts
// option `sortBackend: "gpu"`). Replaces the worker round trip of nearfield/splat-sort.ts: the depth
// keys are computed from the splat storage buffer the draw already reads, a stable two-pass radix
// sort writes the order buffer the splat vertex shader indexes, and nothing comes back to the CPU.
//
//   const sorter = new GpuSplatSorter(device, dataBuffer, orderBuffer, count);
//   sorter.sort(row);   // records + submits its own encoder; the queue orders it before any
//                       // frame submit that comes later, so the draw being encoded sees the new order
//   sorter.destroy();
//
// Key identity with the worker (details and the proof sketch in ./README.md): the keys are the same
// formula (16-bit, farthest = 0, `min(65535, trunc((maxD - d) * 65535 / span))`) in f32 instead of
// f64, and the sort is stable with the index tie-break, which is what the worker's counting sort
// does. So: same order wherever the keys agree; keys can differ by 1 at bin edges (not provably
// zero in WGSL).
//
// The ten dispatches are kernel nodes of one core ComputeGraph (cachedGraph group "splat-sort", keyed
// by the buffer sizes; every buffer is an import, bound per encode, so sorters of one size share the
// compiled graph): a clear node of the min/max words, then the nodes in the order of the former
// dispatchAll, coalesced by the graph into ONE compute pass, on the sorter's own encoder and submit.
//
// The order buffer holds ALL `count` splats: those at or behind the camera plane (the worker drops
// them) are given the key 65536 and sort to the end (ascending index among themselves), where the
// vertex shader's `clip.w < nearW` cull discards them. The caller therefore always draws `count`
// instances; there is no kept-count readback.
import type { Buffer, Device, QuerySet } from "@luma.gl/core";
import { getFlag } from "#/lib/flags";
import { type ComputeGraph, cachedGraph } from "../core/graph";
import { type BindKind, defineKernel, submit } from "../core/kernel";
import { GPUSort } from "../core/luma";
import { profiling, recordGpuTime } from "../core/profile";
import { errorChecks, submitted } from "../core/queue";
import {
	DEPTH_WGSL,
	DIGITS,
	KEYS_WGSL,
	RADIX_BITS,
	SCAN_DIGIT_WGSL,
	SCAN_TOTALS_WGSL,
	SCATTER_WGSL,
	TILE,
	TILE_WGSL,
} from "./splat-sort.wgsl";

/** The kernels' group and the core cachedGraph group (src/lib/gpu/app-graph/manifest.ts "splat-sort"). */
const GROUP = "splat-sort";
/** GPUBufferUsage bits (as deck-webgpu/layers/splats.ts). */
const STORAGE = 0x0080;
const COPY_DST = 0x0008;
const UNIFORM = 0x0040;

const U: [string, BindKind] = ["p", "uniform"];
const DEPTH = defineKernel(
	"splatsort-depth",
	DEPTH_WGSL,
	[
		U,
		["splatData", "read-only-storage"],
		["depth", "storage"],
		["mm", "storage"],
	],
	{ group: GROUP },
);
const KEYS = defineKernel(
	"splatsort-keys",
	KEYS_WGSL,
	[
		U,
		["depth", "read-only-storage"],
		["mm", "read-only-storage"],
		["keys", "storage"],
	],
	{ group: GROUP },
);
const tileSpec = (pass: 0 | 1) =>
	defineKernel(
		`splatsort-tile${pass}`,
		TILE_WGSL,
		[
			U,
			["keys", "read-only-storage"],
			["inIdx", "read-only-storage"],
			["rank", "storage"],
			["hist", "storage"],
		],
		{
			group: GROUP,
			constants: { SHIFT: pass * RADIX_BITS, FIRST: pass === 0 ? 1 : 0 },
		},
	);
const scatterSpec = (pass: 0 | 1) =>
	defineKernel(
		`splatsort-scatter${pass}`,
		SCATTER_WGSL,
		[
			U,
			["keys", "read-only-storage"],
			["inIdx", "read-only-storage"],
			["rank", "read-only-storage"],
			["hist", "read-only-storage"],
			["base", "read-only-storage"],
			["outIdx", "storage"],
		],
		{
			group: GROUP,
			constants: { SHIFT: pass * RADIX_BITS, FIRST: pass === 0 ? 1 : 0 },
		},
	);
const TILE0 = tileSpec(0);
const TILE1 = tileSpec(1);
const SCATTER0 = scatterSpec(0);
const SCATTER1 = scatterSpec(1);
const SCAN_DIGIT = defineKernel(
	"splatsort-scan-digit",
	SCAN_DIGIT_WGSL,
	[U, ["hist", "storage"], ["base", "storage"]],
	{ group: GROUP },
);
const SCAN_TOTALS = defineKernel(
	"splatsort-scan-totals",
	SCAN_TOTALS_WGSL,
	[U, ["base", "storage"]],
	{ group: GROUP },
);

/** Distinct sorter sizes kept compiled per device (one per live splat cloud, normally one). */
const MAX_GRAPHS = 4;

/** How many first sorts get an error check (a broken kernel fails on the first). */
const CHECKED_SORTS = 2;

type ErrorScopeDevice = {
	pushErrorScope: (f: "validation" | "out-of-memory") => void;
	popErrorScope: () => Promise<{ message: string } | null>;
};

export type GpuSplatSortStats = {
	sorts: number;
	/** CPU time to encode + submit the last sort (ms); the GPU time is not measured here. */
	lastEncodeMs: number;
};

/** True when `device` can run the sort (WebGPU, workgroup storage ≥ 3 KB, ≥ 6 storage buffers). */
export function gpuSplatSortSupported(device: Device): boolean {
	return (
		device.type === "webgpu" &&
		!device.isLost &&
		device.limits.maxStorageBuffersPerShaderStage >= 7 &&
		device.limits.maxComputeInvocationsPerWorkgroup >= TILE &&
		device.limits.maxComputeWorkgroupStorageSize >= (TILE + DIGITS) * 4
	);
}

/** The sorter's buffers by graph import id. */
type SortBuffers = Record<
	| "params"
	| "data"
	| "order"
	| "depth"
	| "mm"
	| "keys"
	| "rank"
	| "tmp"
	| "hist"
	| "base",
	Buffer
>;

/**
 * The sort graph for buffers of these sizes: a clear of `mm`, then depth → keys → two radix passes
 * (tile → scan-digit → scan-totals → scatter), the bindings of the former dispatchAll call for call
 * (whole buffers, except the index arrays bound to exactly `count` words).
 */
function buildSortGraph(
	g: ComputeGraph,
	buffers: SortBuffers,
	count: number,
	blocks: number,
	lumaSort: boolean,
) {
	const imp = (id: keyof SortBuffers, usage = STORAGE | COPY_DST) =>
		g.importBuffer(id, buffers[id].byteLength, undefined, usage);
	const p = imp("params", UNIFORM);
	const splatData = imp("data", STORAGE);
	const order = imp("order");
	const depth = imp("depth");
	const mm = imp("mm");
	const keys = imp("keys");
	const rank = imp("rank");
	const tmp = imp("tmp");
	const bytes = count * 4;
	const orderRange = { buffer: order, size: bytes };
	const tmpRange = { buffer: tmp, size: bytes };
	g.clearNode("clear-mm", mm);
	g.addKernel({
		id: "depth",
		spec: DEPTH,
		bindings: { p, splatData, depth, mm },
		workgroups: [blocks],
	});
	g.addKernel({
		id: "keys",
		spec: KEYS,
		bindings: { p, depth, mm, keys },
		workgroups: [blocks],
	});
	if (lumaSort) {
		// luma's stable radix GPUSort over the 17 significant key bits: keys → order, with the identity
		// (tmp, written once at construction) as payload and rank as the (unused) sorted-key output
		g.add(
			new GPUSort({
				id: "sort",
				keys: g.view(keys, "uint32", count),
				values: g.view(tmp, "uint32", count),
				outputKeys: g.view(rank, "uint32", count),
				outputValues: g.view(order, "uint32", count),
				algorithm: "radix",
				keyBits: 17,
			}),
		);
		return;
	}
	const hist = imp("hist");
	const base = imp("base");
	// pass 0 reads the identity (FIRST) into tmp; pass 1 reads tmp into the order buffer
	const pass = (
		k: 0 | 1,
		inIdx: typeof orderRange,
		outIdx: typeof orderRange,
	) => {
		g.addKernel({
			id: `tile${k}`,
			spec: k ? TILE1 : TILE0,
			bindings: { p, keys, inIdx, rank, hist },
			workgroups: [blocks],
		});
		g.addKernel({
			id: `scan-digit${k}`,
			spec: SCAN_DIGIT,
			bindings: { p, hist, base },
			workgroups: [DIGITS],
		});
		g.addKernel({
			id: `scan-totals${k}`,
			spec: SCAN_TOTALS,
			bindings: { p, base },
			workgroups: [1],
		});
		g.addKernel({
			id: `scatter${k}`,
			spec: k ? SCATTER1 : SCATTER0,
			bindings: { p, keys, inIdx, rank, hist, base, outIdx },
			workgroups: [blocks],
		});
	};
	pass(0, orderRange, tmpRange);
	pass(1, tmpRange, orderRange);
}

export class GpuSplatSorter {
	readonly stats: GpuSplatSortStats = { sorts: 0, lastEncodeMs: 0 };
	private readonly blocks: number;
	private readonly params: Buffer;
	private readonly buffers: SortBuffers;
	private readonly owned: Buffer[];
	/** cachedGraph key: the buffer sizes (the graph's import capacities and bindings) */
	private readonly graphKey: string;
	private compiled = false;
	/** keys → luma GPUSort radix (flag splatSortGpgpu) instead of the in-house tile/scan/scatter passes */
	private lumaSort: boolean;
	/** timestamp slots of profiled sorts (core profile, opt-in) */
	private timestamps: QuerySet | null = null;
	/** Resolves when the graph is compiled; rejects if a pipeline fails (caller falls back). */
	readonly ready: Promise<void>;
	private checked = 0;

	/**
	 * @param data the splat storage buffer (3 × vec4<u32> per splat, position at word 0 of each
	 *   splat: deck-webgpu/layers/splats.ts SPLAT_WORDS), read only
	 * @param order the order buffer (count × u32, STORAGE): written with the sorted indices
	 */
	constructor(
		readonly device: Device,
		data: Buffer,
		order: Buffer,
		readonly count: number,
	) {
		this.blocks = Math.max(1, Math.ceil(count / TILE));
		this.lumaSort = getFlag("splatSortGpgpu") === "on";
		const n4 = Math.max(16, count * 4);
		const mk = (id: string, bytes: number, usage = STORAGE) =>
			device.createBuffer({
				id: `splatsort-${id}`,
				byteLength: Math.max(16, bytes),
				usage: usage | COPY_DST,
			});
		this.params = mk("params", 32, UNIFORM);
		const own = {
			params: this.params,
			depth: mk("depth", n4),
			mm: mk("mm", 8),
			keys: mk("keys", n4),
			rank: mk("rank", n4),
			tmp: mk("tmp", n4),
			hist: mk("hist", this.lumaSort ? 16 : DIGITS * this.blocks * 4),
			base: mk("base", this.lumaSort ? 16 : DIGITS * 4),
		};
		this.owned = Object.values(own);
		this.buffers = { ...own, data, order };
		this.graphKey = `${count}:${data.byteLength}:${order.byteLength}`;
		if (this.lumaSort) {
			// the identity payload GPUSort permutes (tmp is the radix passes' scratch otherwise)
			const ident = new Uint32Array(n4 / 4);
			for (let i = 0; i < ident.length; i++) ident[i] = i;
			own.tmp.write(ident);
		}
		// async compile (createComputePipelineAsync; rejects on a failed pipeline); sort() is refused
		// until it lands. The graph lookup runs inside the promise, so a throwing build (a lost device,
		// an import the graph rejects) rejects `ready` too: the layer then fails over to the worker and
		// destroy()s the buffers above instead of the constructor throwing past them
		this.ready = Promise.resolve()
			.then(() => this.graph().compileAsync())
			.catch((e) => {
				// the luma sort failed to build or compile on this device: the in-house passes need
				// hist / base at full size and the identity out of tmp
				if (!this.lumaSort) throw e;
				console.warn(
					"[splat-sort] luma GPUSort unavailable, using the radix passes",
					e,
				);
				this.lumaSort = false;
				this.resizeForRadix();
				return this.graph().compileAsync();
			})
			.then(() => {
				this.compiled = true;
			});
	}

	/** Re-allocate hist / base at radix size after a luma-sort failure. */
	private resizeForRadix() {
		const mk = (id: string, bytes: number) =>
			this.device.createBuffer({
				id: `splatsort-${id}`,
				byteLength: bytes,
				usage: STORAGE | COPY_DST,
			});
		for (const id of ["hist", "base"] as const) {
			const i = this.owned.indexOf(this.buffers[id]);
			this.buffers[id].destroy();
			const b = mk(id, id === "hist" ? DIGITS * this.blocks * 4 : DIGITS * 4);
			this.buffers[id] = b;
			if (i >= 0) this.owned[i] = b;
		}
	}

	/** This sorter's graph (a hit after the first lookup; rebuilt if an LRU eviction dropped it). */
	private graph(): ComputeGraph {
		return cachedGraph<void, void>(
			this.device,
			GROUP,
			this.lumaSort ? `${this.graphKey}:gpusort` : this.graphKey,
			(g) =>
				buildSortGraph(g, this.buffers, this.count, this.blocks, this.lumaSort),
			MAX_GRAPHS,
		).graph;
	}

	/** Pipelines compiled: sort() may be called. */
	get isReady(): boolean {
		return this.compiled;
	}

	/**
	 * Sort by the depth row (worker DepthRow: view z = a x + b y + c z + d, camera looks down -z;
	 * depth = -z, kept when > 0) and write the order buffer. One submit, no readback.
	 *
	 * Returns a promise that rejects on a validation / out-of-memory error of the submit, for the
	 * first `CHECKED_SORTS` sorts only (undefined afterwards): with __RIGI_GPU_CHECKS__ on it is
	 * core's `submitted(enc)`, otherwise a validation + out-of-memory error scope around the submit.
	 * An invalid submit writes nothing, so the order buffer keeps its previous (valid) contents.
	 */
	sort(
		row: readonly [number, number, number, number],
	): Promise<void> | undefined {
		if (!this.compiled) throw new Error("[splat-sort] sort() before ready");
		const t0 = performance.now();
		const { device, blocks, count } = this;
		const w = new ArrayBuffer(32);
		const fl = new Float32Array(w);
		const u = new Uint32Array(w);
		fl.set(row, 0);
		fl[4] = 0; // near: the worker's default and what SplatsCore uses; depth keys need near >= 0
		u[5] = count;
		u[6] = blocks;
		this.params.write(new Uint8Array(w));
		// encoded and submitted synchronously, so a cache eviction (a destroy queued under the graph's
		// lease) can never land in between; a graph rebuilt after one compiles here from the
		// per-device pipeline cache the first compileAsync filled (throws while another sorter's
		// compileAsync of the same key is in flight: the caller then falls back to the worker)
		const graph = this.graph();
		graph.compile();
		const timed = profiling(device);
		if (timed)
			this.timestamps ??= device.createQuerySet({
				type: "timestamp",
				count: 2 * (graph.stats?.nodeCount ?? 0) + 2,
			});
		const enc = device.createCommandEncoder({
			id: "splatsort",
			...(timed ? { timeProfilingQuerySet: this.timestamps } : {}),
		});
		const encoding = graph.encode(enc, undefined, this.encodeBuffers());
		const check = this.checked++ < CHECKED_SORTS;
		let verdict: Promise<void> | undefined;
		if (check && !errorChecks()) {
			const raw = (device as unknown as { handle?: ErrorScopeDevice }).handle;
			if (raw?.pushErrorScope) {
				raw.pushErrorScope("out-of-memory");
				raw.pushErrorScope("validation");
				submit(device, enc);
				const v = raw.popErrorScope();
				const m = raw.popErrorScope();
				verdict = Promise.all([v, m]).then(([ve, me]) => {
					const e = ve ?? me;
					if (e) throw new Error(e.message);
				});
			} else submit(device, enc);
		} else {
			submit(device, enc);
			if (check) verdict = submitted(enc);
		}
		// profiling only (opt-in): per-node GPU ms under `${graph.id}/${node}`, as ComputeGraph.run
		// reports them (an observed graph's inspector takes the one timing read)
		if (timed && encoding.canReadGPUTimings) {
			const observation = graph.inspect();
			(observation
				? observation
						.recordGPUTimings(encoding)
						.then((r) => r ?? encoding.readTimings())
				: encoding.readTimings()
			).then(
				(timings) => {
					for (const n of timings.nodes)
						if (n.gpuTimeMilliseconds !== undefined)
							recordGpuTime(`${graph.id}/${n.id}`, n.gpuTimeMilliseconds);
				},
				() => {},
			);
		}
		this.stats.sorts++;
		this.stats.lastEncodeMs = performance.now() - t0;
		return verdict;
	}

	/** The imports the graph declares (the luma variant has no hist / base). */
	private encodeBuffers(): Partial<SortBuffers> {
		if (!this.lumaSort) return this.buffers;
		const { hist: _h, base: _b, ...rest } = this.buffers;
		return rest;
	}

	destroy(): void {
		for (const b of this.owned) b.destroy();
		this.timestamps?.destroy();
		this.timestamps = null;
	}
}
