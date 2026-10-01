// GPU twin of look/guided-filter.ts guidedFilter (grey guide, (2r+1)² clamped box means). The batch
// form filters several masks against one guide in one submit and one readback, which is what
// CompositeLook.updateMasks needs (coverage, cut, people). The four kernels per job run as one core
// ComputeGraph (guided-filter-graph.ts); the pooled dispatchAll path was removed on 2026-10-01.
import type { Device } from "@luma.gl/core";
import { GF_H0, GF_H1, GF_V0, GF_V1 } from "./guided-filter.wgsl";
import { defineKernel } from "./kernel";

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

/** guidedFilter(I, p, w, h, r, eps) for each job, sharing the guide `I`. Same output as the CPU. */
export async function guidedFiltersGpu(
	device: Device,
	I: Float32Array,
	w: number,
	h: number,
	jobs: readonly GuidedJob[],
): Promise<Float32Array[]> {
	// guided-filter-graph.ts imports the kernel specs above (hence the dynamic import)
	return (await import("./guided-filter-graph")).guidedFiltersGraph(
		device,
		I,
		w,
		h,
		jobs,
	);
}
