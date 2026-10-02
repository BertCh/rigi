// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { decimalYear, magneticDeclination } from "../declination";

// Published 2026.0 declinations (NOAA WMM2025, rounded). The compact degree-4 model is allowed 3.5 degrees
// everywhere and 1.5 degrees in the Alps, which is what it measured when written (worst case 2.7).
const REFERENCE: [string, number, number, number][] = [
	["Zurich", 47.4, 8.5, 3.8],
	["London", 51.5, -0.1, 1.2],
	["New York", 40.7, -74.0, -12.6],
	["Seattle", 47.6, -122.3, 15.0],
	["Sydney", -33.9, 151.2, 12.8],
	["Tokyo", 35.7, 139.7, -7.7],
	["Cape Town", -33.9, 18.4, -25.5],
	["Denver", 39.7, -105.0, 7.5],
];

describe("magneticDeclination", () => {
	for (const [name, lat, lon, expected] of REFERENCE) {
		it(`${name} within 3.5 degrees`, () => {
			expect(Math.abs(magneticDeclination(lat, lon, 2026))).toBeLessThan(40);
			expect(
				Math.abs(magneticDeclination(lat, lon, 2026) - expected),
			).toBeLessThan(3.5);
		});
	}

	it("is within 1.5 degrees in the Alps", () => {
		expect(Math.abs(magneticDeclination(46.7, 7.8, 2026) - 3.6)).toBeLessThan(
			1.5,
		);
	});

	it("is east positive in Europe and west negative in North America", () => {
		expect(magneticDeclination(47, 8, 2026)).toBeGreaterThan(0);
		expect(magneticDeclination(40.7, -74, 2026)).toBeLessThan(0);
	});

	it("is finite at the poles", () => {
		expect(Number.isFinite(magneticDeclination(90, 0, 2026))).toBe(true);
		expect(Number.isFinite(magneticDeclination(-90, 120, 2026))).toBe(true);
	});

	it("drifts slowly with time in the Alps", () => {
		const drift = Math.abs(
			magneticDeclination(46.7, 7.8, 2030) -
				magneticDeclination(46.7, 7.8, 2026),
		);
		expect(drift).toBeLessThan(1.5);
	});
});

describe("decimalYear", () => {
	it("is the year plus the elapsed fraction", () => {
		expect(decimalYear(new Date(Date.UTC(2026, 0, 1)))).toBe(2026);
		expect(decimalYear(new Date(Date.UTC(2026, 6, 2, 12)))).toBeCloseTo(
			2026.5,
			2,
		);
	});
});
