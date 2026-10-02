// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { DEG, EARTH_R } from "../../../geodesy";
import { groundFromHeightAt, offsetLatLon } from "../ground";

describe("offsetLatLon", () => {
	it("is the identity for a zero offset", () => {
		expect(offsetLatLon(46.7, 7.8, 0, 0)).toEqual({ lat: 46.7, lon: 7.8 });
	});
	it("moves north by dN metres of arc and east by dE scaled by cos(lat)", () => {
		const p = offsetLatLon(46.7, 7.8, 0, 111_194.9);
		expect(p.lat - 46.7).toBeCloseTo(111_194.9 / EARTH_R / DEG, 9);
		expect(p.lon).toBe(7.8);
		const q = offsetLatLon(60, 10, 1000, 0);
		expect(q.lon - 10).toBeCloseTo(
			1000 / (EARTH_R * Math.cos(60 * DEG)) / DEG,
			9,
		);
		// at 60 deg north one metre east spans twice the longitude of the equator
		const eq = offsetLatLon(0, 10, 1000, 0);
		expect((q.lon - 10) / (eq.lon - 10)).toBeCloseTo(2, 6);
	});
	it("is antisymmetric", () => {
		const a = offsetLatLon(46, 8, 200, -300);
		const b = offsetLatLon(46, 8, -200, 300);
		expect(a.lat - 46).toBeCloseTo(-(b.lat - 46), 12);
		expect(a.lon - 8).toBeCloseTo(-(b.lon - 8), 12);
	});
});

describe("groundFromHeightAt", () => {
	it("samples the height function at the offset position", () => {
		const slope = (lat: number, lon: number) =>
			1000 + (lat - 46) * 1e5 + (lon - 8) * 1e4;
		const g = groundFromHeightAt(46, 8, slope);
		expect(g(0, 0)).toBeCloseTo(1000, 6);
		const north = g(0, 1000);
		expect(north).toBeGreaterThan(g(0, 0));
		expect(north).toBeCloseTo(1000 + (1000 / EARTH_R / DEG) * 1e5, 6);
	});
	it("maps missing and non-finite heights to NaN", () => {
		expect(groundFromHeightAt(46, 8, () => null)(1, 1)).toBeNaN();
		expect(groundFromHeightAt(46, 8, () => undefined)(1, 1)).toBeNaN();
		expect(
			groundFromHeightAt(46, 8, () => Number.POSITIVE_INFINITY)(1, 1),
		).toBeNaN();
		expect(groundFromHeightAt(46, 8, () => 0)(1, 1)).toBe(0);
	});
});
