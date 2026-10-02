// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { decimateRange, decimationStep } from "../drape-clear";

describe("decimationStep", () => {
	it("is 1 up to the fit size and ceil(long / fit) above it", () => {
		expect(decimationStep(100, 50)).toBe(1);
		expect(decimationStep(256, 256)).toBe(1);
		expect(decimationStep(257, 100)).toBe(2);
		expect(decimationStep(1024, 768)).toBe(4);
		expect(decimationStep(768, 1025)).toBe(5);
		expect(decimationStep(1000, 10, 100)).toBe(10);
	});
});

describe("decimateRange", () => {
	it("samples the nearest texel at the stride and zeroes non-finite values", () => {
		const w = 8;
		const h = 6;
		const data = new Float32Array(w * h).map((_, i) => i + 1);
		data[0] = Number.POSITIVE_INFINITY;
		data[2 * w + 4] = Number.NaN;
		const g = decimateRange(data, w, h, 4); // step 2 -> 4 x 3
		expect(g.w).toBe(4);
		expect(g.h).toBe(3);
		expect(g.data[0]).toBe(0);
		expect(g.data[1]).toBe(data[2]);
		expect(g.data[1 * 4 + 2]).toBe(0);
		expect(g.data[2 * 4 + 3]).toBe(data[4 * w + 6]);
	});
	it("is the identity (sans non-finite) when the map already fits", () => {
		const d = new Float32Array([1, 2, Number.POSITIVE_INFINITY, 4]);
		const g = decimateRange(d, 2, 2);
		expect([g.w, g.h, ...g.data]).toEqual([2, 2, 1, 2, 0, 4]);
	});
	it("floors a ragged size", () => {
		const g = decimateRange(new Float32Array(9 * 5).fill(3), 9, 5, 4);
		expect([g.w, g.h]).toEqual([3, 1]);
	});
});
