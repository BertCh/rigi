// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import {
	decimalYear,
	magneticDeclination,
	magneticField,
} from "../declination";

// Official WMM2025 test values (NOAA NCEI WMM2025_TEST_VALUES.txt):
// [decimal year, height km, geodetic lat, lon, X nT, Y nT, Z nT, F nT, inclination deg, declination deg]
const OFFICIAL: [
	number,
	number,
	number,
	number,
	number,
	number,
	number,
	number,
	number,
	number,
][] = [
	[2025.0, 0.0, 80.0, 0.0, 6521.6, 145.9, 54791.5, 55178.5, 83.21, 1.28],
	[2025.0, 0.0, 0.0, 120.0, 39677.8, -109.6, -10580.2, 41064.3, -14.93, -0.16],
	[2025.0, 0.0, -80.0, 240.0, 6117.5, 15751.9, -52022.5, 54698.2, -72.0, 68.78],
	[2025.0, 100.0, 80.0, 0.0, 6216.0, 92.4, 52598.8, 52964.9, 83.26, 0.85],
	[2025.0, 100.0, 0.0, 120.0, 37688.6, -96.2, -10152.1, 39032.1, -15.08, -0.15],
	[
		2025.0, 100.0, -80.0, 240.0, 5907.6, 14780.3, -49540.7, 52035.0, -72.19,
		68.21,
	],
	[2027.5, 0.0, 80.0, 0.0, 6500.8, 294.5, 54869.4, 55253.9, 83.24, 2.59],
	[2027.5, 0.0, 0.0, 120.0, 39701.6, -167.4, -10381.8, 41036.9, -14.65, -0.24],
	[
		2027.5, 0.0, -80.0, 240.0, 6200.7, 15730.3, -51783.7, 54474.2, -71.92,
		68.49,
	],
	[2027.5, 100.0, 80.0, 0.0, 6196.7, 233.8, 52670.5, 53034.3, 83.29, 2.16],
	[2027.5, 100.0, 0.0, 120.0, 37711.5, -148.7, -9969.8, 39007.4, -14.81, -0.23],
	[
		2027.5, 100.0, -80.0, 240.0, 5984.0, 14760.1, -49317.7, 51825.7, -72.1,
		67.93,
	],
];

describe("magneticField against the official WMM2025 test values", () => {
	for (const [
		year,
		height,
		lat,
		lon,
		x,
		y,
		z,
		f,
		inclination,
		declination,
	] of OFFICIAL) {
		it(`${year} ${height} km ${lat}, ${lon}`, () => {
			const field = magneticField(lat, lon, year, height);
			expect(Math.abs(field.declination - declination)).toBeLessThanOrEqual(
				0.01,
			);
			expect(Math.abs(field.inclination - inclination)).toBeLessThanOrEqual(
				0.01,
			);
			// the published nT values are rounded to 0.1
			expect(Math.abs(field.north - x)).toBeLessThanOrEqual(0.2);
			expect(Math.abs(field.east - y)).toBeLessThanOrEqual(0.2);
			expect(Math.abs(field.down - z)).toBeLessThanOrEqual(0.2);
			expect(Math.abs(field.total - f)).toBeLessThanOrEqual(0.2);
		});
	}
});

describe("magneticDeclination", () => {
	it("is about 3.5 to 4 degrees east in Zurich in 2026", () => {
		const declination = magneticDeclination(47.4, 8.5, 2026);
		expect(declination).toBeGreaterThan(3);
		expect(declination).toBeLessThan(4.5);
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
