// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { type RgbaImage, scanColumnsCpu, scanHeight } from "../skyline-cpu";

function stepImage(
	width: number,
	height: number,
	rowAt: (x: number) => number,
) {
	const data = new Uint8Array(width * height * 4);
	for (let y = 0; y < height; y++)
		for (let x = 0; x < width; x++) {
			const sky = y < rowAt(x);
			const o = (y * width + x) * 4;
			data[o] = sky ? 180 : 40;
			data[o + 1] = sky ? 210 : 50;
			data[o + 2] = sky ? 250 : 30;
			data[o + 3] = 255;
		}
	return { width, height, data } as RgbaImage;
}

describe("scanColumnsCpu", () => {
	it("finds a flat sky/ground step to within half a pixel", () => {
		const img = stepImage(320, 180, () => 90);
		const scan = scanColumnsCpu(img, 320);
		expect(scan.height).toBe(scanHeight(320, 180, 320));
		for (let x = 0; x < 320; x += 17) {
			expect(Math.abs(scan.rows[x] - 90)).toBeLessThan(0.6);
			expect(scan.weights[x]).toBeGreaterThan(0.9);
		}
	});

	it("follows a sloped skyline across a reduced grid", () => {
		const img = stepImage(640, 360, (x) => 100 + x * 0.1);
		const scan = scanColumnsCpu(img, 320);
		// reduced rows are half the source rows
		for (let x = 10; x < 310; x += 23)
			expect(
				Math.abs(scan.rows[x] - (100 + (x * 2 + 1) * 0.1) / 2),
			).toBeLessThan(1);
	});

	it("gives low weight to a uniform frame", () => {
		const data = new Uint8Array(64 * 36 * 4).fill(128);
		const scan = scanColumnsCpu({ width: 64, height: 36, data }, 64);
		for (let x = 0; x < 64; x++) expect(scan.weights[x]).toBe(0);
	});
});
