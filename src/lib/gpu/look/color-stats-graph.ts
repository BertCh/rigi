// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The band-stats dispatch of color-stats.ts bandStatsGpu as core ComputeGraphs: its only GPU path (the
// pooled single dispatch it replaced, bit for bit, was removed on 2026-10-01). Two graphs:
//
//   default (fold "gpu"): a GPUProgram lowered onto one ComputeGraph (color-stats-fold.ts)
//     BAND_STATS(_SG) → partial (program vector) → GPUProgramSpMV fold → BAND_FINALIZE → stats → read node
//     only the ColorStats (STATS_WORDS f32, 256 B) comes back; the fold and finalizeBands run in f32.
//   fold "f64": BAND_STATS(_SG) (one node, GROUPS workgroups) → partial (transient) → read node
//     the per-workgroup partials (GROUPS × 52 f32) come back and bandStatsGpu folds them in float64, in
//     the same order, then finalizeBands.
//
// Subgroup variant: BAND_STATS_SG writes -1e20 partials when its subgroup-layout check fails (2af1daf);
// the f64 path's hasNegativeCount check and the folded path's valid = -1 re-run through this module
// with sg = false.
//
// Clear audit: `partial` is written fully (BAND_STATS: invocation 0 of each of the GROUPS workgroups
// writes its 52 values; BAND_STATS_SG: invocations 0..51 of each write one each), so "full", no clear;
// the SpMV writes every folded row ("=" on its first and only nonzero span) and BAND_FINALIZE all
// STATS_WORDS words.
//
// NaN semantics: range is sanitised on the CPU (≤ 0 or non-finite → 0 = sky) before upload; a NaN layer alpha fails `L.a > 0.98` (pixel skipped); a NaN people value
// fails `fg >= 0.3` (pixel kept); a NaN layer colour with alpha > 0.98 reaches the sums (as before).
import { Buffer, type Device } from "@luma.gl/core";
import {
	type ComputeGraph,
	cachedGraph,
	cachedGraphFrom,
	type GraphBinding,
} from "../core/graph";
import type { GPUProgramLoweringReport } from "../core/luma";
import { pooledStorage, pooledUniform, withLease } from "../core/pool";
import {
	type BandStatsInput,
	GROUPS,
	K_BAND_STATS,
	K_BAND_STATS_SG,
	SRGB_LUT,
} from "./color-stats";
import { STATS_VALUES } from "./color-stats.wgsl";
import { buildFoldGraph, STATS_BYTES } from "./color-stats-fold";

const UNIFORM = Buffer.UNIFORM | Buffer.COPY_DST;
export const STATS_GRAPH_GROUP = "look-stats";
const PARTIAL_BYTES = GROUPS * STATS_VALUES * 4;

type Params = undefined;
const IMPORTS = ["photo", "layer", "range", "fg", "lut"] as const;

/** The band-stats node on `g`, writing `partial` (imports sized as pooled). */
function addStatsNode(
	g: ComputeGraph<Params>,
	bytes: Record<(typeof IMPORTS)[number], number>,
	prm: GraphBinding,
	partial: GraphBinding,
	sg: boolean,
) {
	const [photo, layer, range, fg, lut] = IMPORTS.map((id) =>
		g.importBuffer(id, bytes[id]),
	);
	g.addKernel({
		id: sg ? "band-stats-sg" : "band-stats",
		spec: sg ? K_BAND_STATS_SG : K_BAND_STATS,
		bindings: { prm, photo, layer, range, fg, lut, partial },
		workgroups: [GROUPS],
	});
}

/** Build the one-node graph (imports sized as pooled): the partials, read back (fold "f64"). */
export function buildStatsGraph(
	g: ComputeGraph<Params>,
	bytes: Record<(typeof IMPORTS)[number] | "prm", number>,
	sg: boolean,
): undefined {
	const prm = g.importBuffer("prm", bytes.prm, undefined, UNIFORM);
	const partial = g.transientBuffer("partial", PARTIAL_BYTES);
	addStatsNode(g, bytes, prm, partial, sg);
	g.readNode("partial", [partial]);
	return undefined;
}

