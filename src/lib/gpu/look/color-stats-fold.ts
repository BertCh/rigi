// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The band-stats fold ON the graph (WAG-4, the plan's named GPUProgram candidate): the GROUPS × 52
// per-workgroup partials are folded on the GPU and finalized there, and only the ColorStats (256 B)
// comes back, instead of the 6.6 KB of partials folded on the CPU in float64.
//
//   GPUProgram "look-stats-fold"
//     producer   GraphOperation: the caller's nodes (BAND_STATS / BAND_STATS_SG, plus the texture
//                gather on the texture path) writing `partial`, a compiler-owned program vector
//     fold       GPUProgramSpMV: folded = S · partial, S the 52 × (GROUPS·52) 0/1 matrix that sums
//                value j over the workgroups (CSR, per-device constant buffers); luma picks the
//                strategy (subgroup-row where the device has subgroup_id, else workgroup-row)
//     finalize   GraphOperation: BAND_FINALIZE (finalizeBands in f32) → `stats` (STATS_WORDS f32)
//
// lowered by core/program.ts compileProgramGraph onto one ComputeGraph. f32 instead of the f64 fold:
// the per-workgroup partials were already f32 sums, so the fold adds ≤ 32 more f32 roundings per value
// (look-bench / scripts/gpu/stats-fold-bench.mjs measure the ColorStats and composite deltas).
//
// The CPU f64 fold stays: the `fold: "f64"` option, and the fallback when this graph fails.
import { Buffer, type Device } from "@luma.gl/core";
import {
	type ColorStats,
	identityStats,
	N_BANDS,
} from "../../look/color-stats";
import type { ComputeGraph, GraphBinding } from "../core/graph";
import {
	GPUData,
	GPUProgram,
	type GPUProgramCompilation,
	GPUProgramCSRMatrix,
	GPUProgramSpMV,
} from "../core/luma";
import { compileProgramGraph, GraphOperation } from "../core/program";
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

/**
 * The fold's 52 × (groups·52) CSR selection matrix: row j sums value j of workgroup 0, 1, … (the CPU
 * fold's order; partial index = workgroup · 52 + value), every nonzero 1.
 */
export function foldSelectionCsr(groups: number) {
	const nnz = STATS_VALUES * groups;
	return {
		rows: Uint32Array.from({ length: STATS_VALUES + 1 }, (_, j) => j * groups),
		cols: Uint32Array.from(
			{ length: nnz },
			(_, i) => (i % groups) * STATS_VALUES + Math.floor(i / groups),
		),
		vals: new Float32Array(nnz).fill(1),
	};
}

/** The CSR selection matrix's constant buffers, per device and group count. */
const csrBuffers = new WeakMap<Device, Map<number, Buffer[]>>();
function foldMatrix(device: Device, groups: number) {
	let m = csrBuffers.get(device);
	if (!m) {
		m = new Map();
		csrBuffers.set(device, m);
	}
	let bufs = m.get(groups);
	if (!bufs || bufs.some((b) => b.destroyed)) {
		const csr = foldSelectionCsr(groups);
		const make = (id: string, data: Uint32Array | Float32Array) =>
			device.createBuffer({
				id: `look-stats-fold-${id}`,
				usage: Buffer.STORAGE | Buffer.COPY_DST,
				data,
			});
		bufs = [
			make("rows", csr.rows),
			make("cols", csr.cols),
			make("vals", csr.vals),
		];
		m.set(groups, bufs);
	}
	const [rows, cols, vals] = bufs;
	return {
		rows: new GPUData({
			buffer: rows,
			format: "uint32",
			length: STATS_VALUES + 1,
		}),
		cols: new GPUData({
			buffer: cols,
			format: "uint32",
			length: STATS_VALUES * groups,
		}),
		vals: new GPUData({
			buffer: vals,
			format: "float32",
			length: STATS_VALUES * groups,
		}),
	};
}

/**
 * Build the fold program and lower it onto one ComputeGraph (`id`). On that graph, `params(g)` makes
 * the stats uniform (BAND_STATS' words + minCount; the finalize node reads minCount from it),
 * `produce(g, partial, prm)` adds the nodes that write all GROUPS × 52 partials into `partial`, and
 * `output(g)` makes the buffer the finalize node writes (`stats`: a transient to read back with a read
 * node added after this returns, or an import).
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
): {
	graph: ComputeGraph<P>;
	compilation: GPUProgramCompilation<P>;
	stats: GraphBinding;
} {
	const program = new GPUProgram({ id });
	const n = groups * STATS_VALUES;
	const partial = program.vector("partial", "float32", n);
	const folded = program.vector("folded", "float32", STATS_VALUES);
	const rowOffsets = program.vector("fold-rows", "uint32", STATS_VALUES + 1, {
		external: true,
	});
	const columnIndices = program.vector("fold-cols", "uint32", n, {
		external: true,
	});
	const values = program.vector("fold-vals", "float32", n, {
		external: true,
	});
	let prm: GraphBinding | null = null;
	let stats: GraphBinding | null = null;
	program.add(
		new GraphOperation<P>(
			"producer",
			(g, ctx) => {
				prm = o.params(g);
				o.produce(g, ctx.resolveVector(partial).data[0], prm);
			},
			{ outputs: [{ name: "partial", format: "float32", shape: [n] }] },
		),
	);
	program.add(
		new GPUProgramSpMV({
			id: "fold",
			matrix: new GPUProgramCSRMatrix({
				id: "fold-select",
				rows: STATS_VALUES,
				columns: n,
				rowOffsets,
				columnIndices,
				values,
				statistics: { maxNonZerosPerRow: groups, shortRowFraction: 0 },
			}),
			vector: partial,
			output: folded,
		}),
	);
	program.add(
		new GraphOperation<P>(
			"finalize",
			(g, ctx) => {
				stats = o.output(g);
				g.addKernel({
					id: "band-finalize",
					spec: K_BAND_FINALIZE,
					bindings: {
						prm: prm as GraphBinding,
						folded: ctx.resolveVector(folded).data[0],
						outv: stats,
					},
					workgroups: [1],
				});
			},
			{
				inputs: [{ name: "folded", format: "float32", shape: [STATS_VALUES] }],
				outputs: [{ name: "stats", format: "float32", shape: [STATS_WORDS] }],
			},
		),
	);
	const m = foldMatrix(device, groups);
	const { graph, compilation } = compileProgramGraph<P>(device, id, program, {
		vectors: { "fold-rows": m.rows, "fold-cols": m.cols, "fold-vals": m.vals },
	});
	return { graph, compilation, stats: stats as unknown as GraphBinding };
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

/** The GPU fold applies (the option, else on; and it has not failed on this device). */
export const statsFoldOn = (device: Device, opt?: "gpu" | "f64") =>
	(opt ?? "gpu") === "gpu" && !foldFailed.has(device);

/** The fold graph threw on `device` (e.g. a lowering or pipeline error): warn once, then f64. */
export function markFoldFailed(device: Device, error: unknown) {
	if (foldFailed.has(device)) return;
	foldFailed.add(device);
	console.warn("[look-stats] GPU fold failed, using the f64 fold", error);
}
