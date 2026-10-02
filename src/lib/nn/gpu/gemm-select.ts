// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// GEMM tile selection (pure): a 256-thread workgroup is a TX × TY grid, each thread owning a
// TM × TN register block of the BM × BN output tile (BM = TM·TY, BN = TN·TX), K in steps of BK.
// Larger blocks raise FLOPs per shared-memory read; narrow-M convs get tall-thin tiles so the
// 16-row weight matrix does not waste the tile.

export type GemmConfig = {
	TM: number;
	TN: number;
	TX: number;
	TY: number;
	BK: number;
};

export const GEMM_THREADS = 256;

export const gemmBM = (c: GemmConfig) => c.TM * c.TY;
export const gemmBN = (c: GemmConfig) => c.TN * c.TX;

/** Default WebGPU limit for workgroup memory; configs stay within it so no raised limit is needed. */
const WORKGROUP_BYTES = 16384;

/** The largest K step (a multiple of 4, at most 16) whose A and B tiles fit WORKGROUP_BYTES in f32. */
const make = (TM: number, TN: number, TY: number): GemmConfig => {
	const TX = GEMM_THREADS / TY;
	const perK = 4 * (TM * TY + TN * TX);
	const BK = Math.min(16, Math.floor(WORKGROUP_BYTES / perK / 4) * 4);
	return { TM, TN, TY, TX, BK };
};

/** Named tiles for tuning overrides. */
export const GEMM_TILES: Record<string, GemmConfig> = {
	"8x8": make(8, 8, 16),
	"8x4": make(8, 4, 16),
	"4x8": make(4, 8, 16),
	"4x4": make(4, 4, 16),
	// narrow-M (≤ 16 output rows): 16 × 256 / 512
	n4x4: make(4, 4, 4),
	n4x8: make(4, 8, 4),
	// M ≤ 32
	m4x8: make(4, 8, 8),
};

/** Workgroups needed at or below which a big tile leaves the GPU idle (shared GPUs have ~10-40 cores). */
const MIN_WORKGROUPS = 48;

export function selectGemmConfig(
	M: number,
	N: number,
	override: string | null = null,
): GemmConfig {
	if (override && GEMM_TILES[override]) return GEMM_TILES[override];
	if (M <= 16) return GEMM_TILES.n4x8;
	if (M <= 32) return GEMM_TILES.m4x8;
	const groups = (c: GemmConfig) =>
		Math.ceil(M / gemmBM(c)) * Math.ceil(N / gemmBN(c));
	// 8 × 4 per thread (128 × 64 tile) measured best on Apple/Dawn: 8 × 8 (128 × 128) spills registers
	if (M > 64 && N > 64 && groups(GEMM_TILES["8x4"]) >= MIN_WORKGROUPS)
		return GEMM_TILES["8x4"];
	return GEMM_TILES["4x4"];
}

export const gemmConfigKey = (c: GemmConfig) =>
	`${c.TM}x${c.TN}y${c.TY}k${c.BK}`;
