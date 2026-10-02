// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { seededRandom } from "#/test/helpers";
import { decodeTerrarium, MIN_VALID, NO_DATA, validateTile } from "../decode";

const px = (h: number) => {
	const v = h + 32768;
	const r = Math.floor(v / 256);
	const g = Math.floor(v - r * 256);
	const b = Math.round((v - r * 256 - g) * 256);
	return [r, g, b, 255];
};

describe("decodeTerrarium", () => {
	it("decodes h = R*256 + G + B/256 - 32768", () => {
		const out = decodeTerrarium(new Uint8Array([200, 10, 128, 255]));
		expect(out[0]).toBeCloseTo(200 * 256 + 10 + 0.5 - 32768, 6);
	});
	it("round-trips encoded heights to 1/256 m", () => {
		const rand = seededRandom(3);
		const hs = Array.from({ length: 50 }, () => rand() * 4800 + 1);
		const out = decodeTerrarium(new Uint8Array(hs.flatMap(px)));
		hs.forEach((h, i) => {
			expect(Math.abs(out[i] - h)).toBeLessThanOrEqual(1 / 256);
		});
	});
	it("clamps bathymetry above the deepest ocean to sea level", () => {
		const out = decodeTerrarium(new Uint8Array(px(-3600)));
		expect(out[0]).toBe(0);
	});
	it("keeps encoding-floor (no data) values below MIN_VALID", () => {
		const out = decodeTerrarium(new Uint8Array([0, 0, 0, 255]));
		expect(out[0]).toBe(NO_DATA);
		expect(out[0]).toBeLessThan(MIN_VALID);
	});
	it("returns one height per pixel, empty for empty input", () => {
		expect(decodeTerrarium(new Uint8Array(16)).length).toBe(4);
		expect(decodeTerrarium(new Uint8Array(0)).length).toBe(0);
	});
});

function ramp(size: number) {
	const h = new Float32Array(size * size);
	for (let y = 0; y < size; y++)
		for (let x = 0; x < size; x++) h[y * size + x] = 1000 + 3 * x + 2 * y;
	return h;
}

describe("validateTile", () => {
	it("leaves a smooth tile untouched", () => {
		const h = ramp(16);
		const copy = Float32Array.from(h);
		const v = validateTile(h, 16);
		expect(v).toEqual({ jumps: 0, repaired: 0, filled: 0, remaining: 0 });
		expect(Array.from(h)).toEqual(Array.from(copy));
	});
	it("fills out-of-range pixels from the neighbour median", () => {
		const h = ramp(8);
		const expected = h[3 * 8 + 3];
		h[3 * 8 + 3] = NO_DATA;
		const v = validateTile(h, 8);
		expect(v.filled).toBe(1);
		// neighbours of a plane: the median equals the centre value
		expect(h[3 * 8 + 3]).toBeCloseTo(expected, 4);
	});
	it("fills NaN and above-9000 values too", () => {
		const h = ramp(8);
		h[10] = Number.NaN;
		h[20] = 12000;
		expect(validateTile(h, 8).filled).toBe(2);
		expect(Number.isFinite(h[10])).toBe(true);
		expect(h[20]).toBeLessThan(9000);
	});
	it("an all-invalid tile becomes NO_DATA", () => {
		const h = new Float32Array(9).fill(NO_DATA);
		const v = validateTile(h, 3);
		expect(v.filled).toBe(9);
		expect(Array.from(h).every((x) => x === NO_DATA)).toBe(true);
	});
	it("repairs a patch that is off by exactly +256 m", () => {
		const size = 32;
		const h = ramp(size);
		const orig = Float32Array.from(h);
		for (let y = 10; y < 14; y++)
			for (let x = 10; x < 14; x++) h[y * size + x] += 256;
		const v = validateTile(h, size, 200, 40);
		expect(v.jumps).toBeGreaterThan(0);
		expect(v.repaired).toBe(16);
		expect(v.remaining).toBe(0);
		for (let i = 0; i < h.length; i++) expect(h[i]).toBeCloseTo(orig[i], 4);
	});
	it("repairs a -512 m patch (k = -2)", () => {
		const size = 32;
		const h = ramp(size);
		const orig = Float32Array.from(h);
		for (let y = 4; y < 8; y++)
			for (let x = 20; x < 24; x++) h[y * size + x] -= 512;
		validateTile(h, size);
		for (let i = 0; i < h.length; i++) expect(h[i]).toBeCloseTo(orig[i], 4);
	});
	it("leaves a real cliff (not a multiple of 256) alone", () => {
		const size = 16;
		const h = ramp(size);
		for (let y = 0; y < size; y++)
			for (let x = 8; x < size; x++) h[y * size + x] += 400;
		const copy = Float32Array.from(h);
		const v = validateTile(h, size);
		expect(v.repaired).toBe(0);
		expect(Array.from(h)).toEqual(Array.from(copy));
	});
	it("does not shift the largest component", () => {
		const size = 16;
		const h = ramp(size);
		// the right half is 256 higher: both halves are big, the larger wins (left, 9 cols)
		for (let y = 0; y < size; y++)
			for (let x = 9; x < size; x++) h[y * size + x] += 256;
		const v = validateTile(h, size);
		// the smaller component is > N/4 so it is not repaired (could be a real feature)
		expect(v.repaired).toBe(0);
	});
});
