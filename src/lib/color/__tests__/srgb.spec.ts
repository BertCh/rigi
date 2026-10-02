// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { linearToSrgb, srgbToLinear } from "../srgb";

describe("srgb transfer curves", () => {
	it("hits the endpoints", () => {
		expect(srgbToLinear(0)).toBe(0);
		expect(srgbToLinear(1)).toBeCloseTo(1, 12);
		expect(linearToSrgb(0)).toBe(0);
		expect(linearToSrgb(1)).toBeCloseTo(1, 12);
	});

	it("matches known values", () => {
		expect(srgbToLinear(0.5)).toBeCloseTo(0.21404114, 8);
		expect(linearToSrgb(0.21404114)).toBeCloseTo(0.5, 7);
		expect(srgbToLinear(128 / 255)).toBeCloseTo(0.2158605, 7);
	});

	it("uses the linear segment below the knees", () => {
		expect(srgbToLinear(0.04045)).toBeCloseTo(0.04045 / 12.92, 12);
		expect(linearToSrgb(0.0031308)).toBeCloseTo(0.0031308 * 12.92, 12);
		expect(srgbToLinear(0.01)).toBe(0.01 / 12.92);
		expect(linearToSrgb(0.001)).toBe(0.001 * 12.92);
	});

	it("is continuous across the knees", () => {
		const eps = 1e-9;
		expect(srgbToLinear(0.04045 + eps) - srgbToLinear(0.04045)).toBeLessThan(
			1e-8,
		);
		expect(
			linearToSrgb(0.0031308 + eps) - linearToSrgb(0.0031308),
		).toBeLessThan(1e-7);
	});

	it("is monotonic and round-trips every byte", () => {
		let previous = -1;
		for (let byte = 0; byte < 256; byte++) {
			const linear = srgbToLinear(byte / 255);
			expect(linear).toBeGreaterThan(previous);
			previous = linear;
			expect(Math.round(linearToSrgb(linear) * 255)).toBe(byte);
		}
	});
});
