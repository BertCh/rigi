// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The skyglobal grid's GPU phase on a core ComputeGraph: the only GPU path of gridGpu (./index.ts;
// the pooled per-pass dispatches it replaced, bit for bit, were removed on 2026-10-01). The CPU twin
// is ./cpu.ts.
//
// One encoding per grid, one submit, one read slot:
//   CELLS → REDUCE (subgroup or tree) → FLAGS → GPUCompaction (scan + scatter) → copy count to list[0]
//   → read [list head, red, (debug) cells]
// The three kernel specs of ./kernels.ts plus luma's GPUCompaction.
//
// Buffers:
// - `cells` (nCells × 16 B, ~24 MB) and `red` (nYaw × 16 B) are graph TRANSIENTS sized to
//   power-of-two capacities (so photos of similar size share a graph), aliased by the graph by
//   lifetime. Neither is read back mid-chain: red rides the final read (the CPU uses its
//   per-yaw mid argmax for stats.midArgFlips), cells only when debugGrid asks (a 0-byte range
//   otherwise, which stages no copy).
// - the inputs (u, S, prof, alpha, vfs, combos) are imports: pooled uploads under the "skyglobal"
//   lease, bound per run.
// - `vals` / `flags` / `count` (capCells × 4 B, capCells × 4 B, 4 B) are transients of the compaction:
//   vals[i] = i, flags[i] = candidate?, and the compaction's accepted count, which a copy node moves
//   into list[0] (count and output must not be one buffer inside one dispatch, WebGPU writable-alias
//   rules).
// - the candidate `list` ([count, ascending cell indices…], capCells + 1 words at least: the
//   compaction needs an output as long as its input) is an IMPORT (the pooled "skyglobal/list" slot), not a transient: a list
//   longer than the head read needs a second, exact-length read of its tail AFTER the encoding
//   resolved its count, and a graph transient cannot be read outside its encoding. Kept pooled (and
//   under the lease until that tail read), it keeps the count-first readback.
//
// Clear audit (transients are never zeroed and alias other transients' bytes): CELLS writes every
// cells[ci · nYaw + iy] in range (its only return is the range guard) and REDUCE writes red[iy] for
// every yaw workgroup, and the reads cover only those ranges, so both are "full" writes and need no
// clear. FLAGS writes vals / flags for the whole capacity (past nCells flags are 0), the compaction
// writes its scan offsets, the count and output[0..count) (a full write of what is read: list[0] by
// the copy, the head by readNode, the rest by the tail read, all within [0, count]). Nothing is atomic.
//
// Determinism: REDUCE's red[] is order-independent (see skyglobal.wgsl.ts) and the compaction is
// stable, so the whole list is deterministic run to run: the candidate cell indices (ci · nYaw + iy)
// in ASCENDING order, then count, red, cells and the re-scored {best, arg}. (The old CANDS appended
// with atomicAdd: same set, nondeterministic order.) The price is a scan over all capCells cells
// (~2M, to keep ~800); the scan and scatter are a few bandwidth-bound passes over 8 MB, cheap next to
// CELLS, and the stable order replaces an atomic hot spot on list[0].
//
// Per-call overhead: the compiled graph is cached per
// (subgroups, input / transient capacities) with core cachedGraph (group "skyglobal", 2 per device),
// so photos of similar size share one graph; pipelines come from the core kernel cache (the warm
// functions in ./index.ts compile them).
import { Buffer, type Device } from "@luma.gl/core";
import {
	type ComputeGraph,
	cachedGraph,
	releaseCachedGraphs,
} from "../core/graph";
import { GPUCompaction } from "../core/luma";
import {
	acquire,
	capacityFor,
	pooledStorage,
	pooledUniform,
} from "../core/pool";
import { hasFeature } from "../device";
import type { GridPlan, SkyGlobal } from "./cpu";
import type { GpuOut, GridGpuOptions, Packed } from "./index";
import {
	collect,
	decodeGpuRescore,
	headFor,
	K_CELLS,
	K_FLAGS,
	K_PICK,
	K_REDUCE,
	K_REDUCE_SG,
	K_RESCORE,
	key,
	OWNER,
	STORAGE,
} from "./kernels";

/** cachedGraph group of the skyglobal graphs (also the lease / pool prefix). */
export const SKYGLOBAL_GRAPH_GROUP = OWNER;
/** Compiled graphs kept per device (each holds a cells transient of up to ~32 MB). */
const MAX_GRAPHS = 2;

type Params = {
	nYaw: number;
	nCombo: number;
	head: number;
	debug: number;
	cap: number;
};
type GraphStats = NonNullable<ComputeGraph<Params>["stats"]>;

const INPUTS = ["u", "S", "prof", "alpha", "vfs", "combos", "list"] as const;
type Inputs = Record<(typeof INPUTS)[number], Buffer>;

