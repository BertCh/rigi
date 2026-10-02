// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { ridgeTopsFromTD } from "../ridges";

describe("ridgeTopsFromTD", () => {
	it("converts tangent to degrees and passes distance through", () => {
		const { top, topD } = ridgeTopsFromTD(
			Float32Array.from([1, 500, 0, 1200]),
			2,
		);
		expect(top[0]).toBeCloseTo(45, 5);
		expect(top[1]).toBe(0);
		expect(Array.from(topD)).toEqual([500, 1200]);
	});
	it("maps the no-data sentinel to -Infinity", () => {
		const { top } = ridgeTopsFromTD(Float32Array.from([-3.4e38, 0, -1, 10]), 2);
		expect(top[0]).toBe(Number.NEGATIVE_INFINITY);
		expect(top[1]).toBeCloseTo(-45, 5);
	});
	it("only reads the first n pairs", () => {
		const { top, topD } = ridgeTopsFromTD(Float32Array.from([1, 2, 3, 4]), 1);
		expect(top.length).toBe(1);
		expect(topD.length).toBe(1);
	});
});
