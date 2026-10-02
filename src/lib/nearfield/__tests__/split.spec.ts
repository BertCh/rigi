// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { classifyRange, splitPixels } from "../split";
import { DEFAULT_SPLIT, type NearFieldDepth, PixelClass } from "../types";

describe("classifyRange", () => {
	it("people are always Object, even far away", () => {
		expect(classifyRange(1000, 5, true)).toBe(PixelClass.Object);
	});
	it("beyond nearRadius is Far (and NaN range is not near)", () => {
		expect(classifyRange(151, 151, false)).toBe(PixelClass.Far);
		expect(classifyRange(Number.NaN, 100, false)).toBe(PixelClass.Far);
	});
	it("no DEM behind a near sample is Object (silhouetted)", () => {
		expect(classifyRange(20, null, false)).toBe(PixelClass.Object);
		expect(classifyRange(20, 0, false)).toBe(PixelClass.Object);
	});
	it("Object needs both the relative margin and the absolute gap", () => {
		// dem 100: margin threshold 50 m
		expect(classifyRange(49, 100, false)).toBe(PixelClass.Object);
		expect(classifyRange(50, 100, false)).toBe(PixelClass.Terrain);
		// dem 4: 1.9 < 2 passes the margin but the gap 2.1 < 3 m does not
		expect(classifyRange(1.9, 4, false)).toBe(PixelClass.Terrain);
		expect(classifyRange(0.5, 4, false)).toBe(PixelClass.Object); // gap 3.5
	});
	it("at or behind the DEM is Terrain", () => {
		expect(classifyRange(100, 100, false)).toBe(PixelClass.Terrain);
		expect(classifyRange(140, 100, false)).toBe(PixelClass.Terrain);
	});
	it("honours custom params", () => {
		const p = { objectMargin: 0.1, nearRadius: 30, minGapM: 1 };
		expect(classifyRange(31, 31, false, p)).toBe(PixelClass.Far);
		expect(classifyRange(20, 25, false, p)).toBe(PixelClass.Object);
	});
});

function depthGrid(z: number[], valid: number[]): NearFieldDepth {
	return {
		width: z.length,
		height: 1,
		depth: Float32Array.from(z),
		valid: Uint8Array.from(valid),
		model: "t",
		seconds: 0,
		// fx huge: rayFactor ~ 1, so range ~ z-depth
		intrinsicsNorm: { fx: 1e6, fy: 1e6, cx: 0.5, cy: 0.5 },
	};
}
const identityFit = { scale: 1, shift: 0 };

describe("splitPixels", () => {
	it("labels every cell and keeps counts consistent", () => {
		// cells: terrain, object (well in front of DEM), far (beyond radius), no-depth+DEM, no-depth no-DEM
		const depth = depthGrid([100, 20, 400, 0, 0], [1, 1, 1, 0, 0]);
		const dem = [100, 100, 400, 80, null];
		const res = splitPixels(
			depth,
			identityFit,
			(u) => dem[Math.min(4, Math.floor(u * 5))],
			null,
			null,
		);
		expect([...res.cls]).toEqual([
			PixelClass.Terrain,
			PixelClass.Object,
			PixelClass.Far,
			PixelClass.Far,
			PixelClass.Sky, // no sky mask at all: invalid model depth means sky
		]);
		expect(res.counts.reduce((a, b) => a + b, 0)).toBe(5);
		expect(res.counts[PixelClass.Terrain]).toBe(1);
	});
	it("sky mask wins; with a mask a hole with no DEM is Unknown, not Sky", () => {
		const depth = depthGrid([100, 0], [1, 0]);
		const sky = { width: 2, height: 1, data: [1, 0] };
		const res = splitPixels(depth, identityFit, () => null, sky, null);
		expect([...res.cls]).toEqual([PixelClass.Sky, PixelClass.Unknown]);
	});
	it("people mask forces Object on cells with model depth", () => {
		const depth = depthGrid([100, 100], [1, 1]);
		const people = { width: 2, height: 1, data: [0, 1] };
		const res = splitPixels(depth, identityFit, () => 100, null, people);
		expect([...res.cls]).toEqual([PixelClass.Terrain, PixelClass.Object]);
	});
	it("a failed fit (n below nMin) splits by the DEM alone and never yields Object", () => {
		const depth = depthGrid([5, 5, 5], [1, 1, 1]);
		const dem = [10, 500, null];
		const res = splitPixels(
			depth,
			{ ...identityFit, n: 0 },
			(u) => dem[Math.min(2, Math.floor(u * 3))],
			null,
			null,
			DEFAULT_SPLIT,
		);
		expect([...res.cls]).toEqual([
			PixelClass.Terrain,
			PixelClass.Far,
			PixelClass.Unknown,
		]);
	});
	it("applies the anchor scale before comparing with the DEM", () => {
		const depth = depthGrid([10], [1]);
		const unscaled = splitPixels(depth, identityFit, () => 100, null, null);
		const scaled = splitPixels(
			depth,
			{ scale: 10, shift: 0 },
			() => 100,
			null,
			null,
		);
		expect(unscaled.cls[0]).toBe(PixelClass.Object);
		expect(scaled.cls[0]).toBe(PixelClass.Terrain);
	});
});
