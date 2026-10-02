// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import type { Vec3 } from "../../core";
import { segmentOccluded, VIEWSHED_DEFAULTS, viewshedVeto } from "../viewshed";

/** Flat ground at 1000 m with an optional ridge (a wall of height `h` at n = ridgeN, across all e). */
const terrain =
	(ridgeN?: number, h = 0, width = 40) =>
	(_e: number, n: number) =>
		1000 + (ridgeN !== undefined && Math.abs(n - ridgeN) < width / 2 ? h : 0);

const eye: Vec3 = [0, 0, 1002];

describe("segmentOccluded", () => {
	it("sees a far summit across flat ground", () => {
		expect(segmentOccluded(terrain(), eye, [0, 10000, 1500])).toBe(false);
	});
	it("is blocked by a ridge on the line of sight", () => {
		// ridge 2 km away, 300 m high; the target peak is 600 m above the eye at 10 km:
		// the ray is only ~122 m above the eye at 2 km
		expect(segmentOccluded(terrain(2000, 300), eye, [0, 10000, 1600])).toBe(
			true,
		);
	});
	it("is not blocked by a ridge below the line of sight (tolerance respected)", () => {
		expect(segmentOccluded(terrain(2000, 3), eye, [0, 10000, 1600])).toBe(
			false,
		);
	});
	it("ignores terrain right at the target (end margin) and very near the eye (minD)", () => {
		// a 200 m ridge 20 m short of the target: inside the end margin of 60 m
		expect(segmentOccluded(terrain(9980, 200), eye, [0, 10000, 1300])).toBe(
			false,
		);
		// an obstacle 10 m from the eye is inside minD
		expect(segmentOccluded(terrain(10, 200, 8), eye, [0, 10000, 1300])).toBe(
			false,
		);
	});
	it("never occludes a point closer than the margins allow", () => {
		expect(segmentOccluded(terrain(50, 500), eye, [0, 80, 1000])).toBe(false);
	});
	it("skips non-finite DEM samples", () => {
		expect(segmentOccluded(() => Number.NaN, eye, [0, 5000, 1500])).toBe(false);
	});
	it("a raised ridge occludes more of the far points as it grows", () => {
		const target: Vec3 = [0, 8000, 1400];
		const blocked = [0, 50, 300, 400].map((h) =>
			segmentOccluded(terrain(3000, h), eye, target),
		);
		expect(blocked).toEqual([false, false, true, true]);
	});
});

describe("viewshedVeto", () => {
	const pts = (n: number, z = 1500): Vec3[] =>
		Array.from({ length: n }, (_, i) => [(i - n / 2) * 20, 9000, z]);
	it("accepts a clear-view eye on the ground", () => {
		const r = viewshedVeto({ height: terrain() }, eye, pts(30));
		expect(r.ok).toBe(true);
		expect(r.reasons).toEqual([]);
		expect(r.aboveDemM).toBeCloseTo(2, 12);
		expect(r.nTested).toBe(30);
		expect(r.nOccluded).toBe(0);
		expect(r.occludedFrac).toBe(0);
		expect(r.aboveDsmM).toBeNaN();
	});
	it("vetoes an eye under the terrain beyond the tolerance, not within it", () => {
		const under = viewshedVeto({ height: terrain() }, [0, 0, 990], []);
		expect(under.ok).toBe(false);
		expect(under.eyeBelowGround).toBe(true);
		expect(viewshedVeto({ height: terrain() }, [0, 0, 999.5], []).ok).toBe(
			true,
		);
		expect(
			viewshedVeto({ height: terrain() }, [0, 0, 999.5], []).eyeBelowGround,
		).toBe(false);
	});
	it("vetoes when too many matched points are hidden behind a ridge", () => {
		const r = viewshedVeto({ height: terrain(2000, 400) }, eye, pts(40, 1600));
		expect(r.ok).toBe(false);
		expect(r.occludedFrac).toBe(1);
		expect(r.reasons.some((s) => s.includes("occluded"))).toBe(true);
	});
	it("reports NaN fraction and no occlusion veto below minPoints", () => {
		const r = viewshedVeto({ height: terrain(2000, 400) }, eye, pts(5, 1600));
		expect(r.occludedFrac).toBeNaN();
		expect(r.ok).toBe(true);
	});
	it("tolerates a few outliers up to maxOccludedFrac", () => {
		const good = pts(36, 1500);
		// a thin N-S wall at e = 2000 hides the four far points to the north-east
		const height = (e: number, n: number) =>
			Math.abs(e - 2000) < 20 && n > 0 && n < 3000 ? 1500 : 1000;
		const r = viewshedVeto({ height }, eye, [
			...good,
			...Array.from({ length: 4 }, (): Vec3 => [4000, 6000, 1100]),
		]);
		expect(r.nTested).toBe(40);
		expect(r.nOccluded).toBe(4);
		expect(r.occludedFrac).toBeCloseTo(0.1, 12);
		expect(r.ok).toBe(true);
		expect(r.occludedFrac).toBeLessThan(VIEWSHED_DEFAULTS.maxOccludedFrac);
	});
	it("skips non-finite points and caps the tested points", () => {
		const many: Vec3[] = Array.from({ length: 2000 }, (_, i) => [
			i,
			9000,
			1500,
		]);
		const r = viewshedVeto(
			{ height: terrain() },
			eye,
			[...many, [Number.NaN, 0, 0]],
			{ maxPoints: 100 },
		);
		expect(r.nTested).toBeLessThanOrEqual(101);
		expect(r.nTested).toBeGreaterThanOrEqual(99);
	});
	it("DSM and above-ground vetoes are off by default and opt-in", () => {
		const dsm = () => 1030; // canopy 30 m above the eye
		const off = viewshedVeto({ height: terrain(), dsm }, eye, []);
		expect(off.ok).toBe(true);
		expect(off.aboveDsmM).toBeCloseTo(-28, 12);
		expect(
			viewshedVeto({ height: terrain(), dsm }, eye, [], { dsmBelowTolM: 10 })
				.ok,
		).toBe(false);
		expect(
			viewshedVeto({ height: terrain() }, [0, 0, 1600], [], {
				maxAboveGroundM: 100,
			}).ok,
		).toBe(false);
	});
});
