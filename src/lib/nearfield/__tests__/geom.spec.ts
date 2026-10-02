// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import {
	gridDemRange,
	intrinsicsFromPose,
	maskSampler,
	median,
	modelDepth,
	rayFactor,
	sampleDemGrid,
} from "../geom";
import type { NearFieldDepth } from "../types";

describe("intrinsicsFromPose", () => {
	it("gives fy = 0.5/tan(vfov/2) and fx = fy/aspect", () => {
		const K = intrinsicsFromPose({ yaw: 0, pitch: 0, roll: 0, vfov: 90 }, 2);
		expect(K.fy).toBeCloseTo(0.5, 12);
		expect(K.fx).toBeCloseTo(0.25, 12);
		expect([K.cx, K.cy]).toEqual([0.5, 0.5]);
	});
});

describe("rayFactor", () => {
	const K = { fx: 0.5, fy: 0.5, cx: 0.5, cy: 0.5 };
	it("is 1 at the principal point", () => {
		expect(rayFactor(K, 0.5, 0.5)).toBe(1);
	});
	it("is sqrt(1 + x^2 + y^2) off-axis", () => {
		// u = 1.0 -> x = 1; v = 1.0 -> y = 1
		expect(rayFactor(K, 1, 1)).toBeCloseTo(Math.sqrt(3), 12);
		expect(rayFactor(K, 1, 0.5)).toBeCloseTo(Math.SQRT2, 12);
	});
});

describe("maskSampler", () => {
	it("returns null for missing / empty masks", () => {
		expect(maskSampler(null)).toBeNull();
		expect(maskSampler({ width: 0, height: 0, data: [] })).toBeNull();
	});
	it("treats 0/1 masks as binary", () => {
		const s = maskSampler({ width: 2, height: 2, data: [0, 1, 0, 0] });
		expect(s?.(0.75, 0.25)).toBe(true);
		expect(s?.(0.25, 0.25)).toBe(false);
	});
	it("treats 0..255 masks with threshold 128", () => {
		const s = maskSampler({ width: 2, height: 1, data: [127, 128] });
		expect(s?.(0.25, 0.5)).toBe(false);
		expect(s?.(0.75, 0.5)).toBe(true);
	});
	it("clamps out-of-range coordinates to the border cell", () => {
		const s = maskSampler({ width: 2, height: 2, data: [0, 0, 0, 1] });
		expect(s?.(5, 5)).toBe(true);
		expect(s?.(-1, -1)).toBe(false);
	});
});

describe("modelDepth", () => {
	const d: NearFieldDepth = {
		width: 4,
		height: 1,
		depth: new Float32Array([2, 3, -1, Number.NaN]),
		valid: new Uint8Array([1, 0, 1, 1]),
		model: "t",
		seconds: 0,
	};
	it("is NaN for invalid, non-positive and NaN cells", () => {
		expect(modelDepth(d, 0)).toBe(2);
		expect(modelDepth(d, 1)).toBeNaN();
		expect(modelDepth(d, 2)).toBeNaN();
		expect(modelDepth(d, 3)).toBeNaN();
	});
});

describe("DEM grid sampling", () => {
	it("grids at cell centres, maps null / non-positive to NaN, and the lookup inverts it", () => {
		const seen: [number, number][] = [];
		const grid = sampleDemGrid(2, 2, (u, v) => {
			seen.push([u, v]);
			return u < 0.5 ? (v < 0.5 ? 100 : null) : v < 0.5 ? 0 : 250;
		});
		expect(seen[0]).toEqual([0.25, 0.25]);
		expect(seen[3]).toEqual([0.75, 0.75]);
		expect(grid[0]).toBe(100);
		expect(grid[1]).toBeNaN(); // 0 is not a hit
		expect(grid[2]).toBeNaN();
		expect(grid[3]).toBe(250);
		const at = gridDemRange(grid, 2, 2);
		expect(at(0.1, 0.1)).toBe(100);
		expect(at(0.9, 0.9)).toBe(250);
		expect(at(0.1, 0.9)).toBeNull();
		expect(at(2, 2)).toBe(250); // clamped
	});
});

describe("median", () => {
	it("handles odd, even, unsorted and empty input", () => {
		expect(median([3, 1, 2])).toBe(2);
		expect(median([4, 1, 3, 2])).toBe(2.5);
		expect(median([10, 9, 100])).toBe(10); // numeric, not lexicographic
		expect(median([])).toBeNaN();
	});
	it("does not mutate its input", () => {
		const a = [3, 1, 2];
		median(a);
		expect(a).toEqual([3, 1, 2]);
	});
});
