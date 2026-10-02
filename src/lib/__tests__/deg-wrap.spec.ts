// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { DEG, wrap180, wrap360 } from "../geodesy";
import { DEG as quantityDeg } from "../ontology/core/quantity";

const GRID = [
	0,
	-0,
	1,
	-1,
	0.5,
	-0.5,
	179.999,
	180,
	-180,
	180.001,
	-180.001,
	359.999,
	360,
	-360,
	360.001,
	540,
	-540,
	720,
	-720,
	1e6 + 0.37,
	-1e6 - 0.37,
	123456.789,
	-98765.4321,
];

describe("DEG", () => {
	it("is one binding equal to Math.PI / 180", () => {
		expect(DEG).toBe(Math.PI / 180);
		expect(quantityDeg).toBe(DEG);
	});
});

describe("wrap360 / wrap180", () => {
	it("match the inline modulo forms bit for bit", () => {
		for (const x of GRID) {
			expect(Object.is(wrap360(x), ((x % 360) + 360) % 360)).toBe(true);
			expect(
				Object.is(wrap180(x), ((((x + 180) % 360) + 360) % 360) - 180),
			).toBe(true);
		}
	});
	it("wrap360 is [0, 360) and wrap180 is [-180, 180)", () => {
		for (const x of GRID) {
			expect(wrap360(x)).toBeGreaterThanOrEqual(0);
			expect(wrap360(x)).toBeLessThan(360);
			expect(wrap180(x)).toBeGreaterThanOrEqual(-180);
			expect(wrap180(x)).toBeLessThan(180);
		}
	});
});
