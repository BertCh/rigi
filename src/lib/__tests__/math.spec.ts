// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { seededRandom } from "#/test/helpers";
import { clamp, clamp01, kthSmallest, smoothstep } from "../math";

describe("clamp", () => {
	it("limits to [lo, hi]", () => {
		expect(clamp(-1, 0, 2)).toBe(0);
		expect(clamp(1, 0, 2)).toBe(1);
		expect(clamp(3, 0, 2)).toBe(2);
	});
	it("passes NaN through", () => {
		expect(clamp(Number.NaN, 0, 1)).toBeNaN();
		expect(clamp01(Number.NaN)).toBeNaN();
	});
	it("clamp01 limits to [0, 1]", () => {
		expect(clamp01(-0.5)).toBe(0);
		expect(clamp01(0.25)).toBe(0.25);
		expect(clamp01(7)).toBe(1);
	});
});

describe("smoothstep", () => {
	it("matches GLSL at the edges and midpoint", () => {
		expect(smoothstep(0, 1, -1)).toBe(0);
		expect(smoothstep(0, 1, 0)).toBe(0);
		expect(smoothstep(0, 1, 0.5)).toBe(0.5);
		expect(smoothstep(0, 1, 1)).toBe(1);
		expect(smoothstep(0, 1, 2)).toBe(1);
	});
	it("is monotone between the edges", () => {
		let prev = -1;
		for (let x = 2; x <= 4; x += 0.01) {
			const y = smoothstep(2, 4, x);
			expect(y).toBeGreaterThanOrEqual(prev);
			prev = y;
		}
	});
});

describe("kthSmallest", () => {
	it("equals the sorted array's k-th element on random inputs", () => {
		const rand = seededRandom(42);
		for (let trial = 0; trial < 50; trial++) {
			const n = 1 + Math.floor(rand() * 200);
			const values = Float32Array.from({ length: n }, () =>
				Math.floor(rand() * 20 - 10),
			);
			const sorted = Float32Array.from(values).sort();
			const k = Math.floor(rand() * n);
			expect(kthSmallest(Float32Array.from(values), k)).toBe(sorted[k]);
		}
	});
	it("handles a single element", () => {
		expect(kthSmallest(Float32Array.of(3), 0)).toBe(3);
	});
});
