// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The GPU guided filter (guided-filter.ts guidedFiltersGpu) on a core ComputeGraph: its only GPU
// path (the pooled dispatchAll path it replaced, bit for bit, was removed on 2026-10-01).
//
// Per job k (shared guide I):  H0 → t4ₖ → V0 → abₖ → H1 → t2ₖ → V1 → qₖ;  then one read node (all q).
//
// Same four KernelSpecs (unchanged WGSL), same uniforms, same workgroup counts, same dispatch order
// (job k+1's H0 depends on job k's V1: without it the scheduler interleaves the jobs, which keeps
// every job's t4 alive at once). Each job's t4 / ab / t2 are their OWN logical transients: the graph
// aliases them by lifetime (job k+1's t4 reuses a buffer job k is done with). The q planes are
// transients too, read by one read node (one readback slot). GPUConvolution is not used: its tap order / borders are not ours and the a/b
// maths sits between the passes.
//
// Clear audit: every kernel writes every element i < w·h of its output exactly once (the dispatch
// covers ⌈w·h / 256⌉·256 ≥ w·h invocations, i ≥ n returns) and reads only elements written earlier
// in the chain, so all outputs are "full" and no clear node is needed; the core lint would refuse a
// partial / atomic transient without one.
//
// NaN semantics: a NaN in I or p spreads to every box mean
// whose window contains it; clamp(NaN, 0, 1) is implementation-defined in WGSL but it is the same
// pipeline on the same device (on Apple / Metal it returns a finite value: no NaN reaches q). The
// bench compares q as raw f32 bits, NaN inputs included.
import { Buffer, type Device } from "@luma.gl/core";
import { type ComputeGraph, cachedGraph } from "../core/graph";
import { pooledStorage, pooledUniform, withLease } from "../core/pool";
import {
	type GuidedJob,
	K_GF_H0,
	K_GF_H1,
	K_GF_V0,
	K_GF_V1,
} from "./guided-filter";
import { GUIDED_PARAMS } from "./uniform-blocks";

const WG = 256;
const UNIFORM = Buffer.UNIFORM | Buffer.COPY_DST;
export const GUIDED_GRAPH_GROUP = "look-guided";

type Params = undefined;

/** Build the graph for `jobs` jobs over n texels (import byte lengths as pooled). */
export function buildGuidedGraph(
	g: ComputeGraph<Params>,
	n: number,
	iBytes: number,
	pBytes: number[],
	prmBytes: number,
) {
	const groups: [number] = [Math.ceil(n / WG)];
	const gI = g.importBuffer("I", iBytes);
	const qs = pBytes.map((pb, k) => {
		const prm = g.importBuffer(`prm${k}`, prmBytes, undefined, UNIFORM);
		const gp = g.importBuffer(`p${k}`, pb);
		const t4 = g.transientBuffer(`t4-${k}`, n * 16);
		const ab = g.transientBuffer(`ab-${k}`, n * 8);
		const t2 = g.transientBuffer(`t2-${k}`, n * 8);
		const q = g.transientBuffer(`q${k}`, n * 4);
		g.addKernel({
			id: `h0-${k}`,
			spec: K_GF_H0,
			bindings: { prm, gI, gp, outv: t4 },
			workgroups: groups,
			dependsOn: k ? [`v1-${k - 1}`] : undefined,
		})
			.addKernel({
				id: `v0-${k}`,
				spec: K_GF_V0,
				bindings: { prm, inv: t4, ab },
				workgroups: groups,
			})
			.addKernel({
				id: `h1-${k}`,
				spec: K_GF_H1,
				bindings: { prm, ab, outv: t2 },
				workgroups: groups,
			})
			.addKernel({
				id: `v1-${k}`,
				spec: K_GF_V1,
				bindings: { prm, inv: t2, gI, q },
				workgroups: groups,
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
	const n = w * h;
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
		});
		const pBytes = jobs.map((_, k) => buffers[`p${k}`].byteLength);
		const prmBytes = buffers.prm0.byteLength;
		const key = `${n}|I${gI.byteLength}|p${pBytes.join(",")}`;
		const { graph, hit } = cachedGraph<Params, void>(
			device,
			GUIDED_GRAPH_GROUP,
			key,
			(g) => buildGuidedGraph(g, n, gI.byteLength, pBytes, prmBytes),
		);
		await graph.compileAsync();
		const { reads } = await graph.run(undefined, { buffers });
		lastGuidedGraphRun.hit = hit;
		lastGuidedGraphRun.stats = graph.stats;
		return reads.q.map((b) => new Float32Array(b));
	});
}
