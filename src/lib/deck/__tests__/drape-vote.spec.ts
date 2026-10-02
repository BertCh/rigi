// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import {
	drapeSeenTexel,
	drapeSeenWeight,
	drapeSlack,
	MIN_SIN_INC,
} from "../drape-vote";

describe("drape vote", () => {
	it("slack grows as 1/sin(incidence) and is floored at MIN_SIN_INC", () => {
		const a = drapeSlack(1000, 0.5, 0.5, 1000);
		const b = drapeSlack(1000, 0.25, 0.5, 1000);
		expect(b / a).toBeCloseTo(2, 6);
		expect(drapeSlack(1000, 0, 0.5, 1000)).toBeCloseTo(
			drapeSlack(1000, MIN_SIN_INC, 0.5, 1000),
			9,
		);
	});
	it("a texel votes only when it has a range and r is within bias + slack", () => {
		expect(drapeSeenTexel(0, 100, 0)).toBe(0);
		expect(drapeSeenTexel(1000, 1000, 0)).toBe(1);
		expect(drapeSeenTexel(1000, 1100, 0)).toBe(0);
		expect(drapeSeenTexel(1000, 1100, 100)).toBe(1);
	});
	it("the weight is soft in both the vote and the people mask", () => {
		expect(drapeSeenWeight(1, 0, true)).toBe(1);
		expect(drapeSeenWeight(0.75, 0.5, true)).toBeCloseTo(0.5, 6);
		expect(drapeSeenWeight(1, 1, true)).toBe(0);
		expect(drapeSeenWeight(1, 1, false)).toBe(1);
		expect(drapeSeenWeight(0, 0, true)).toBe(0);
	});
});
