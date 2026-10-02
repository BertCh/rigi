// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { fuseSkylines, rejectSpikes, type SkylineLike } from "../skyline-clean";

const W = 200;
const Hh = 100;
const sky = (
	rows: (x: number) => number,
	weight: (x: number) => number = () => 1,
): SkylineLike => ({
	width: W,
	height: Hh,
	rows: Float32Array.from({ length: W }, (_, x) => rows(x)),
	weight: Float32Array.from({ length: W }, (_, x) => weight(x)),
});

describe("rejectSpikes", () => {
	it("zeroes a narrow upward spike and leaves the rest untouched", () => {
		const s = sky((x) => (x >= 100 && x < 103 ? 40 : 60));
		const r = rejectSpikes(s);
		for (let x = 0; x < W; x++)
			expect(r.weight[x]).toBe(x >= 100 && x < 103 ? 0 : 1);
		expect(Array.from(r.rows)).toEqual(Array.from(s.rows as ArrayLike<number>));
	});
	it("keeps wide excursions (real mountains)", () => {
		const s = sky((x) => (x >= 80 && x < 120 ? 40 : 60));
		const r = rejectSpikes(s);
		expect(Array.from(r.weight).every((w) => w === 1)).toBe(true);
	});
	it("ignores downward notches and small rises", () => {
		const down = rejectSpikes(sky((x) => (x === 100 ? 80 : 60)));
		expect(down.weight[100]).toBe(1);
		const small = rejectSpikes(sky((x) => (x === 100 ? 58 : 60)));
		expect(small.weight[100]).toBe(1);
	});
	it("does not mutate the input and handles all-NaN rows", () => {
		const s = sky((x) => (x === 100 ? 40 : 60));
		rejectSpikes(s);
		expect(s.weight[100]).toBe(1);
		const nan = rejectSpikes(sky(() => Number.NaN));
		expect(nan.rows).toHaveLength(W);
		expect(Array.from(nan.weight).every((w) => w === 1)).toBe(true);
	});
	it("respects maxWidth", () => {
		const s = sky((x) => (x >= 100 && x < 110 ? 40 : 60));
		expect(rejectSpikes(s, { maxWidth: 0.02 }).weight[105]).toBe(1);
		expect(rejectSpikes(s, { maxWidth: 0.1 }).weight[105]).toBe(0);
	});
});

describe("fuseSkylines", () => {
	it("keeps agreeing columns with the product of weights, zeroes disagreement", () => {
		const a = sky(
			() => 50,
			() => 0.8,
		);
		const b = sky(
			(x) => (x < 100 ? 50.5 : 70),
			() => 0.5,
		);
		const f = fuseSkylines(a, b);
		expect(f.weight[10]).toBeCloseTo(0.4, 6);
		expect(f.weight[150]).toBe(0);
		expect(f.rows[150]).toBe(50);
	});
	it("a missing secondary boundary zeroes the column unless missingFactor is set", () => {
		const a = sky(() => 50);
		const b = sky((x) => (x < 100 ? 50 : Number.NaN));
		expect(fuseSkylines(a, b).weight[150]).toBe(0);
		expect(fuseSkylines(a, b, { missingFactor: 0.5 }).weight[150]).toBe(0.5);
	});
	it("above/below factors apply by the sign of the disagreement", () => {
		const a = sky((x) => (x < 100 ? 40 : 60));
		const b = sky(() => 50);
		const f = fuseSkylines(a, b, { aboveFactor: 0.25, belowFactor: 0.75 });
		expect(f.weight[10]).toBe(0.25); // primary above (smaller row)
		expect(f.weight[150]).toBe(0.75);
	});
	it("resamples a secondary of a different size", () => {
		const a = sky(() => 50);
		const b: SkylineLike = {
			width: W / 2,
			height: Hh / 2,
			rows: new Float32Array(W / 2).fill(25),
			weight: new Float32Array(W / 2).fill(1),
		};
		const f = fuseSkylines(a, b);
		expect(Array.from(f.weight).every((w) => w === 1)).toBe(true);
	});
	it("agreeFloor lets a zero-confidence secondary keep some weight", () => {
		const a = sky(() => 50);
		const b = sky(
			() => 50,
			() => 0.04,
		);
		// secondary weight < 0.05 counts as invalid => missing
		expect(fuseSkylines(a, b, { agreeFloor: 0.3 }).weight[10]).toBe(0);
		const b2 = sky(
			() => 50,
			() => 0.1,
		);
		expect(fuseSkylines(a, b2, { agreeFloor: 0.5 }).weight[10]).toBeCloseTo(
			0.5 + 0.5 * 0.1,
			6,
		);
	});
	it("columns invalid in the primary stay untouched", () => {
		const a = sky(
			() => Number.NaN,
			() => 0.7,
		);
		const f = fuseSkylines(
			a,
			sky(() => 50),
		);
		expect(f.weight[5]).toBeCloseTo(0.7, 6);
	});
});
