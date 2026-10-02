// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { EARTH_R, REFRACTION_K } from "../../geodesy";
import { type HeightFn, layeredHorizon, marchDistances } from "../layered";

const EYE: [number, number, number] = [0, 0, 0];
const fine = { step: 1, minD: 100, maxD: 20_000, minStep: 20, growth: 0.002 };
// height as a function of distance only (the third HeightFn argument is d)
const profile =
	(f: (d: number) => number): HeightFn =>
	(_e, _n, d) =>
		f(d);
// terrain below the eye whose tangent rises with distance (so only bumps make crests), plus bumps
const BASE = -50;
const bump = (d: number, c: number, w: number, hgt: number) =>
	Math.abs(d - c) < w ? hgt : BASE;

describe("marchDistances", () => {
	it("starts at minD, stops at maxD and grows monotonically with spacing >= minStep", () => {
		const ds = marchDistances({ minD: 50, maxD: 5000, minStep: 10 });
		expect(ds[0]).toBe(50);
		expect(ds[ds.length - 1]).toBeLessThanOrEqual(5000);
		for (let i = 1; i < ds.length; i++)
			expect(ds[i] - ds[i - 1]).toBeGreaterThanOrEqual(10 - 1e-9);
	});
	it("uses the documented defaults", () => {
		const ds = marchDistances();
		expect(ds[0]).toBe(20);
		expect(ds[1] - ds[0]).toBe(5);
		expect(ds[ds.length - 1]).toBeLessThanOrEqual(150_000);
	});
});

describe("layeredHorizon", () => {
	it("a flat plane below the eye gives exactly one crest per azimuth: the skyline", () => {
		const r = layeredHorizon(
			profile(() => -10),
			[0, 0, 0] as never,
			[0, 3],
			fine,
		);
		expect(r.crests).toHaveLength(4);
		for (const col of r.crests) {
			expect(col).toHaveLength(1);
			expect(col[0].sky).toBe(true);
			expect(col[0].dBack).toBe(Number.POSITIVE_INFINITY);
		}
	});

	it("reports a near ridge occluding a taller far ridge, nearest first, elevation increasing", () => {
		const h = profile((d) =>
			Math.max(bump(d, 1000, 60, 100), bump(d, 8000, 100, 2000)),
		);
		const r = layeredHorizon(h, EYE, [90, 90], fine);
		const col = r.crests[0];
		expect(col).toHaveLength(2);
		const [near, sky] = col;
		expect(near.sky).toBe(false);
		expect(near.d).toBeGreaterThan(900);
		expect(near.d).toBeLessThan(1100);
		expect(near.dBack).toBeGreaterThan(7000);
		expect(Number.isFinite(near.dBack)).toBe(true);
		expect(sky.sky).toBe(true);
		expect(sky.d).toBeGreaterThan(7800);
		expect(sky.el).toBeGreaterThan(near.el);
		// crest world point lies on the march ray: azimuth 90 = due east
		expect(near.world[0]).toBeCloseTo(near.d, 6);
		expect(Math.abs(near.world[1])).toBeLessThan(1e-6);
		expect(near.world[2]).toBe(100);
		expect(near.dBack).toBeLessThan(8100);
		expect(near.el).toBeCloseTo((Math.atan(100 / near.d) * 180) / Math.PI, 9);
	});

	it("a near ridge that the far terrain only barely clears is not a crest (minOcclusion)", () => {
		// far terrain re-emerges right behind the near ridge: hidden stretch << 0.3 * d
		const h = profile((d) =>
			d <= 1060 ? bump(d, 1000, 60, 100) : 100 + (d - 1000) * 0.2,
		);
		const r = layeredHorizon(h, EYE, [0, 0], fine);
		expect(r.crests[0]).toHaveLength(1);
		expect(r.crests[0][0].sky).toBe(true);
	});

	it("a ridge hidden behind a taller nearer ridge is never reported", () => {
		const h = profile((d) =>
			Math.max(bump(d, 1000, 60, 500), bump(d, 6000, 100, 300)),
		);
		const r = layeredHorizon(h, EYE, [0, 0], fine);
		expect(r.crests[0]).toHaveLength(1);
		expect(r.crests[0][0].d).toBeLessThan(1100);
	});

	it("ignores NaN samples and returns no crest for a column of only NaN", () => {
		const r = layeredHorizon(() => Number.NaN, EYE, [0, 0], fine);
		expect(r.crests[0]).toEqual([]);
	});

	it("sector sets the column count and azimuth origin; stats count samples", () => {
		const r = layeredHorizon(
			profile(() => -5),
			EYE,
			[10, 11],
			{ ...fine, step: 0.5 },
		);
		expect(r.az0).toBe(10);
		expect(r.step).toBe(0.5);
		expect(r.crests).toHaveLength(3);
		expect(r.crests.map((c) => c[0].az)).toEqual([10, 10.5, 11]);
		expect(r.stats.samples).toBe(3 * marchDistances(fine).length);
		// degenerate sector still yields one column
		expect(
			layeredHorizon(
				profile(() => -5),
				EYE,
				[5, 5],
				fine,
			).crests,
		).toHaveLength(1);
	});

	it('curvature "apply" lowers far terrain by d^2/(2 R_eff) and "frame" does not', () => {
		const h = profile(() => 0);
		const d = 20_000;
		const frame = layeredHorizon(h, EYE, [0, 0], { ...fine, maxD: d });
		const apply = layeredHorizon(h, EYE, [0, 0], {
			...fine,
			maxD: d,
			curvature: "apply",
		});
		const f = frame.crests[0][0];
		const a = apply.crests[0][0];
		expect(f.world[2]).toBe(0);
		const rEff = EARTH_R / (1 - REFRACTION_K);
		expect(a.world[2]).toBeCloseTo(-(a.d * a.d) / (2 * rEff), 9);
	});

	it("copies the eye and passes ENU coordinates to the height function", () => {
		const seen: number[][] = [];
		const eye: [number, number, number] = [100, 200, 5];
		const r = layeredHorizon(
			(e, n, d) => {
				seen.push([e, n, d]);
				return 0;
			},
			eye,
			[0, 0],
			{ ...fine, maxD: 300 },
		);
		eye[0] = -1;
		expect(r.eye).toEqual([100, 200, 5]);
		// azimuth 0 is north: e stays, n grows by d
		for (const [e, n, d] of seen) {
			expect(e).toBeCloseTo(100, 9);
			expect(n).toBeCloseTo(200 + d, 9);
		}
	});
});