/** The fold graph (GPUProgram, color-stats-fold.ts): the folded ColorStats words, read back. */
export function buildFoldedStatsGraph(
	device: Device,
	id: string,
	bytes: Record<(typeof IMPORTS)[number] | "prm", number>,
	sg: boolean,
) {
	const { graph, compilation, stats } = buildFoldGraph<Params>(
		device,
		id,
		GROUPS,
		{
			params: (g) => g.importBuffer("prm", bytes.prm, undefined, UNIFORM),
			produce: (g, partial, prm) => addStatsNode(g, bytes, prm, partial, sg),
			output: (g) => g.transientBuffer("stats", STATS_BYTES),
		},
	);
	// after the finalize node (a read node added inside the program would be scheduled before it)
	graph.readNode("stats", [stats]);
	return { graph, extra: compilation.lowering };
}

/** Last graph run's shape-cache hit, compiled stats and (folded graph) lowering report (bench / tests). */
export const lastStatsGraphRun: {
	hit?: boolean;
	stats?: ComputeGraph<Params>["stats"];
	lowering?: GPUProgramLoweringReport;
} = {};

/** One BAND_STATS(_SG) run: the GROUPS × STATS_VALUES per-workgroup partials (fold "f64"). */
export async function bandPartialsGraph(
	device: Device,
	o: BandStatsInput,
	words: ArrayBuffer,
	R: Float32Array,
	sg: boolean,
): Promise<Float32Array> {
	return new Float32Array(await runStats(device, o, words, R, sg, false));
}

/** One fold-graph run: the folded ColorStats words (STATS_WORDS f32; color-stats-fold.ts). */
export function bandFoldedGraph(
	device: Device,
	o: BandStatsInput,
	words: ArrayBuffer,
	R: Float32Array,
	sg: boolean,
): Promise<ArrayBuffer> {
	return runStats(device, o, words, R, sg, true);
}

function runStats(
	device: Device,
	o: BandStatsInput,
	words: ArrayBuffer,
	R: Float32Array,
	sg: boolean,
	fold: boolean,
): Promise<ArrayBuffer> {
	return withLease("look-stats-graph", async () => {
		const up = (key: string, data: ArrayBufferView | number) =>
			pooledStorage(device, `look-stats-graph/${key}`, data);
		const buffers = {
			prm: pooledUniform(device, "look-stats-graph/prm", words),
			photo: up("photo", o.photo),
			layer: up("layer", o.layer),
			range: up("range", R),
			// 4 zero bytes when there is no people mask (hasFg = 0: never read)
			fg: up("fg", o.fg ?? 4),
			lut: up("lut", SRGB_LUT),
		};
		const bytes = Object.fromEntries(
			Object.entries(buffers).map(([k, b]) => [k, b.byteLength]),
		) as Record<keyof typeof buffers, number>;
		const key = `${fold ? "fold" : "f64"}|${sg ? "sg" : "tree"}|${Object.values(bytes).join(",")}`;
		const { graph, hit, extra } = fold
			? cachedGraphFrom<Params, GPUProgramLoweringReport | undefined>(
					device,
					STATS_GRAPH_GROUP,
					key,
					(id) => buildFoldedStatsGraph(device, id, bytes, sg),
				)
			: cachedGraph<Params, GPUProgramLoweringReport | undefined>(
					device,
					STATS_GRAPH_GROUP,
					key,
					(g) => buildStatsGraph(g, bytes, sg),
				);
		await graph.compileAsync();
		const { reads } = await graph.run(undefined, { buffers });
		lastStatsGraphRun.hit = hit;
		lastStatsGraphRun.stats = graph.stats;
		lastStatsGraphRun.lowering = extra;
		return fold ? reads.stats[0] : reads.partial[0];
	});
}
