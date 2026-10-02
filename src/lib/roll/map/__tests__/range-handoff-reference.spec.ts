// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { COARSE } from "../drape-atlas";
import {
	coarseSize,
	coarseWords,
	rangeCellWords,
	rangeKeepBits,
} from "../range-handoff-reference";

const bitsOf = (f: number) => new Uint32Array(new Float32Array([f]).buffer)[0];

describe("rangeKeepBits", () => {
	it("keeps 0 < r < +Infinity and zeroes everything else", () => {
		for (const f of [1, 0.5, 12345.678, 3.4028234663852886e38])
			expect(rangeKeepBits(bitsOf(f))).toBe(bitsOf(f));
		expect(rangeKeepBits(0x00000001)).toBe(1); // positive denormal stays
		for (const b of [
			0x00000000,
			0x80000000,
			0x7f800000,
			0xff800000,
			0x7fc00000,
			0xffc00000,
			0x7f800001,
			bitsOf(-3),
			0x80000001,
		])
			expect(rangeKeepBits(b)).toBe(0);
	});
});

describe("rangeCellWords / coarseWords", () => {
	it("picks the 4th word of each texel and max-pools over COARSE blocks", () => {
		const w = COARSE + 3;
		const h = COARSE + 1;
		const texels = new Uint32Array(w * h * 4);
		const f = new Float32Array(texels.buffer);
		for (let i = 0; i < w * h; i++) f[i * 4 + 3] = 0; // sky
		f[(0 * w + 2) * 4 + 3] = 7; // block (0,0)
		f[(3 * w + 5) * 4 + 3] = 9; // block (0,0)
		f[(COARSE * w + 1) * 4 + 3] = 4; // block (0,1), the clipped last row
		f[(2 * w + COARSE + 2) * 4 + 3] = 5; // block (1,0), the clipped last column
		f[(1 * w + 1) * 4 + 3] = Number.POSITIVE_INFINITY; // dropped
		const cell = rangeCellWords(texels, w, h);
		expect(cell[2]).toBe(bitsOf(7));
		expect(cell[w + 1]).toBe(0);
		const grid = coarseWords(cell, w, h);
		expect(coarseSize(w, h)).toEqual({ width: 2, height: 2 });
		expect(Array.from(new Float32Array(grid.buffer))).toEqual([9, 5, 4, 0]);
	});
});
