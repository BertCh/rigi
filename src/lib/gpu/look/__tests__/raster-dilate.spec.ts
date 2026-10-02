// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { dilationPasses, RASTER_MAX_RADIUS } from "../raster-dilate";

describe("dilationPasses", () => {
	it("is one copy pass for radius 0", () => {
		expect(dilationPasses(0)).toEqual([0]);
	});
	it("keeps every pass within gpu-raster's bound and sums to the radius", () => {
		for (let r = 1; r <= 40; r++) {
			const passes = dilationPasses(r);
			expect(passes.reduce((a, b) => a + b, 0)).toBe(r);
			for (const p of passes) {
				expect(p).toBeGreaterThanOrEqual(1);
				expect(p).toBeLessThanOrEqual(RASTER_MAX_RADIUS);
			}
		}
	});
	it("uses one pass up to 8", () => {
		expect(dilationPasses(8)).toEqual([8]);
		expect(dilationPasses(9)).toEqual([8, 1]);
	});
});
