// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { destination } from "../../../geodesy";
import {
	type HeightAt,
	type RidgeOptions,
	ridgeSchedule,
	ridgeTopsCpu,
	traceViewpoint,
} from "../ridgelines";

const eye = { lat: 46.7, lon: 7.7, h: 1000 };
// coarse and short: 10-degree columns, 12 slabs out to 20 km
const OPTS: RidgeOptions = { step: 5, slabs: 12, dMin: 100, dMax: 20_000 };
const flat: HeightAt = () => 900;
/** A wall 6 km north of the eye, 400 m above it (heights are MSL). */
const northWall: HeightAt = (lat) =>
	lat > destination(eye.lat, eye.lon, 0, 6000).lat ? 1400 : 900;

describe("ridgeSchedule", () => {
	it("has monotone distances, slab edges and one slab per distance", () => {
		const s = ridgeSchedule(OPTS);
		expect(s.cols).toBe(72);
		expect(s.dists[0]).toBe(100);
		expect(s.dists[s.dists.length - 1]).toBeLessThan(20_000);
		for (let i = 1; i < s.dists.length; i++)
			expect(s.dists[i]).toBeGreaterThan(s.dists[i - 1]);
		expect(s.edge(0)).toBeCloseTo(100);
		expect(s.edge(s.S)).toBeCloseTo(20_000, 3);
		for (let i = 1; i < s.slabOf.length; i++)
			expect(s.slabOf[i]).toBeGreaterThanOrEqual(s.slabOf[i - 1]);
		expect(s.slabOf[s.slabOf.length - 1]).toBe(s.S - 1);
	});
	it("defaults to 0.1 degree columns and 56 slabs", () => {
		const s = ridgeSchedule();
		expect(s.cols).toBe(3600);
		expect(s.S).toBe(56);
	});
	it("a higher refraction coefficient flattens the curvature drop", () => {
		expect(ridgeSchedule({ k: 0.5 }).inv2R).toBeLessThan(
			ridgeSchedule({ k: 0 }).inv2R,
		);
	});
});

describe("ridgeTopsCpu", () => {
	it("leaves cells without data at -Infinity and never calls past NaN", () => {
		const { top } = ridgeTopsCpu(() => Number.NaN, eye, OPTS);
		expect(top.every((v) => v === Number.NEGATIVE_INFINITY)).toBe(true);
	});
	it("sees a wall only in the northern columns, at its distance", () => {
		const s = ridgeSchedule(OPTS);
		const { top, topD } = ridgeTopsCpu(northWall, eye, OPTS);
		const best = (c: number) => {
			let m = Number.NEGATIVE_INFINITY;
			let d = 0;
			for (let sl = 0; sl < s.S; sl++)
				if (top[sl * s.cols + c] > m) {
					m = top[sl * s.cols + c];
					d = topD[sl * s.cols + c];
				}
			return { m, d };
		};
		const north = best(0);
		const south = best(36);
		expect(north.m).toBeGreaterThan(south.m + 1);
		// atan(400 / 6000) ~ 3.8 deg, minus the curvature drop
		expect(north.m).toBeGreaterThan(2);
		expect(north.m).toBeLessThan(4);
		expect(north.d).toBeGreaterThan(5900);
		expect(south.m).toBeLessThan(0);
	});
});

describe("traceViewpoint", () => {
	it("is empty over featureless ground below the eye except the skyline", () => {
		const t = traceViewpoint(flat, eye, [], OPTS);
		expect(t.slabs).toBe(12);
		expect(t.skyline).toHaveLength(72);
		expect(t.start[0]).toBe(0);
		expect(t.start).toHaveLength(t.slab.length + 1);
		expect(t.pts.length).toBe(t.start[t.start.length - 1] * 2);
		expect(t.peaks).toEqual([]);
		// every skyline column sees ground in front of the eye: below the horizon, above -90
		for (const v of t.skyline) {
			expect(v).toBeLessThan(0);
			expect(v).toBeGreaterThan(-40);
		}
	});

	it("reports -Infinity skyline where there is no data", () => {
		const t = traceViewpoint(() => Number.NaN, eye, [], OPTS);
		expect(t.slab).toHaveLength(0);
		expect(t.skyline.every((v) => v === Number.NEGATIVE_INFINITY)).toBe(true);
	});

	it("draws a ridge stroke along the wall and lifts the skyline there", () => {
		const t = traceViewpoint(northWall, eye, [], OPTS);
		expect(t.skyline[0]).toBeGreaterThan(t.skyline[36] + 2);
		expect(t.slab.length).toBeGreaterThan(0);
		expect(t.ridge.some((r) => r === 1)).toBe(true);
		// strokes are (az, el) pairs with sane magnitudes
		for (let i = 0; i < t.pts.length; i += 2) {
			expect(Number.isFinite(t.pts[i])).toBe(true);
			expect(Math.abs(t.pts[i + 1])).toBeLessThan(90);
		}
		// the near-ground cue is a subset: ridges only
		expect(t.cueSlab.length).toBeLessThanOrEqual(t.slab.length);
		expect(t.cueStart).toHaveLength(t.cueSlab.length + 1);
	});

	it("uses precomputed tops when supplied", () => {
		const tops = ridgeTopsCpu(northWall, eye, OPTS);
		const a = traceViewpoint(northWall, eye, [], OPTS, tops);
		const b = traceViewpoint(northWall, eye, [], OPTS);
		expect(Array.from(a.skyline)).toEqual(Array.from(b.skyline));
		expect(Array.from(a.pts)).toEqual(Array.from(b.pts));
	});

	it("keeps a peak above the wall and drops one hidden behind it", () => {
		const high = destination(eye.lat, eye.lon, 0, 9000);
		const hidden = destination(eye.lat, eye.lon, 0, 9000);
		const under = destination(eye.lat, eye.lon, 180, 3000);
		const near = destination(eye.lat, eye.lon, 90, 20);
		const t = traceViewpoint(
			northWall,
			eye,
			[
				{ name: "High", ...high, ele: 2600, prominence: 120 },
				{ name: "Hidden", ...hidden, ele: 1000 },
				{ name: "Underfoot", ...near, ele: 2000 },
				{
					name: "Beyond",
					...destination(eye.lat, eye.lon, 0, 90_000),
					ele: 5000,
				},
				{ name: "South", ...under, ele: 900 },
			],
			OPTS,
		);
		const names = t.peaks.map((p) => p.name);
		expect(names).toContain("High");
		expect(names).not.toContain("Hidden");
		expect(names).not.toContain("Underfoot"); // within 60 m
		expect(names).not.toContain("Beyond"); // past dMax
		const p = t.peaks.find((x) => x.name === "High");
		expect(p?.d).toBeGreaterThan(8900);
		expect(p?.d).toBeLessThan(9100);
		expect(p?.ele).toBe(2600);
		expect(p?.prominence).toBe(120);
		expect(Math.min(p?.az ?? 99, 360 - (p?.az ?? 0))).toBeLessThan(1);
		expect(p?.el).toBeGreaterThan(5);
	});
});
