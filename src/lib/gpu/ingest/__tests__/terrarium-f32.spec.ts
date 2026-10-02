// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { seededRandom } from "#/test/helpers";
import {
	decodeTileStats,
	inexactPartial,
	terrariumF32,
	terrariumTileF32,
	unormToByte,
} from "../terrarium-f32";

describe("terrariumF32", () => {
	it("decodes the Terrarium formula", () => {
		expect(terrariumF32(128, 0, 0)).toBe(0);
		expect(terrariumF32(129, 0, 0)).toBe(256);
		expect(terrariumF32(128, 1, 128)).toBe(1.5);
		expect(terrariumF32(130, 5, 64)).toBe(512 + 5 + 0.25);
	});
	it("clamps slightly negative sea samples to 0 but keeps real depressions", () => {
		expect(terrariumF32(127, 255, 128)).toBe(0); // -0.5 → 0
		expect(terrariumF32(127, 0, 0)).toBe(0); // -256 -> 0
		expect(terrariumF32(0, 0, 0)).toBe(-32768); // below SEA_FLOOR kept
	});
	it("matches the f64 formula for plausible heights", () => {
		const rand = seededRandom(7);
		for (let i = 0; i < 500; i++) {
			const r = 128 + Math.floor(rand() * 40);
			const g = Math.floor(rand() * 256);
			const b = Math.floor(rand() * 256);
			const exact = r * 256 + g + b / 256 - 32768;
			expect(terrariumF32(r, g, b)).toBe(
				exact < 0 && exact > -12000 ? 0 : exact,
			);
		}
	});
});

describe("unormToByte / inexactPartial", () => {
	it("round-trips every byte through unorm", () => {
		for (let k = 0; k < 256; k++)
			expect(unormToByte(Math.fround(k / 255))).toBe(k);
	});
	it("reports null for typical texels", () => {
		expect(inexactPartial(130, 17, 99)).toBeNull();
	});
});

describe("decodeTileStats", () => {
	it("reads the invalid count and the f32 extents", () => {
		const words = new Uint32Array(5);
		const f32 = new Float32Array(words.buffer);
		words[0] = 3;
		f32[1] = -5;
		f32[2] = 100.5;
		f32[3] = -2;
		f32[4] = 90;
		expect(decodeTileStats(words)).toEqual({
			invalid: 3,
			lo: -5,
			hi: 100.5,
			lo7: -2,
			hi7: 90,
		});
	});
});

describe("terrariumTileF32", () => {
	const tile = (S: number, fn: (x: number, y: number) => number) => {
		const rgba = new Uint8Array(S * S * 4);
		for (let y = 0; y < S; y++)
			for (let x = 0; x < S; x++) {
				const h = fn(x, y) + 32768;
				const o = (y * S + x) * 4;
				rgba[o] = Math.floor(h / 256);
				rgba[o + 1] = Math.floor(h) % 256;
				rgba[o + 2] = Math.round((h - Math.floor(h)) * 256) % 256;
				rgba[o + 3] = 255;
			}
		return rgba;
	};
	it("down 1 reproduces heights and stats", () => {
		const rgba = tile(4, (x, y) => 1000 + x * 10 + y);
		const { heights, words } = terrariumTileF32(rgba, 4, 1);
		expect(heights[0]).toBe(1000);
		expect(heights[15]).toBe(1033);
		const s = decodeTileStats(words);
		expect(s.invalid).toBe(0);
		expect(s.lo).toBe(1000);
		expect(s.hi).toBe(1033);
	});
	it("down 2 box-averages 2x2 blocks", () => {
		const rgba = tile(4, (x, y) => (x < 2 ? 100 : 300) + y * 4);
		const { heights } = terrariumTileF32(rgba, 4, 2);
		expect(heights.length).toBe(4);
		expect(Array.from(heights)).toEqual([102, 302, 110, 310]);
	});
	it("counts samples outside the valid range", () => {
		const rgba = tile(2, (x) => (x === 0 ? 9500 : 100));
		const { words } = terrariumTileF32(rgba, 2, 1);
		expect(words[0]).toBe(2);
	});
});
