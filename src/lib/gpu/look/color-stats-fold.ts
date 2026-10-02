// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The band-stats fold ON the graph (WAG-4, then the maximalist luma adoption of 2026-10-02): the
// GROUPS x 52 per-workgroup partials are folded on the GPU and finalized there, and only the
// ColorStats (256 B) comes back, instead of the 6.6 KB of partials folded on the CPU in float64.
//
//   ComputeGraph
//     producer   the caller's nodes (BAND_STATS / BAND_STATS_SG, plus the texture gather on the
//                texture path) writing `partial` (GROUPS x 52 f32)
//     fold       luma GPUGroupAggregation "sum": key of partial[i] = i % 52 (a constant per-device
//                u32 buffer), 52 output groups, so group j is the sum of value j over the workgroups
//     finalize   BAND_FINALIZE (finalizeBands in f32) -> `stats` (STATS_WORDS f32)
//
// It replaced a GPUProgram (GPUProgramSpMV with a 0/1 CSR selection matrix) lowered by
// core/program.ts; the aggregation is one op, no matrix buffers. The float sums are compare-exchange
// atomics, so the order of the <= 32 adds per value varies run to run (before: a fixed tree): the
// ColorStats deltas are tolerance-checked (color-stats-fold.check.ts, scripts/gpu/stats-fold-dawn.ts).
// f32 instead of the f64 fold: the per-workgroup partials were already f32 sums, so the fold adds <= 32
// more f32 roundings per value.
//
// The CPU f64 fold stays: the `fold: "f64"` option, and the fallback when this graph fails.
import { Buffer, type Device } from "@luma.gl/core";
import {
	type ColorStats,
	identityStats,
	N_BANDS,
} from "../../look/color-stats";
import { ComputeGraph, type GraphBinding } from "../core/graph";
import { GPUGroupAggregation } from "../core/luma";
import { STATS_VALUES } from "./color-stats.wgsl";
import {
	BAND_FINALIZE,
	STATS_LAYOUT,
	STATS_WORDS,
} from "./color-stats-fold.wgsl";
import { defineKernel } from "./kernel";

export { STATS_WORDS };
export const STATS_BYTES = STATS_WORDS * 4;

export const K_BAND_FINALIZE = defineKernel("band-finalize", BAND_FINALIZE, [
	["prm", "uniform"],
	["folded", "read-only-storage"],
	["outv", "storage"],
]);

/** The fold's group keys: partial index = workgroup * 52 + value, so value j of every workgroup is group j. */
export function foldGroupKeys(groups: number) {
	return Uint32Array.from(
		{ length: STATS_VALUES * groups },
		(_, i) => i % STATS_VALUES,
	);
}

/** The group-key buffer, per device and group count. */
const keyBuffers = new WeakMap<Device, Map<number, Buffer>>();
function foldKeys(device: Device, groups: number) {
	let m = keyBuffers.get(device);
	if (!m) {
		m = new Map();
		keyBuffers.set(device, m);
	}
	let buffer = m.get(groups);
	if (!buffer || buffer.destroyed) {
		buffer = device.createBuffer({
			id: `look-stats-fold-keys-${groups}`,
			usage: Buffer.STORAGE | Buffer.COPY_DST,
			data: foldGroupKeys(groups),
		});
		m.set(groups, buffer);
	}
	return buffer;
}

/**
 * Build the fold graph (`id`). `params(g)` makes the stats uniform (BAND_STATS' words + minCount; the
 * finalize node reads minCount from it), `produce(g, partial, prm)` adds the nodes that write all
 * GROUPS x 52 partials into `partial`, and `output(g)` makes the buffer the finalize node writes
 * (`stats`: a transient to read back with a read node added after this returns, or an import).
 */
export function buildFoldGraph<P = void>(
	device: Device,
	id: string,
	groups: number,
	o: {
		produce: (
			g: ComputeGraph<P>,
			partial: GraphBinding,
			prm: GraphBinding,
		) => void;
		params: (g: ComputeGraph<P>) => GraphBinding;
		output: (g: ComputeGraph<P>) => GraphBinding;
	},
): { graph: ComputeGraph<P>; stats: GraphBinding } {
	const g = new ComputeGraph<P>(device, id);
	const n = groups * STATS_VALUES;
	const prm = o.params(g);
	const partial = g.transientBuffer("partial", n * 4);
	o.produce(g, partial, prm);
	const keys = g.importBuffer(
		"fold-keys",
		n * 4,
		foldKeys(device, groups),
		Buffer.STORAGE | Buffer.COPY_DST,
	);
	const folded = g.transientBuffer("folded", STATS_VALUES * 4);
	g.add(
		new GPUGroupAggregation({
			id: "fold",
			keys: g.view(keys, "uint32", n),
			values: g.view(partial, "float32", n),
			output: g.view(folded, "float32", STATS_VALUES),
			operation: "sum",
		}),
	);
	const stats = o.output(g);
	g.addKernel({
		id: "band-finalize",
		spec: K_BAND_FINALIZE,
		bindings: { prm, folded, outv: stats },
		workgroups: [1],
	});
	return { graph: g, stats };
}

/** The folded words as ColorStats (identityStats' means / stds when not valid). */
export function statsFromWords(data: ArrayBuffer): ColorStats {
	const w = new Float32Array(data, 0, STATS_WORDS);
	const s = identityStats();
	for (let k = 0; k < N_BANDS; k++)
		s.count[k] = Math.round(w[STATS_LAYOUT.count + k]);
	s.valid = w[STATS_LAYOUT.valid] === 1;
	if (!s.valid) return s;
	const n = N_BANDS * 3;
	s.photoMean.set(
		w.subarray(STATS_LAYOUT.photoMean, STATS_LAYOUT.photoMean + n),
	);
	s.photoStd.set(w.subarray(STATS_LAYOUT.photoStd, STATS_LAYOUT.photoStd + n));
	s.layerMean.set(
		w.subarray(STATS_LAYOUT.layerMean, STATS_LAYOUT.layerMean + n),
	);
	s.layerStd.set(w.subarray(STATS_LAYOUT.layerStd, STATS_LAYOUT.layerStd + n));
	return s;
}

/** BAND_STATS_SG's layout check failed (the caller re-runs without subgroups). */
export const subgroupLayoutFailed = (data: ArrayBuffer) =>
	new Float32Array(data, 0, STATS_WORDS)[STATS_LAYOUT.valid] === -1;

/** Devices on which building or running the fold graph threw: the f64 fold from then on. */
const foldFailed = new WeakSet<Device>();

/** The GPU fold applies (the option, else off; and it has not failed on this device). */
export const statsFoldOn = (device: Device, opt?: "gpu" | "f64") =>
	(opt ?? "gpu") === "gpu" && !foldFailed.has(device);

/** The fold graph threw on `device` (e.g. a lowering or pipeline error): warn once, then f64. */
export function markFoldFailed(device: Device, error: unknown) {
	if (foldFailed.has(device)) return;
	foldFailed.add(device);
	console.warn("[look-stats] GPU fold failed, using the f64 fold", error);
}
