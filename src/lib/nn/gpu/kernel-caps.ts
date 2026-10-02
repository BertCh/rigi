// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Device capabilities and tuning switches the nn kernel generators consult. The generators are pure
// functions of (params, dtypes); the device's features reach them through this module, set once by
// GpuNn's constructor. Every variant is guarded by a capability and has the legacy kernel as the
// fallback (`legacy: true` forces the old kernels everywhere, for benches and A/B).

export type KernelCaps = {
	/** the device has shader-f16 */
	f16: boolean;
	/** the device has the WGSL `subgroups` feature */
	subgroups: boolean;
	/** force the pre-RT-1 kernels (64×64 GEMM, one-thread-per-query attention, f32 topk keys) */
	legacy: boolean;
	/** GEMM / conv tiles in f16 on shader-f16 devices (products round to f16, accumulation stays f32). On by default: the depth net's depth error vs f32 is 0.03% median (scripts/nearfield/depth-live.bench.ts --only f16) */
	f16Math: boolean;
	/** with f16Math: accumulate in f16 as well (fast, only for tolerant models) */
	f16Accumulate: boolean;
	/** subgroup-broadcast GEMM inner loop where `subgroups` is present (off by default, see k-gemm.ts) */
	subgroupGemm: boolean;
	/** conv weights read one element at a time instead of vec4 along k (A/B for benches) */
	convScalarWeights: boolean;
	/** storage buffers one fused kernel may bind, parameter buffer included (the device limit, 8 by default) */
	maxStorageBuffers: number;
	/** pin the attention tile (threads per workgroup, queries per thread) for tuning; null = autoselect */
	attentionTileOverride: { threads: number; queriesPerThread: number } | null;
	/** pin a GEMM tile by name ("8x8", "8x4", "4x8", "4x4") for tuning; null = autoselect by shape */
	gemmTileOverride: string | null;
};

const caps: KernelCaps = {
	f16: false,
	subgroups: false,
	legacy: false,
	f16Math: true,
	f16Accumulate: false,
	subgroupGemm: false,
	convScalarWeights: false,
	maxStorageBuffers: 8,
	gemmTileOverride: null,
	attentionTileOverride: null,
};

export const getKernelCaps = (): Readonly<KernelCaps> => caps;

export function setKernelCaps(next: Partial<KernelCaps>): void {
	Object.assign(caps, next);
}

/** The device features as caps (what GpuNn passes in). */
export function capsFromFeatures(has: (feature: string) => boolean) {
	return { f16: has("shader-f16"), subgroups: has("subgroups") };
}
