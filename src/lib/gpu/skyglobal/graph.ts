// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The skyglobal grid's GPU phase on a core ComputeGraph: the only GPU path of gridGpu (./index.ts;
// the pooled per-pass dispatches it replaced, bit for bit, were removed on 2026-10-01). The CPU twin
// is ./cpu.ts.
//
// One encoding per grid, one submit, one read slot:
//   clear list[0] → CELLS → REDUCE (subgroup or tree) → CANDS → read [list head, red, (debug) cells]
// The three kernel specs of ./kernels.ts.
//
// Buffers:
// - `cells` (nCells × 16 B, ~24 MB) and `red` (nYaw × 16 B) are graph TRANSIENTS sized to
//   power-of-two capacities (so photos of similar size share a graph), aliased by the graph by
//   lifetime. Neither is read back mid-chain: red rides the final read (the CPU uses its
//   per-yaw mid argmax for stats.midArgFlips), cells only when debugGrid asks (a 0-byte range
//   otherwise, which stages no copy).
// - the inputs (u, S, prof, alpha, vfs, combos) are imports: pooled uploads under the "skyglobal"
//   lease, bound per run.
// - the candidate `list` is an IMPORT (the pooled "skyglobal/list" slot), not a transient: a list
//   longer than the head read needs a second, exact-length read of its tail AFTER the encoding
//   resolved its count, and a graph transient cannot be read outside its encoding. Kept pooled (and
//   under the lease until that tail read), it keeps the count-first readback.
//
// Clear audit (transients are never zeroed and alias other transients' bytes): CELLS writes every
// cells[ci · nYaw + iy] in range (its only return is the range guard) and REDUCE writes red[iy] for
// every yaw workgroup, and the reads cover only those ranges, so both are "full" writes and need no
// clear. CANDS appends with atomicAdd on list[0]: the count word is cleared by a clearNode ordered
// before CANDS (list is an import, so core's lint does not require it; it is the house rule anyway).
//
// Determinism: REDUCE's red[] is order-independent (see skyglobal.wgsl.ts). The list's ORDER is
// atomicAdd order (not deterministic run to run); its set, the count, red, cells and so the re-scored
// {best, arg} are. CANDS stays a custom append rather than luma's GPUCompaction: a stable compaction
// would scan all ~1.5M cells to keep ~800, and the CPU re-score sorts per yaw anyway.
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
	headFor,
	K_CANDS,
	K_CELLS,
	K_REDUCE,
	K_REDUCE_SG,
	key,
	OWNER,
	STORAGE,
} from "./kernels";

/** cachedGraph group of the skyglobal graphs (also the lease / pool prefix). */
export const SKYGLOBAL_GRAPH_GROUP = OWNER;
/** Compiled graphs kept per device (each holds a cells transient of up to ~32 MB). */
const MAX_GRAPHS = 2;

type Params = { nYaw: number; nCombo: number; head: number; debug: number };
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
	g.clearNode("clear-count", { buffer: list, size: 4 })
		.addKernel({
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
			id: "cands",
			spec: K_CANDS,
			bindings: { u, cells, red, list },
			workgroups: (p) => [Math.ceil(p.nYaw / 64), p.nCombo],
			writes: { list: "atomic" },
		})
		// count + the first `head` slots, the reduction, (debug) the whole grid; one staging slot
		.readNode("read", [
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

/** gridGpu's GPU phase: upload, CELLS → REDUCE → CANDS, the count-first readback. Call under the "skyglobal" lease. */
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
	const sub = !o.noSubgroups && hasFeature(device, "subgroups");
	// pooled uploads under the "skyglobal" lease
	const bufs: Inputs = {
		u: pooledUniform(device, key("u"), P.ub),
		S: pooledStorage(device, key("S"), sg.Sc),
		prof: pooledStorage(device, key("prof"), P.prof),
		alpha: pooledStorage(device, key("alpha"), P.alpha),
		vfs: pooledStorage(device, key("vfs"), P.vfs),
		combos: pooledStorage(device, key("combos"), P.combos),
		list: acquire(device, key("list"), (cap + 1) * 4, STORAGE),
	};
	const cellsBytes = capacityFor(nCells * 16);
	const redBytes = capacityFor(nYaw * 16);
	const k = `${sub ? "sg" : "tree"},${INPUTS.map((i) => `${i}${bufs[i].byteLength}`).join(",")},cells${cellsBytes},red${redBytes}`;
	// cachedGraph inside the "skyglobal" lease, run() queued synchronously after it (no await between),
	// so an eviction's destroy lands after this run
	const { graph, hit } = cachedGraph<Params, void>(
		device,
		SKYGLOBAL_GRAPH_GROUP,
		k,
		(gr) => build(gr, bufs, sub, cellsBytes, redBytes),
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
		{ nYaw, nCombo, head, debug },
		{ buffers: bufs },
	);
	const [lb, rb, cb] = reads.read ?? [];
	if (!lb || !rb) throw new Error("skyglobal graph: read node did not run");
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
