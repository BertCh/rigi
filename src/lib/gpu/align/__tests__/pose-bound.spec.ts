// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { dirTable, fgInRange } from "../pose-bound";

describe("dirTable", () => {
	it("expands xyz triples to vec4 rows, w = 0", () => {
		const t = dirTable(Float32Array.from([1, 2, 3, 4, 5, 6]));
		expect(Array.from(t)).toEqual([1, 2, 3, 0, 4, 5, 6, 0]);
	});
	it("ignores a trailing partial triple and never returns empty", () => {
		expect(dirTable(Float32Array.from([1, 2, 3, 9])).length).toBe(4);
		expect(dirTable(new Float32Array(0)).length).toBe(4);
	});
	it("caches per source array", () => {
		const d = Float32Array.from([1, 0, 0]);
		expect(dirTable(d)).toBe(dirTable(d));
	});
});

describe("fgInRange", () => {
	it("accepts values in [0, 1]", () => {
		expect(fgInRange(Float32Array.from([0, 0.5, 1]))).toBe(true);
		expect(fgInRange(new Float32Array(0))).toBe(true);
	});
	it("rejects out-of-range and NaN", () => {
		expect(fgInRange(Float32Array.from([0.5, 1.0001]))).toBe(false);
		expect(fgInRange(Float32Array.from([-0.001]))).toBe(false);
		expect(fgInRange(Float32Array.from([Number.NaN]))).toBe(false);
	});
});
