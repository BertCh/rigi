// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import {
	acceptsNeeded,
	binomialCdf,
	clopperPearsonLower,
	clopperPearsonUpper,
	LTT_GRID,
	learnThenTest,
	precisionLowerBound,
	riskAt,
	riskCoverage,
	type ScoredOutcome,
} from "../bounds";

describe("binomialCdf", () => {
	it("matches hand values and the edges", () => {
		expect(binomialCdf(0, 10, 0.1)).toBeCloseTo(0.9 ** 10, 12);
		// P(X ≤ 1; 4, 0.5) = (1 + 4) / 16
		expect(binomialCdf(1, 4, 0.5)).toBeCloseTo(5 / 16, 12);
		expect(binomialCdf(-1, 5, 0.3)).toBe(0);
		expect(binomialCdf(5, 5, 0.3)).toBe(1);
		expect(binomialCdf(2, 5, 0)).toBe(1);
		expect(binomialCdf(2, 5, 1)).toBe(0);
	});
	it("is monotone decreasing in p", () => {
		let prev = 1;
		for (let p = 0.01; p < 1; p += 0.01) {
			const v = binomialCdf(3, 20, p);
			expect(v).toBeLessThanOrEqual(prev + 1e-12);
			prev = v;
		}
	});
});

describe("Clopper-Pearson bounds", () => {
	it("zero events: 1 − alpha^(1/n), near the rule of three", () => {
		expect(clopperPearsonUpper(0, 17)).toBeCloseTo(1 - 0.05 ** (1 / 17), 12);
		expect(clopperPearsonUpper(0, 100)).toBeGreaterThan(0.029);
		expect(clopperPearsonUpper(0, 100)).toBeLessThan(0.031);
	});
	it("inverts the binomial cdf at the bound", () => {
		for (const [k, n] of [
			[1, 10],
			[2, 24],
			[5, 50],
		]) {
			const u = clopperPearsonUpper(k, n);
			expect(binomialCdf(k, n, u)).toBeCloseTo(0.05, 6);
		}
	});
	it("no evidence and all events give the trivial bound", () => {
		expect(clopperPearsonUpper(0, 0)).toBe(1);
		expect(clopperPearsonUpper(4, 4)).toBe(1);
		expect(clopperPearsonLower(0, 9)).toBe(0);
		expect(clopperPearsonLower(3, 0)).toBe(0);
	});
	it("lower bound on precision: 17/17 is not 'precision 1.00'", () => {
		const lb = precisionLowerBound(17, 17);
		expect(lb).toBeCloseTo(0.05 ** (1 / 17), 12);
		expect(lb).toBeLessThan(0.85);
		expect(precisionLowerBound(15, 17)).toBeLessThan(lb);
	});
	it("sizes an evaluation set", () => {
		expect(acceptsNeeded(0.95)).toBe(59);
		expect(acceptsNeeded(0.9)).toBe(29);
		// one wrong accept costs a lot of sample size
		expect(acceptsNeeded(0.95, 0.05, 1)).toBeGreaterThan(90);
	});
});

describe("riskCoverage", () => {
	const rows: ScoredOutcome[] = [
		{ score: 0.9, correct: true },
		{ score: 0.8, correct: true },
		{ score: 0.8, correct: false },
		{ score: 0.4, correct: null },
		{ score: null, correct: true },
		{ score: Number.NaN, correct: true },
	];
	it("one point per distinct score, ties merged, unscored never accepted", () => {
		const c = riskCoverage(rows);
		expect(c.map((p) => p.threshold)).toEqual([0.9, 0.8, 0.4]);
		expect(c.map((p) => p.accepted)).toEqual([1, 3, 4]);
		// unsure counts as wrong
		expect(c.map((p) => p.wrong)).toEqual([0, 1, 2]);
		expect(c[2].coverage).toBeCloseTo(4 / 6, 12);
		expect(c[1].risk).toBeCloseTo(1 / 3, 12);
		for (const p of c) expect(p.riskUpper).toBeGreaterThanOrEqual(p.risk);
	});
	it("empty input", () => {
		expect(riskCoverage([])).toEqual([]);
	});
});

describe("riskAt", () => {
	it("agrees with the curve at its own thresholds", () => {
		const rows: ScoredOutcome[] = [
			{ score: 0.9, correct: true },
			{ score: 0.7, correct: false },
			{ score: 0.5, correct: true },
			{ score: null, correct: true },
		];
		for (const p of riskCoverage(rows))
			expect(riskAt(rows, p.threshold)).toEqual(p);
		expect(riskAt(rows, 2).accepted).toBe(0);
		expect(riskAt(rows, 2).riskUpper).toBe(1);
	});
});

describe("learnThenTest", () => {
	it("uses a fixed descending grid", () => {
		expect(LTT_GRID[0]).toBe(0.95);
		expect(LTT_GRID.at(-1)).toBe(0.05);
		for (let i = 1; i < LTT_GRID.length; i++)
			expect(LTT_GRID[i]).toBeLessThan(LTT_GRID[i - 1]);
	});
	it("certifies nothing on a handful of clean rows", () => {
		const few = Array.from({ length: 10 }, (_, i) => ({
			score: 1 - i / 20,
			correct: true,
		}));
		// P(X ≤ 0; ≤ 10, 0.05) ≥ 0.60 > 0.1: ten clean accepts do not certify 5% risk
		const r = learnThenTest(few, 0.05);
		expect(r.threshold).toBeNull();
		expect(r.tested).toBe(1);
	});
	it("stops at the first grid threshold that fails (fixed sequence)", () => {
		const rows: ScoredOutcome[] = [];
		for (let i = 0; i < 60; i++)
			rows.push({ score: 1 - i / 1000, correct: true });
		rows.push({ score: 0.5, correct: false });
		for (let i = 0; i < 5; i++)
			rows.push({ score: 0.4 - i / 100, correct: true });
		const r = learnThenTest(rows, 0.05);
		// 0.95: 50 clean accepts, 0.95^50 ≈ 0.077 ≤ 0.1 passes; down to 0.55 nothing changes;
		// 0.50 adds the wrong one: P(X ≤ 1; 61, 0.05) ≈ 0.18 > 0.1 stops the walk
		expect(r.threshold).toBe(0.55);
		expect(r.point?.accepted).toBe(60);
		expect(r.point?.wrong).toBe(0);
		expect(r.tested).toBe(10);
	});
	it("a later clean stretch cannot rescue an earlier failure", () => {
		const rows: ScoredOutcome[] = [{ score: 0.99, correct: false }];
		for (let i = 0; i < 200; i++) rows.push({ score: 0.6, correct: true });
		expect(learnThenTest(rows, 0.05).threshold).toBeNull();
	});
});
