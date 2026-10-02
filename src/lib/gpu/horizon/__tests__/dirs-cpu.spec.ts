// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { GPU_COLUMNS } from "../dirs-cpu";

describe("GPU_COLUMNS", () => {
	it("has 8 renders of 1024 columns, all azimuths in [0, 360)", () => {
		expect(GPU_COLUMNS.length).toBe(8 * 1024);
		expect(GPU_COLUMNS.every((a) => a >= 0 && a < 360)).toBe(true);
	});
	it("each render is centred on its heading and spans about 50 degrees", () => {
		// render 2 is centred on 90 degrees
		const r = GPU_COLUMNS.slice(2 * 1024, 3 * 1024);
		expect(r[511] + (r[512] - r[511]) / 2).toBeCloseTo(90, 6);
		expect(r[1023] - r[0]).toBeGreaterThan(49);
		expect(r[1023] - r[0]).toBeLessThan(50);
	});
	it("columns are denser towards the render edges (tangent spacing)", () => {
		const r = GPU_COLUMNS.slice(3 * 1024, 4 * 1024);
		expect(r[1] - r[0]).toBeLessThan(r[513] - r[512]);
	});
	it("wraps render 0 below north", () => {
		expect(GPU_COLUMNS[0]).toBeGreaterThan(330);
		expect(GPU_COLUMNS[1023]).toBeLessThan(30);
	});
});
