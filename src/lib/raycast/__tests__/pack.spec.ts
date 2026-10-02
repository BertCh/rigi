// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { makeRayScene } from "../cpu";
import { packScene } from "../gpu";
import { RAYCAST_WGSL } from "../raycast.wgsl";
import { syntheticMosaic } from "./synthetic";

const EYE = { lat: 46.7, lon: 8.0, h: 800 };
const wgslConst = (name: string) =>
	Number(new RegExp(`const ${name}: u32 = (\\d+)u;`).exec(RAYCAST_WGSL)?.[1]);

describe("GPU scene packing", () => {
	const mosaics = [syntheticMosaic(EYE, 10, 30_000, () => 700, 28_000)];
	const S = makeRayScene(mosaics, EYE, { maxDistance: 28_000 });
	const set = {
		rings: [
			{
				page: 0,
				dataOff: 7,
				mipOff: [100, 200],
				minLevel: 2,
				mipWidths: [10, 5],
				mipHeights: [10, 5],
			},
		],
	} as unknown as Parameters<typeof packScene>[1];
	const { words, azOff } = packScene(S, set, [0, 90]);
	const f = new Float32Array(words.buffer);
	const i32 = new Int32Array(words.buffer);

	it("layout constants agree with the WGSL", () => {
		expect(wgslConst("OFF_SEG")).toBe(96);
		expect(wgslConst("OFF_RING")).toBe(1696);
		expect(wgslConst("RING_STRIDE")).toBe(48);
		expect(azOff).toBe(1696 + 48);
	});

	it("octave table: base, count, spacing", () => {
		for (let o = 0; o < S.octBase.length; o++) {
			expect(f[3 * o]).toBe(Math.fround(S.octBase[o]));
			expect(words[3 * o + 1]).toBe(S.octN[o]);
			expect(f[3 * o + 2]).toBe(Math.fround(S.octSp[o]));
		}
	});

	it("segments carry distance, sin D, 1 - cos D and the ring", () => {
		for (let i = 0; i < S.segD.length; i++) {
			const b = 96 + 4 * i;
			expect(f[b]).toBe(Math.fround(S.segD[i]));
			expect(f[b + 1]).toBe(Math.fround(S.segSin[i]));
			expect(f[b + 2]).toBe(Math.fround(S.segOmc[i]));
		}
	});

	it("ring record: window, eye position split, mip layout", () => {
		const b = 1696;
		const r = S.rings[0];
		expect(words[b + 2]).toBe(r.W);
		expect(words[b + 4]).toBe(r.H);
		expect(i32[b + 5] + f[b + 6]).toBeCloseTo(r.ue, 4);
		expect(i32[b + 7] + f[b + 8]).toBeCloseTo(r.ve, 4);
		expect(f[b + 9]).toBe(r.sx);
		expect(words[b + 10]).toBe(4);
		expect([words[b + 16], words[b + 17]]).toEqual([100, 200]);
		expect([words[b + 24], words[b + 33]]).toEqual([10, 5]);
	});

	it("azimuth table is sin / cos of the azimuth", () => {
		expect(f[azOff + 2]).toBeCloseTo(1, 7);
		expect(f[azOff + 3]).toBeCloseTo(0, 7);
	});
});
