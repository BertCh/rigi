// The band-stats dispatch (color-stats.ts bandPartials) as a core ComputeGraph node: the default of
// bandStatsGpu(…); { graph: false } runs the pooled single-dispatch path.
//
//   BAND_STATS or BAND_STATS_SG (one node, GROUPS workgroups) → partial (transient) → read node
//
// Only the dispatch moves onto the graph. The per-workgroup partials (GROUPS × 52 f32) still come back
// to the CPU and bandStatsGpu folds them in float64, in the same order, then finalizeBands: no luma
// float-sum primitive (GPUReduction / GPUSegmentedReduction would sum in f32, and GPUReduction switches
// to subgroupAdd on devices with subgroups), so the result is bit-identical to the old path.
//
// Subgroup variant: BAND_STATS_SG writes -1 partials when its subgroup-layout check fails (2af1daf);
// bandStatsGpu's hasNegativeCount check is shared and re-runs through this function with sg = false.
//
// Clear audit: `partial` is written fully (BAND_STATS: invocation 0 of each of the GROUPS workgroups
// writes its 52 values; BAND_STATS_SG: invocations 0..51 of each write one each), so "full", no clear.
//
// NaN semantics: unchanged kernel. range is sanitised on the CPU (≤ 0 or non-finite → 0 = sky) before
// upload, as in the old path; a NaN layer alpha fails `L.a > 0.98` (pixel skipped); a NaN people value
// fails `fg >= 0.3` (pixel kept); a NaN layer colour with alpha > 0.98 reaches the sums (as before).
import { Buffer, type Device } from "@luma.gl/core";
import { type ComputeGraph, cachedGraph } from "../core/graph";
import { pooledStorage, pooledUniform, withLease } from "../core/pool";
import {
	type BandStatsInput,
	GROUPS,
	K_BAND_STATS,
	K_BAND_STATS_SG,
	SRGB_LUT,
} from "./color-stats";
import { STATS_VALUES } from "./color-stats.wgsl";

const UNIFORM = Buffer.UNIFORM | Buffer.COPY_DST;
export const STATS_GRAPH_GROUP = "look-stats";
const PARTIAL_BYTES = GROUPS * STATS_VALUES * 4;

type Params = undefined;
const IMPORTS = ["photo", "layer", "range", "fg", "lut"] as const;

/** Build the one-node graph (imports sized as pooled). */
export function buildStatsGraph(
	g: ComputeGraph<Params>,
	bytes: Record<(typeof IMPORTS)[number] | "prm", number>,
	sg: boolean,
) {
	const prm = g.importBuffer("prm", bytes.prm, undefined, UNIFORM);
	const [photo, layer, range, fg, lut] = IMPORTS.map((id) =>
		g.importBuffer(id, bytes[id]),
	);
	const partial = g.transientBuffer("partial", PARTIAL_BYTES);
	g.addKernel({
		id: sg ? "band-stats-sg" : "band-stats",
		spec: sg ? K_BAND_STATS_SG : K_BAND_STATS,
		bindings: { prm, photo, layer, range, fg, lut, partial },
		workgroups: [GROUPS],
	});
	g.readNode("partial", [partial]);
}

/** Last graph run's shape-cache hit and compiled stats (bench / tests). */
export const lastStatsGraphRun: {
	hit?: boolean;
	stats?: ComputeGraph<Params>["stats"];
} = {};

/** bandPartials on the graph: the GROUPS × STATS_VALUES per-workgroup partials, same bits. */
export function bandPartialsGraph(
	device: Device,
	o: BandStatsInput,
	words: ArrayBuffer,
	R: Float32Array,
	sg: boolean,
): Promise<Float32Array> {
	return withLease("look-stats-graph", async () => {
		const up = (key: string, data: ArrayBufferView | number) =>
			pooledStorage(device, `look-stats-graph/${key}`, data);
		const buffers = {
			prm: pooledUniform(device, "look-stats-graph/prm", words),
			photo: up("photo", o.photo),
			layer: up("layer", o.layer),
			range: up("range", R),
			// 4 zero bytes when there is no people mask (hasFg = 0: never read), as the old path
			fg: up("fg", o.fg ?? 4),
			lut: up("lut", SRGB_LUT),
		};
		const bytes = Object.fromEntries(
			Object.entries(buffers).map(([k, b]) => [k, b.byteLength]),
		) as Record<keyof typeof buffers, number>;
		const key = `${sg ? "sg" : "tree"}|${Object.values(bytes).join(",")}`;
		const { graph, hit } = cachedGraph<Params, void>(
			device,
			STATS_GRAPH_GROUP,
			key,
			(g) => buildStatsGraph(g, bytes, sg),
		);
		await graph.compileAsync();
		const { reads } = await graph.run(undefined, { buffers });
		lastStatsGraphRun.hit = hit;
		lastStatsGraphRun.stats = graph.stats;
		return new Float32Array(reads.partial[0]);
	});
}
