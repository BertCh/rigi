// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// GPU twin of look/guided-filter.ts guidedFilter (grey guide, (2r+1)² clamped box means). The batch
// form filters several masks against one guide in one submit and one readback, which is what
// CompositeLook.updateMasks needs (coverage, cut, people). Per job: three small kernels and four luma
// GPUConvolutions (the box means) in one core ComputeGraph (guided-filter-graph.ts). q is within f32
// tolerance of the CPU twin (~1e-5), not bit-identical.
import type { Device } from "@luma.gl/core";
import { GF_FINISH, GF_PREP, GF_SOLVE } from "./guided-filter.wgsl";
import { defineKernel } from "./kernel";

export const K_GF_PREP = defineKernel("gf-prep", GF_PREP, [
	["prm", "uniform"],
	["gI", "read-only-storage"],
	["gp", "read-only-storage"],
	["s1", "storage"],
]);
export const K_GF_SOLVE = defineKernel("gf-solve", GF_SOLVE, [
	["prm", "uniform"],
	["s3", "read-only-storage"],
	["ab", "storage"],
]);
export const K_GF_FINISH = defineKernel("gf-finish", GF_FINISH, [
	["prm", "uniform"],
	["ab3", "read-only-storage"],
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