/** Add the grid's nodes to `g` for these import sizes / transient capacities. */
function build(
	g: ComputeGraph<Params>,
	bufs: Inputs,
	sub: boolean,
	cellsBytes: number,
	redBytes: number,
	gpuRescore: boolean,
) {
	const imp = (id: keyof Inputs, usage = STORAGE) =>
		g.importBuffer(id, bufs[id].byteLength, undefined, usage);
	const u = imp("u", Buffer.UNIFORM | Buffer.COPY_DST);
	const S = imp("S");
	const prof = imp("prof");
	const alpha = imp("alpha");
	const vfs = imp("vfs");
	const combos = imp("combos");
	const list = imp("list");
	const cells = g.transientBuffer("cells", cellsBytes);
	const red = g.transientBuffer("red", redBytes);
	// the compaction runs over the transient's capacity, so the graph stays keyed on capacities
	const capCells = cellsBytes / 16;
	const vals = g.transientBuffer("vals", capCells * 4);
	const flags = g.transientBuffer("flags", capCells * 4);
	const count = g.transientBuffer("count", 4);
	// 256-wide groups over capCells; 2-D (linearised in the shader) past the dispatch limit
	const nGroups = Math.ceil(capCells / 256);
	const maxDim = g.device.limits.maxComputeWorkgroupsPerDimension;
	const groupsX = Math.min(nGroups, maxDim);
	const groupsY = Math.ceil(nGroups / groupsX);
	g.addKernel({
		id: "cells",
		spec: K_CELLS,
		bindings: { u, S, prof, alpha, vfs, combos, cells },
		workgroups: (p) => [Math.ceil(p.nYaw / 64), p.nCombo],
	})
		.addKernel({
			id: "reduce",
			spec: sub ? K_REDUCE_SG : K_REDUCE,
			bindings: { u, cells, red },
			workgroups: (p) => [p.nYaw],
		})
		.addKernel({
			id: "flags",
			spec: K_FLAGS,
			bindings: { u, cells, red, vals, flags },
			workgroups: () => [groupsX, groupsY],
		})
		.add(
			new GPUCompaction({
				id: "cands",
				input: g.view(vals, "uint32", capCells),
				flags: g.view(flags, "uint32", capCells),
				// list[1 ..]: the head words follow the count word the copy below fills
				output: g.view(list, "uint32", capCells, 4),
				count: g.view(count, "uint32", 1),
			}),
		)
		// list = [count, candidates…] as collect() and the head read expect
		.addCopyPass({
			id: "cands-count",
			resources: [
				{ buffer: count, usage: "copy-source" },
				{ buffer: list, usage: "copy-destination" },
			],
			compile: () => ({
				encode: ({ commandEncoder, getBuffer }) => {
					commandEncoder.copyBufferToBuffer({
						sourceBuffer: getBuffer(count),
						sourceOffset: 0,
						destinationBuffer: getBuffer(list),
						destinationOffset: 0,
						size: 4,
					});
				},
			}),
		});
	if (gpuRescore) {
		// GPU re-score (GridGpuOptions.rescore "gpu"): RESCORE → PICK over the candidate slots, then only
		// [count, bestKey, argOut] (+ debug cells) are read. bestKey / argOut are atomic transients,
		// cleared (to 0) before use; PICK keeps the max of the complemented combo, so 0 = "none".
		// score[i] is written for i < count and read only there (PICK): it needs no clear.
		const slots = Math.max(capCells, (bufs.list.byteLength >> 2) - 1);
		const score = g.transientBuffer("score", slots * 4);
		const bestKey = g.transientBuffer("bestKey", redBytes / 4);
		const argOut = g.transientBuffer("argOut", redBytes / 4);
		const nSlotGroups = Math.ceil(slots / 256);
		const slotX = Math.min(nSlotGroups, maxDim);
		const slotY = Math.ceil(nSlotGroups / slotX);
		g.clearNode("clear-best", { buffer: bestKey, size: (p) => p.nYaw * 4 })
			.clearNode("clear-arg", { buffer: argOut, size: (p) => p.nYaw * 4 })
			.addKernel({
				id: "rescore",
				spec: K_RESCORE,
				bindings: { u, S, prof, alpha, vfs, combos, list, score, bestKey },
				workgroups: () => [slotX, slotY],
				writes: { bestKey: "atomic" },
				cleared: ["bestKey"],
				dependsOn: ["cands-count", "clear-best"],
			})
			.addKernel({
				id: "pick",
				spec: K_PICK,
				bindings: { u, list, score, bestKey, argOut },
				workgroups: () => [slotX, slotY],
				writes: { argOut: "atomic" },
				cleared: ["argOut"],
				dependsOn: ["rescore", "clear-arg"],
			})
			.readNode("read", [
				{ buffer: list, size: () => 4 },
				{ buffer: bestKey, size: (p) => p.nYaw * 4 },
				{ buffer: argOut, size: (p) => p.nYaw * 4 },
				{ buffer: cells, size: (p) => p.debug * 16 },
			]);
		return;
	}
	// count + the first `head` slots, the reduction, (debug) the whole grid; one staging slot
	g.readNode("read", [
		{ buffer: list, size: (p) => (p.head + 1) * 4 },
		{ buffer: red, size: (p) => p.nYaw * 16 },
		{ buffer: cells, size: (p) => p.debug * 16 },
	]);
}

