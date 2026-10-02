// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The GPU guided filter (guided-filter.ts guidedFiltersGpu) on a core ComputeGraph: its only GPU path.
//
// Per job k (shared guide I), see addGuidedFilter:
//   GF_PREP (I, p, I², I·p as a 4-plane stack, r zero gap rows per plane) → GPUConvolution H (2r+1 × 1)
//   → GPUConvolution V (1 × 2r+1) → GF_SOLVE (sums / analytic in-range count, a and b as a 2-plane
//   stack) → GPUConvolution H → V → GF_FINISH (sums / count, q = clamp(ā·I + b̄, 0, 1));
// then one read node (all q). The convolutions are all-ones, zero-boundary, direct: with the division
// by the analytic count that is the CPU's clamped-window mean in exact arithmetic, so q is within f32
// tolerance of look/guided-filter.ts (~1e-5), not bit-identical (guided-filter-conv-dawn.ts). The
// radius shapes the stacks and kernels, so it keys the cached graph; eps is a uniform.
//
// Job k+1's PREP depends on job k's FINISH (without it the scheduler interleaves the jobs, which keeps
// every job's stacks alive at once). Each job's stacks are their OWN logical transients: the graph
// aliases them by lifetime. The q planes are transients too, read by one read node (one readback
// slot).
//
// Clear audit: PREP and SOLVE write every element of their stacks (gap rows get zeros), each
// GPUConvolution writes all width·height elements of its output, FINISH writes every i < w·h once, and
// none uses atomics, so all outputs are "full" and no clear node is needed; the core lint would
// refuse a partial / atomic transient without one.
//
// NaN semantics: a NaN in I or p spreads through the box sums to every window that contains it (two
// passes of the means, so up to 2r + 1 px away in each axis); clamp(NaN, 0, 1) is implementation-
// defined in WGSL. The Dawn gate checks that pixels farther away are unaffected.
import { Buffer, type Device } from "@luma.gl/core";
import { addBoxSum } from "../core/box-sum";
import { type ComputeGraph, cachedGraph } from "../core/graph";
import type { KernelSpec } from "../core/kernel";
import type { GraphBufferHandle } from "../core/luma";
import { pooledStorage, pooledUniform, withLease } from "../core/pool";
import {
	type GuidedJob,
	K_GF_FINISH,
	K_GF_PREP,
	K_GF_SOLVE,
} from "./guided-filter";
import { GUIDED_PARAMS } from "./uniform-blocks";

const WG = 256;
const UNIFORM = Buffer.UNIFORM | Buffer.COPY_DST;
export const GUIDED_GRAPH_GROUP = "look-guided";

type Params = undefined;

/** Planes of the (I, p, I², I·p) stack and of the (a, b) stack. */
const SUM_PLANES = 4;
const AB_PLANES = 2;

/** Elements of the all-ones kernel a radius-`r` filter needs (the 1-D window). */
export const guidedOnesLength = (r: number) => 2 * r + 1;

/** The three kernels of one guided filter (the look-tex pass keeps its own specs / warm group). */
export type GuidedKernels = {
	prep: KernelSpec;
	solve: KernelSpec;
	finish: KernelSpec;
};
export const GUIDED_KERNELS: GuidedKernels = {
	prep: K_GF_PREP,
	solve: K_GF_SOLVE,
	finish: K_GF_FINISH,
};

/**
 * Add one guided filter (guide `gI`, mask `p`, w × h, radius `r`; `prm` = GUIDED_PARAMS, `ones` = at
 * least guidedOnesLength(r) ones) to `g`, writing q into `q` (n floats). Returns the id of its last
 * node, so a caller can chain the next job after it.
 */
