// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The GPU scorer's CPU-side packing (the device run is scripts/gpu/ransac-dawn.ts).
import { describe, expect, it } from "vitest";
import { HYP_STRIDE, type HypothesisBatch } from "#/lib/pose6dof/ransac/batch";
import {
	ARGMAX_WGSL,
	MODE_ID,
	packCorrespondences,
	packParams,
	RANSAC_U,
	SCORE_WGSL,
} from "../score";

const batch = (
	mode: HypothesisBatch["mode"],
	count: number,
	n: number,
): HypothesisBatch => {
	const bw = mode === "chord" ? 3 : 2;
	return {
		mode,
		hyps: new Float64Array(count * HYP_STRIDE),
		count,
		a: Float64Array.from({ length: n * 3 }, (_, i) => i + 0.25),
		b: Float64Array.from({ length: n * bw }, (_, i) => -i - 0.5),
		n,
		thr2: 0.5,
	};
};

describe("ransac scorer packing", () => {
	it("packs correspondences as two vec4f each (b.xyz for chord, b.xy otherwise)", () => {
		const c = packCorrespondences(batch("chord", 1, 2));
		expect(Array.from(c)).toEqual([
			0.25, 1.25, 2.25, 0, -0.5, -1.5, -2.5, 0, 3.25, 4.25, 5.25, 0, -3.5, -4.5,
			-5.5, 0,
		]);
		const r = packCorrespondences(batch("reproj", 1, 2));
		expect(Array.from(r.subarray(4, 8))).toEqual([-0.5, -1.5, 0, 0]);
		expect(Array.from(r.subarray(12, 16))).toEqual([-2.5, -3.5, 0, 0]);
	});
	it("uses a 2-D grid past 65535 hypotheses and sets the selection rule per mode", () => {
		expect(packParams(batch("chord", 1000, 3)).wx).toBe(1000);
		const big = packParams(batch("reproj", 70000, 3));
		expect(big.wx).toBe(65535);
		expect(big.wy).toBe(2);
		const u = new Uint32Array(big.words);
		expect(u[RANSAC_U.offsetOf("k")]).toBe(70000);
		expect(u[RANSAC_U.offsetOf("mode")]).toBe(MODE_ID.reproj);
		expect(u[RANSAC_U.offsetOf("byCost")]).toBe(1);
		expect(
			new Uint32Array(packParams(batch("angular", 5, 3)).words)[
				RANSAC_U.offsetOf("byCost")
			],
		).toBe(0);
	});
	it("declares the same uniform struct in both kernels", () => {
		const struct = (s: string) => s.match(/struct P \{[^}]*\}/)?.[0];
		expect(struct(SCORE_WGSL)).toBe(struct(ARGMAX_WGSL));
		expect(struct(SCORE_WGSL)).toContain(
			"n: u32, k: u32, mode: u32, thr2: f32, wx: u32, byCost: u32",
		);
	});
});
