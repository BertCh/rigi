// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { STATS_VALUES } from "../color-stats.wgsl";
import {
	foldSelectionCsr,
	STATS_BYTES,
	STATS_WORDS,
	statsFromWords,
	subgroupLayoutFailed,
} from "../color-stats-fold";
import { STATS_LAYOUT } from "../color-stats-fold.wgsl";

describe("foldSelectionCsr", () => {
	it("is a 52-row CSR with one entry per (row, group)", () => {
		const groups = 5;
		const m = foldSelectionCsr(groups);
		expect(m.rows.length).toBe(STATS_VALUES + 1);
		expect(m.cols.length).toBe(STATS_VALUES * groups);
		expect(m.vals.every((v) => v === 1)).toBe(true);
		expect(m.rows[STATS_VALUES]).toBe(m.cols.length);
	});
	it("row j sums value j of every workgroup in workgroup order", () => {
		const groups = 3;
		const m = foldSelectionCsr(groups);
		for (const j of [0, 1, 17, STATS_VALUES - 1]) {
			const cols = Array.from(m.cols.slice(m.rows[j], m.rows[j + 1]));
			expect(cols).toEqual([0, 1, 2].map((g) => g * STATS_VALUES + j));
		}
	});
	it("multiplying by the matrix folds partials like a plain column sum", () => {
		const groups = 4;
		const m = foldSelectionCsr(groups);
		const partial = Float32Array.from(
			{ length: groups * STATS_VALUES },
			(_, i) => i * 0.5,
		);
		for (let j = 0; j < STATS_VALUES; j++) {
			let s = 0;
			for (let k = m.rows[j]; k < m.rows[j + 1]; k++)
				s += m.vals[k] * partial[m.cols[k]];
			let want = 0;
			for (let g = 0; g < groups; g++) want += partial[g * STATS_VALUES + j];
			expect(s).toBe(want);
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
