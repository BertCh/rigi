// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { distanceBand, radiusBand, radiusFrac } from "../bands";

describe("distanceBand", () => {
	it("puts boundaries in the upper band", () => {
		expect(distanceBand(0)).toBe("<0.5km");
		expect(distanceBand(499.9)).toBe("<0.5km");
		expect(distanceBand(500)).toBe("0.5-2km");
		expect(distanceBand(1999)).toBe("0.5-2km");
		expect(distanceBand(2000)).toBe("2-5km");
		expect(distanceBand(5000)).toBe("5-15km");
		expect(distanceBand(14999)).toBe("5-15km");
		expect(distanceBand(15000)).toBe(">15km");
		expect(distanceBand(1e7)).toBe(">15km");
	});
});

describe("radiusFrac / radiusBand", () => {
	it("is 0 at the centre and 1 at every corner for any aspect", () => {
		for (const aspect of [0.5, 1, 1.5, 4 / 3, 3]) {
			expect(radiusFrac(0.5, 0.5, aspect)).toBe(0);
			for (const [u, v] of [
				[0, 0],
				[1, 0],
				[0, 1],
				[1, 1],
			])
				expect(radiusFrac(u, v, aspect)).toBeCloseTo(1, 12);
		}
	});
	it("is symmetric about the centre", () => {
		expect(radiusFrac(0.2, 0.3, 1.5)).toBeCloseTo(
			radiusFrac(0.8, 0.7, 1.5),
			12,
		);
	});
	it("bands centre < 0.35 <= mid < 0.7 <= corner", () => {
		expect(radiusBand(0.5, 0.5, 1.5)).toBe("centre");
		expect(
			radiusBand(0.5 + (0.34 * 0.5 * Math.hypot(1.5, 1)) / 1.5, 0.5, 1.5),
		).toBe("centre");
		expect(
			radiusBand(0.5 + (0.5 * Math.hypot(1.5, 1) * 0.5) / 1.5, 0.5, 1.5),
		).toBe("mid");
		expect(radiusBand(0, 0, 1.5)).toBe("corner");
		expect(radiusBand(1, 0.5, 1.5)).toBe("corner");
	});
});
