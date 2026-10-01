// GPU twin of look/guided-filter.ts guidedFilter (grey guide, (2r+1)² clamped box means). The batch
// form filters several masks against one guide in one submit and one readback, which is what
// CompositeLook.updateMasks needs (coverage, cut, people). Buffers are pooled (lease "look-guided");
// each job has its own parameter, input and output slots, since all jobs share one submit.
import type { Device } from "@luma.gl/core";
import { GF_H0, GF_H1, GF_V0, GF_V1 } from "./guided-filter.wgsl";
import {
	defineKernel,
	dispatchAll,
	kernel,
	pooledStorage,
	pooledUniform,
	stageReads,
	submit,
	withLease,
} from "./kernel";

export const K_GF_H0 = defineKernel("gf-h0", GF_H0, [
	["prm", "uniform"],
	["gI", "read-only-storage"],
	["gp", "read-only-storage"],
	["outv", "storage"],
]);
export const K_GF_V0 = defineKernel("gf-v0", GF_V0, [
	["prm", "uniform"],
	["inv", "read-only-storage"],
	["ab", "storage"],
]);
export const K_GF_H1 = defineKernel("gf-h1", GF_H1, [
	["prm", "uniform"],
	["ab", "read-only-storage"],
	["outv", "storage"],
]);
export const K_GF_V1 = defineKernel("gf-v1", GF_V1, [
	["prm", "uniform"],
	["inv", "read-only-storage"],
	["gI", "read-only-storage"],
	["q", "storage"],
]);

export type GuidedJob = { p: Float32Array; r: number; eps: number };

const WG = 256;

/** guidedFilter(I, p, w, h, r, eps) for each job, sharing the guide `I`. Same output as the CPU. */
export async function guidedFiltersGpu(
	device: Device,
	I: Float32Array,
	w: number,
	h: number,
	jobs: readonly GuidedJob[],
	opts: { graph?: boolean } = {},
): Promise<Float32Array[]> {
	// opt-in: the same four kernels per job on a core ComputeGraph (guided-filter-graph.ts)
	if (opts.graph)
		return (await import("./guided-filter-graph")).guidedFiltersGraph(
			device,
			I,
			w,
			h,
			jobs,
		);
	const n = w * h;
	const kH0 = kernel(device, K_GF_H0);
	const kV0 = kernel(device, K_GF_V0);
	const kH1 = kernel(device, K_GF_H1);
	const kV1 = kernel(device, K_GF_V1);
	return withLease("look-guided", async () => {
		// every kernel writes all n texels of its output: no zeroing needed
		const scratch = (key: string, bytes: number) =>
			pooledStorage(device, `look-guided/${key}`, bytes, { zero: false });
		const gI = pooledStorage(device, "look-guided/I", I);
		const t4 = scratch("t4", n * 16);
		const ab = scratch("ab", n * 8);
		const t2 = scratch("t2", n * 8);
		const enc = device.createCommandEncoder({ id: "look-guided" });
		const groups = Math.ceil(n / WG);
		const outs = jobs.map((j, k) => {
			const words = new ArrayBuffer(16);
			new Uint32Array(words, 0, 3).set([w, h, j.r]);
			new Float32Array(words, 12, 1)[0] = j.eps;
			const prm = pooledUniform(device, `look-guided/prm${k}`, words);
			const gp = pooledStorage(device, `look-guided/p${k}`, j.p);
			const q = scratch(`q${k}`, n * 4);
			dispatchAll(
				enc,
				[
					{ k: kH0, bindings: { prm, gI, gp, outv: t4 }, x: groups },
					{ k: kV0, bindings: { prm, inv: t4, ab }, x: groups },
					{ k: kH1, bindings: { prm, ab, outv: t2 }, x: groups },
					{ k: kV1, bindings: { prm, inv: t2, gI, q }, x: groups },
				],
				"look-guided",
			);
			return { buffer: q, size: n * 4 };
		});
		const rd = stageReads(device, enc, outs);
		submit(device, enc);
		return (await rd.read()).map((b) => new Float32Array(b));
	});
}
