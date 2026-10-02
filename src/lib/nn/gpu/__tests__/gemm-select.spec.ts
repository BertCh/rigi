// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import {
	GEMM_THREADS,
	GEMM_TILES,
	gemmBM,
	gemmBN,
	selectGemmConfig,
} from "../gemm-select";
import { selectAttentionTile } from "../k-attention";

describe("selectGemmConfig", () => {
	it("keeps every named tile at 256 threads, vec4-loadable and within 16 KiB of workgroup memory", () => {
		for (const [name, c] of Object.entries(GEMM_TILES)) {
			expect(c.TX * c.TY, name).toBe(GEMM_THREADS);
			expect(c.TM % 4 === 0 && c.TN % 4 === 0 && c.BK % 4 === 0, name).toBe(
				true,
			);
			expect(c.BK, name).toBeGreaterThanOrEqual(4);
			expect(4 * c.BK * (gemmBM(c) + gemmBN(c)), name).toBeLessThanOrEqual(
				16384,
			);
		}
	});

	it("gives narrow-M convs a tall-thin tile", () => {
		expect(gemmBM(selectGemmConfig(16, 786432))).toBe(16);
		expect(gemmBM(selectGemmConfig(24, 4096))).toBe(32);
	});

	it("uses the 8 x 4 tile for big products and 4 x 4 when it would leave the GPU idle", () => {
		expect(selectGemmConfig(1369, 3072)).toBe(GEMM_TILES["8x4"]);
		expect(selectGemmConfig(2048, 768)).toBe(GEMM_TILES["8x4"]);
		expect(selectGemmConfig(100, 100)).toBe(GEMM_TILES["4x4"]);
		expect(selectGemmConfig(64, 4096)).toBe(GEMM_TILES["4x4"]);
	});

	it("honours a tile override and ignores unknown names", () => {
		expect(selectGemmConfig(2048, 768, "8x8")).toBe(GEMM_TILES["8x8"]);
		expect(selectGemmConfig(2048, 768, "nope")).toBe(GEMM_TILES["8x4"]);
	});
});

describe("selectAttentionTile", () => {
	it("is 256 threads with one query each unless overridden", () => {
		expect(selectAttentionTile(64, 64)).toEqual({
			threads: 256,
			queriesPerThread: 1,
		});
		const o = { threads: 64, queriesPerThread: 2 };
		expect(selectAttentionTile(64, 64, o)).toBe(o);
	});
});
