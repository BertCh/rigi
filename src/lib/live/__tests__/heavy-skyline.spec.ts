// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { skylineToScan } from "../heavy-skyline";

describe("skylineToScan", () => {
	it("decimates both axes together, scales rows, keeps the strongest column and zeroes holes", () => {
		const width = 1024;
		const height = 768;
		const rows = new Float32Array(width).fill(400);
		const weight = new Float32Array(width).fill(0.5);
		rows[1] = 100; // group 0 (g = 3): strongest
		weight[1] = 0.9;
		rows.fill(Number.NaN, 6, 9); // group 2 has no skyline
		const scan = skylineToScan({ width, height, rows, weight }, 320);
		expect(scan.width).toBe(341);
		expect(scan.height).toBe(256);
		expect(scan.rows[0]).toBeCloseTo((100 * 256) / 768, 4);
		expect(scan.weights[0]).toBeCloseTo(0.9, 6);
		expect(Number.isNaN(scan.rows[2])).toBe(true);
		expect(scan.weights[2]).toBe(0);
		expect(scan.rows[10]).toBeCloseTo((400 * 256) / 768, 4);
	});
});