/** Last-run info for benches (cache key / hit, the compiled graph's stats). */
export let lastSkyGlobalGraphRun:
	| { key: string; hit: boolean; stats: GraphStats }
	| undefined;

/** Destroy this device's cached skyglobal graphs (each after its runs). */
export function releaseSkyGlobalGraphs(device: Device): Promise<void> {
	return releaseCachedGraphs(device, SKYGLOBAL_GRAPH_GROUP);
}

/** gridGpu's GPU phase: upload, CELLS → REDUCE → FLAGS → compaction, the count-first readback. Call under the "skyglobal" lease. */
export async function gridOnGraph(
	device: Device,
	sg: SkyGlobal,
	g: GridPlan,
	o: GridGpuOptions,
	P: Packed,
): Promise<GpuOut> {
	const t0 = performance.now();
	const nYaw = g.nYaw;
	const nCombo = g.combos.length;
	const nCells = nYaw * nCombo;
	const { cap } = P;
	const head = headFor(device, o, cap);
	const gpuRescore = o.rescore === "gpu";
	const sub = !o.noSubgroups && hasFeature(device, "subgroups");
	// pooled uploads under the "skyglobal" lease
	const bufs: Inputs = {
		u: pooledUniform(device, key("u"), P.ub),
		S: pooledStorage(device, key("S"), sg.Sc),
		prof: pooledStorage(device, key("prof"), P.prof),
		alpha: pooledStorage(device, key("alpha"), P.alpha),
		vfs: pooledStorage(device, key("vfs"), P.vfs),
		combos: pooledStorage(device, key("combos"), P.combos),
		// the compaction's output must hold as many words as its input (capCells), the count word is extra
		list: acquire(
			device,
			key("list"),
			(Math.max(cap, capacityFor(nCells * 16) / 16) + 1) * 4,
			STORAGE,
		),
	};
	const cellsBytes = capacityFor(nCells * 16);
	const redBytes = capacityFor(nYaw * 16);
	const k = `${sub ? "sg" : "tree"},${INPUTS.map((i) => `${i}${bufs[i].byteLength}`).join(",")},cells${cellsBytes},red${redBytes},rs${gpuRescore ? 1 : 0}`;
	// cachedGraph inside the "skyglobal" lease, run() queued synchronously after it (no await between),
	// so an eviction's destroy lands after this run
	const { graph, hit } = cachedGraph<Params, void>(
		device,
		SKYGLOBAL_GRAPH_GROUP,
		k,
		(gr) => build(gr, bufs, sub, cellsBytes, redBytes, gpuRescore),
		MAX_GRAPHS,
	);
	graph.compile();
	lastSkyGlobalGraphRun = {
		key: k,
		hit: !!hit,
		stats: graph.stats as GraphStats,
	};
	const debug = o.debugGrid ? nCells : 0;
	const t1 = performance.now();
	const { reads } = await graph.run(
		{ nYaw, nCombo, head, debug, cap },
		{ buffers: bufs },
	);
	const [lb, rb, cb] = reads.read ?? [];
	if (!lb || !rb) throw new Error("skyglobal graph: read node did not run");
	if (gpuRescore) {
		const [cb0, kb, ab, dbgCells] = reads.read ?? [];
		if (!cb0 || !kb || !ab)
			throw new Error("skyglobal graph: read node did not run");
		const count = new Uint32Array(cb0, 0, 1)[0];
		return decodeGpuRescore(
			{
				count,
				key: new Uint32Array(kb, 0, nYaw),
				arg: new Uint32Array(ab, 0, nYaw),
			},
			{
				nCells,
				readBytes: 4 + nYaw * 8 + debug * 16,
				sub,
				t0,
				t1,
			},
			o.debugGrid ? dbgCells : undefined,
		);
	}
	return collect(
		device,
		{
			list: bufs.list,
			head,
			cap,
			nCells,
			readBytes: (head + 1) * 4 + nYaw * 16 + debug * 16,
			sub,
			t0,
			t1,
		},
		o,
		lb,
		rb,
		o.debugGrid ? cb : undefined,
	);
}
