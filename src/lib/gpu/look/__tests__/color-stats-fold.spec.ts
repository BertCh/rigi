// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { STATS_VALUES } from "../color-stats.wgsl";
import {
	foldGroupKeys,
	STATS_BYTES,
	STATS_WORDS,
	statsFromWords,
	subgroupLayoutFailed,
} from "../color-stats-fold";
import { STATS_LAYOUT } from "../color-stats-fold.wgsl";

describe("foldGroupKeys", () => {
	it("keys partial i by its value index i % 52", () => {
		const keys = foldGroupKeys(5);
		expect(keys.length).toBe(5 * STATS_VALUES);
		expect(keys[0]).toBe(0);
		expect(keys[STATS_VALUES + 17]).toBe(17);
		expect(keys[5 * STATS_VALUES - 1]).toBe(STATS_VALUES - 1);
	});
	it("puts value j of every workgroup in group j, groups times each", () => {
		const groups = 4;
		const keys = foldGroupKeys(groups);
		const partial = Float32Array.from(
			{ length: groups * STATS_VALUES },
			(_, i) => i * 0.5,
		);
		const folded = new Float32Array(STATS_VALUES);
		keys.forEach((k, i) => {
			folded[k] += partial[i];
		});
		for (let j = 0; j < STATS_VALUES; j++) {
			let want = 0;
			for (let g = 0; g < groups; g++) want += partial[g * STATS_VALUES + j];
			expect(folded[j]).toBe(want);
		}
	});
});

describe("statsFromWords", () => {
	const words = (fill: (w: Float32Array) => void) => {
		const w = new Float32Array(STATS_WORDS);
		fill(w);
		return w.buffer;
	};
	it("is identity-like (0 means, 1 stds) when not valid, but keeps counts", () => {
		const s = statsFromWords(
			words((w) => {
				w[STATS_LAYOUT.count + 2] = 7;
				w[STATS_LAYOUT.photoMean] = 5;
			}),
		);
		expect(s.valid).toBe(false);
		expect(Array.from(s.count)).toEqual([0, 0, 7, 0]);
		expect(s.photoMean[0]).toBe(0);
		expect(s.photoStd[0]).toBe(1);
	});
	it("reads each block at its layout offset when valid", () => {
		const s = statsFromWords(
			words((w) => {
				w[STATS_LAYOUT.valid] = 1;
				w[STATS_LAYOUT.photoMean + 11] = 1.5;
				w[STATS_LAYOUT.photoStd + 0] = 2.5;
				w[STATS_LAYOUT.layerMean + 4] = 3.5;
				w[STATS_LAYOUT.layerStd + 11] = 4.5;
			}),
		);
		expect(s.valid).toBe(true);
		expect(s.photoMean[11]).toBe(1.5);
		expect(s.photoStd[0]).toBe(2.5);
		expect(s.layerMean[4]).toBe(3.5);
		expect(s.layerStd[11]).toBe(4.5);
		expect(s.photoMean.length).toBe(12);
	});
	it("rounds counts to integers", () => {
		const s = statsFromWords(words((w) => (w[STATS_LAYOUT.count] = 99.9999)));
		expect(s.count[0]).toBe(100);
	});
});

describe("subgroupLayoutFailed / sizes", () => {
	it("flags valid === -1 only", () => {
		const mk = (v: number) => {
			const w = new Float32Array(STATS_WORDS);
			w[STATS_LAYOUT.valid] = v;
			return w.buffer;
		};
		expect(subgroupLayoutFailed(mk(-1))).toBe(true);
		expect(subgroupLayoutFailed(mk(1))).toBe(false);
		expect(subgroupLayoutFailed(mk(0))).toBe(false);
	});
	it("STATS_BYTES is 4 per word", () => {
		expect(STATS_BYTES).toBe(STATS_WORDS * 4);
	});
});
