// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { N_BANDS } from "../../../look/color-stats";
import {
	finalizeBands,
	GROUPS,
	SRGB_LUT,
	statsParamWords,
	WG,
} from "../color-stats";

const make = (
	fill: (k: number, acc: Float64Array) => void,
	counts: number[],
) => {
	const acc = new Float64Array(N_BANDS * 12);
	for (let k = 0; k < N_BANDS; k++) fill(k, acc);
	return { acc, cnt: Uint32Array.from(counts) };
};

describe("statsParamWords", () => {
	it("is 24 bytes: w, h, thread count, hasFg, minRange (f32), minCount", () => {
		const b = statsParamWords(640, 480, true, 12.5, 7);
		expect(b.byteLength).toBe(24);
		expect(Array.from(new Uint32Array(b, 0, 4))).toEqual([
			640,
			480,
			GROUPS * WG,
			1,
		]);
		expect(new Float32Array(b, 16, 1)[0]).toBe(12.5);
		expect(new Uint32Array(b, 20, 1)[0]).toBe(7);
		expect(new Uint32Array(statsParamWords(1, 1, false, 0, 0), 0, 4)[3]).toBe(
			0,
		);
	});
});

describe("SRGB_LUT", () => {
	it("is the sRGB EOTF at the endpoints, monotone, and continuous at the knee", () => {
		expect(SRGB_LUT.length).toBe(256);
		expect(SRGB_LUT[0]).toBe(0);
		expect(SRGB_LUT[255]).toBeCloseTo(1, 6);
		for (let i = 1; i < 256; i++)
			expect(SRGB_LUT[i]).toBeGreaterThan(SRGB_LUT[i - 1]);
		expect(SRGB_LUT[128]).toBeCloseTo(0.2158605, 5);
	});
});

describe("finalizeBands", () => {
	const cntAll = Array(N_BANDS).fill(10);
	it("returns identity stats, invalid, when no band reaches minCount", () => {
		const { acc, cnt } = make(() => {}, Array(N_BANDS).fill(1));
		const s = finalizeBands(acc, cnt, 5);
		expect(s.valid).toBe(false);
		expect(Array.from(s.photoMean).every((v) => v === 0)).toBe(true);
		expect(Array.from(s.photoStd).every((v) => v === 1)).toBe(true);
		expect(s.count).toBe(cnt);
	});
	it("computes mean and std from the sums, with per-channel std floors", () => {
		const { acc, cnt } = make((k, a) => {
			const o = k * 12;
			// photo L: sum 20 (mean 2), sumsq 50 (var 1); photo a: constant 1 -> var 0 -> floored
			a[o] = 20;
			a[o + 3] = 50;
			a[o + 1] = 10;
			a[o + 4] = 10;
			a[o + 2] = 10;
			a[o + 5] = 10;
			a[o + 6] = 30; // layer L mean 3
			a[o + 9] = 90; // var 0
		}, cntAll);
		const s = finalizeBands(acc, cnt, 5);
		expect(s.valid).toBe(true);
		expect(s.photoMean[0]).toBeCloseTo(2, 12);
		expect(s.photoStd[0]).toBeCloseTo(1, 12);
		expect(s.photoStd[1]).toBeCloseTo(0.004, 6);
		expect(s.layerMean[0]).toBeCloseTo(3, 12);
		expect(s.layerStd[0]).toBeCloseTo(0.01, 6);
	});
	it("an empty band borrows the nearest trusted band (lower index wins ties)", () => {
		const counts = [10, 0, 10, 0];
		const { acc, cnt } = make((k, a) => {
			a[k * 12] = k === 0 ? 10 : k === 2 ? 60 : 0;
		}, counts);
		const s = finalizeBands(acc, cnt, 5);
		expect(s.valid).toBe(true);
		expect(s.photoMean[0]).toBeCloseTo(1, 12);
		expect(s.photoMean[1 * 3]).toBeCloseTo(1, 12); // band 1: tie between 0 and 2 -> lower
		expect(s.photoMean[2 * 3]).toBeCloseTo(6, 12);
		expect(s.photoMean[3 * 3]).toBeCloseTo(6, 12); // band 3 -> band 2
	});
});
