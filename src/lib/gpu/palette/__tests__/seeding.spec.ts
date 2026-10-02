// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import {
	farthestPointSeeds,
	permuteRows,
	seedPermutation,
	seedPosition,
} from "../seeding";

describe("farthest-point seeding", () => {
	const rows = Float32Array.from([
		0, 0, 0.1, 0, 10, 10, 10.1, 10, 0, 10, 0.1, 10.1,
	]);
	it("starts at the row nearest the mean, then maximises the minimum distance", () => {
		const seeds = farthestPointSeeds(rows, 6, 2, 2, 3);
		expect(new Set(seeds).size).toBe(3);
		// three seeds, one per well separated corner region
		const corners = new Set(
			seeds.map((s) => `${rows[s * 2] > 5}${rows[s * 2 + 1] > 5}`),
		);
		expect(corners.size).toBe(3);
		expect(farthestPointSeeds(rows, 6, 2, 2, 3)).toEqual(seeds);
	});
	it("never repeats a row, even on identical rows (lowest index first)", () => {
		const same = new Float32Array(8).fill(1);
		expect(farthestPointSeeds(same, 4, 2, 2, 3)).toEqual([0, 1, 2]);
	});
	it("permutes seeds to the GPUKMeans seed positions and stays a permutation", () => {
		const n = 17;
		const seeds = [16, 3, 9, 0];
		const permutation = seedPermutation(n, seeds);
		expect([...permutation].sort((a, b) => a - b)).toEqual(
			Array.from({ length: n }, (_, i) => i),
		);
		for (const [c, seed] of seeds.entries())
			expect(permutation[seedPosition(c, n, seeds.length)]).toBe(seed);
		const values = Float32Array.from({ length: n * 2 }, (_, i) => i);
		const permuted = permuteRows(values, permutation, 2);
		expect(permuted[seedPosition(0, n, 4) * 2]).toBe(seeds[0] * 2);
	});
});