export function addGuidedFilter(
	g: ComputeGraph<never>,
	o: {
		id: string;
		w: number;
		h: number;
		r: number;
		kernels: GuidedKernels;
		prm: GraphBufferHandle;
		ones: GraphBufferHandle;
		gI: GraphBufferHandle;
		p: GraphBufferHandle;
		q: GraphBufferHandle;
		dependsOn?: string[];
	},
): string {
	const { id, w, h, r, kernels } = o;
	const plane = (h + r) * w;
	const sumCount = SUM_PLANES * plane;
	const abCount = AB_PLANES * plane;
	const s1 = g.transientBuffer(`${id}-s1`, sumCount * 4);
	const s2 = g.transientBuffer(`${id}-s2`, sumCount * 4);
	const s3 = g.transientBuffer(`${id}-s3`, sumCount * 4);
	const a1 = g.transientBuffer(`${id}-a1`, abCount * 4);
	const a2 = g.transientBuffer(`${id}-a2`, abCount * 4);
	const a3 = g.transientBuffer(`${id}-a3`, abCount * 4);
	const k = guidedOnesLength(r);
	const box = (
		name: string,
		input: GraphBufferHandle,
		output: GraphBufferHandle,
		count: number,
		planes: number,
		horizontal: boolean,
	) =>
		addBoxSum(g, {
			id: `${id}-${name}`,
			width: w,
			height: planes * (h + r),
			kernelWidth: horizontal ? k : 1,
			kernelHeight: horizontal ? 1 : k,
			input,
			output,
			count,
			ones: o.ones,
		});
	g.addKernel({
		id: `${id}-prep`,
		spec: kernels.prep,
		bindings: { prm: o.prm, gI: o.gI, gp: o.p, s1 },
		workgroups: [Math.ceil(sumCount / WG)],
		dependsOn: o.dependsOn,
	});
	box("sum-h", s1, s2, sumCount, SUM_PLANES, true);
	box("sum-v", s2, s3, sumCount, SUM_PLANES, false);
	g.addKernel({
		id: `${id}-solve`,
		spec: kernels.solve,
		bindings: { prm: o.prm, s3, ab: a1 },
		workgroups: [Math.ceil(plane / WG)],
	});
	box("ab-h", a1, a2, abCount, AB_PLANES, true);
	box("ab-v", a2, a3, abCount, AB_PLANES, false);
	g.addKernel({
		id: `${id}-finish`,
		spec: kernels.finish,
		bindings: { prm: o.prm, ab3: a3, gI: o.gI, q: o.q },
		workgroups: [Math.ceil((w * h) / WG)],
	});
	return `${id}-finish`;
}

/** Build the graph for `jobs` jobs over w × h texels (import byte lengths as pooled). */
export function buildGuidedGraph(
	g: ComputeGraph<Params>,
	w: number,
	h: number,
	radii: number[],
	iBytes: number,
	pBytes: number[],
	prmBytes: number,
) {
	const n = w * h;
	const gI = g.importBuffer("I", iBytes);
	let previous: string | undefined;
	const qs = pBytes.map((pb, k) => {
		const prm = g.importBuffer(`prm${k}`, prmBytes, undefined, UNIFORM);
		const gp = g.importBuffer(`p${k}`, pb);
		const ones = g.importBuffer(`ones${k}`, guidedOnesLength(radii[k]) * 4);
		const q = g.transientBuffer(`q${k}`, n * 4);
		previous = addGuidedFilter(g, {
			id: `gf${k}`,
			w,
			h,
			r: radii[k],
			kernels: GUIDED_KERNELS,
			prm,
			ones,
			gI,
			p: gp,
			q,
			dependsOn: previous ? [previous] : undefined,
		});
		return q;
	});
	g.readNode("q", qs);
}

/** Last graph run's shape-cache hit and compiled stats (bench / tests). */
export const lastGuidedGraphRun: {
	hit?: boolean;
	stats?: ComputeGraph<Params>["stats"];
} = {};

/** guidedFiltersGpu's body: the q planes of every job. */
export function guidedFiltersGraph(
	device: Device,
	I: Float32Array,
	w: number,
	h: number,
	jobs: readonly GuidedJob[],
): Promise<Float32Array[]> {
	if (!jobs.length) return Promise.resolve([]);
	return withLease("look-guided-graph", async () => {
		const gI = pooledStorage(device, "look-guided-graph/I", I);
		const buffers: Record<string, Buffer> = { I: gI };
		jobs.forEach((j, k) => {
			buffers[`prm${k}`] = pooledUniform(
				device,
				`look-guided-graph/prm${k}`,
				GUIDED_PARAMS.pack({ w, h, r: j.r, eps: j.eps }),
			);
			buffers[`p${k}`] = pooledStorage(device, `look-guided-graph/p${k}`, j.p);
			buffers[`ones${k}`] = pooledStorage(
				device,
				`look-guided-graph/ones${k}`,
				new Float32Array(guidedOnesLength(j.r)).fill(1),
			);
		});
		const pBytes = jobs.map((_, k) => buffers[`p${k}`].byteLength);
		const prmBytes = buffers.prm0.byteLength;
		const radii = jobs.map((j) => j.r);
		const key = `${w}x${h}|r${radii.join(",")}|I${gI.byteLength}|p${pBytes.join(",")}`;
		const { graph, hit } = cachedGraph<Params, void>(
			device,
			GUIDED_GRAPH_GROUP,
			key,
			(g) => buildGuidedGraph(g, w, h, radii, gI.byteLength, pBytes, prmBytes),
		);
		await graph.compileAsync();
		const { reads } = await graph.run(undefined, { buffers });
		lastGuidedGraphRun.hit = hit;
		lastGuidedGraphRun.stats = graph.stats;
		return reads.q.map((b) => new Float32Array(b));
	});
}
