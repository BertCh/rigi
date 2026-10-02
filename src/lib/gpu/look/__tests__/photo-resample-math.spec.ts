// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import {
	boxFootprint,
	boxResampleRgba,
	MAX_TAPS_PER_AXIS,
	packedRowWords,
	srgbDecodeByte,
	srgbEncodeByte,
	tapStride,
} from "../photo-resample-math";

describe("boxFootprint", () => {
	it("tiles the source exactly for an integer downscale", () => {
		expect(boxFootprint(0, 4, 16)).toEqual([0, 4]);
		expect(boxFootprint(3, 4, 16)).toEqual([12, 16]);
	});
	it("covers non-integer scales without gaps", () => {
		let prev = 0;
		for (let i = 0; i < 7; i++) {
			const [a, b] = boxFootprint(i, 7, 20);
			expect(a).toBe(prev);
			expect(b).toBeGreaterThan(a);
			prev = b;
		}
		expect(prev).toBe(20);
	});
	it("is nearest for an upscale and stays in range", () => {
		for (let i = 0; i < 10; i++) {
			const [a, b] = boxFootprint(i, 10, 3);
			expect(b - a).toBe(1);
			expect(b).toBeLessThanOrEqual(3);
		}
	});
});

describe("tapStride / packedRowWords", () => {
	it("bounds taps per axis", () => {
		expect(tapStride(1)).toBe(1);
		expect(tapStride(MAX_TAPS_PER_AXIS)).toBe(1);
		expect(tapStride(MAX_TAPS_PER_AXIS + 1)).toBe(2);
		expect(Math.ceil(100 / tapStride(100))).toBeLessThanOrEqual(
			MAX_TAPS_PER_AXIS,
		);
	});
	it("pads rows to 256 bytes", () => {
		expect(packedRowWords(64)).toBe(64);
		expect(packedRowWords(65)).toBe(128);
		expect((packedRowWords(37) * 4) % 256).toBe(0);
	});
});

describe("sRGB bytes", () => {
	it("round-trips all 256 values", () => {
		for (let b = 0; b < 256; b++)
			expect(srgbEncodeByte(srgbDecodeByte(b))).toBe(b);
	});
});

describe("boxResampleRgba", () => {
	it("averages a 2x2 block and sets alpha 255", () => {
		const src = new Uint8Array(16);
		const px = [10, 20, 30, 41];
		for (let i = 0; i < 4; i++) src.set([px[i], px[i], px[i], 0], i * 4);
		const out = boxResampleRgba(src, 2, 2, 1, 1);
		expect([...out]).toEqual([25, 25, 25, 255]); // (10+20+30+41)/4 = 25.25
	});
	it("copies at equal size", () => {
		const src = Uint8Array.from([1, 2, 3, 9, 4, 5, 6, 9]);
		expect([...boxResampleRgba(src, 2, 1, 2, 1)]).toEqual([
			1, 2, 3, 255, 4, 5, 6, 255,
		]);
	});
});
