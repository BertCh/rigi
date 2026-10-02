// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { seededRandom, uniform } from "#/test/helpers";
import {
	computeConfidence,
	correlationLength,
	DEFAULT_THRESHOLDS,
} from "../confidence";
import { DEG, LOGF, NPARAM, PITCH, ROLL, YAW } from "../model";
import { madScale } from "../robust";

describe("correlationLength", () => {
	it("is 1 for short, constant, or white sequences", () => {
		expect(correlationLength([1, 2, 3])).toBe(1);
		expect(correlationLength(new Array(100).fill(4))).toBe(1);
		const r = seededRandom(1);
		const white = Array.from({ length: 2000 }, () => uniform(r, -1, 1));
		expect(correlationLength(white)).toBeLessThan(1.5);
	});
	it("grows with smoothness (moving-average noise)", () => {
		const r = seededRandom(2);
		const raw = Array.from({ length: 3000 }, () => uniform(r, -1, 1));
		const smooth = (w: number) =>
			raw.map((_, i) => {
				let s = 0;
				for (let j = 0; j < w; j++) s += raw[(i + j) % raw.length];
				return s / w;
			});
		const l5 = correlationLength(smooth(5));
		const l20 = correlationLength(smooth(20));
		expect(l5).toBeGreaterThan(2);
		expect(l20).toBeGreaterThan(l5);
	});
	it("is bounded above by n / 5 and below by 1", () => {
		const slow = Array.from({ length: 50 }, (_, i) => i);
		expect(correlationLength(slow)).toBeLessThanOrEqual(10);
		expect(correlationLength(slow)).toBeGreaterThanOrEqual(1);
	});
	it("is invariant to offset and positive scale", () => {
		const r = seededRandom(3);
		const x = Array.from(
			{ length: 500 },
			(_, i) => Math.sin(i / 10) + uniform(r, -0.2, 0.2),
		);
		const y = x.map((v) => 7 * v + 100);
		expect(correlationLength(y)).toBeCloseTo(correlationLength(x), 9);
	});
});

describe("madScale", () => {
	it("is ~sigma for Gaussian-like data and ignores zero-weight outliers", () => {
		const r = seededRandom(4);
		const e: number[] = [];
		for (let i = 0; i < 4000; i++) {
			// Box-Muller
			const u = Math.max(1e-12, r());
			e.push(2 * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()));
		}
		const w = e.map(() => 1);
		expect(madScale(e, w)).toBeGreaterThan(1.85);
		expect(madScale(e, w)).toBeLessThan(2.15);
		const e2 = [...e, 1e6, -1e6];
		expect(madScale(e2, [...w, 0, 0])).toBeCloseTo(madScale(e, w), 9);
		// even with weight, MAD is robust to two outliers
		expect(madScale(e2, [...w, 1, 1])).toBeLessThan(2.2);
	});
	it("is 0 for constant data and for no valid samples", () => {
		expect(madScale([3, 3, 3], [1, 1, 1])).toBe(0);
		expect(madScale([1, 2], [0, 0])).toBe(0);
	});
});

describe("computeConfidence", () => {
	const make = (
		over: Partial<Parameters<typeof computeConfidence>[0]> = {},
	) => {
		const n = 300;
		const r = seededRandom(5);
		const info = new Float64Array(NPARAM * NPARAM);
		for (const j of [YAW, PITCH, ROLL, LOGF])
			info[j * NPARAM + j] = 1 / (0.05 * DEG) ** 2;
		return {
			psr: 8,
			modeRatio: 0.5,
			inlierFraction: 0.9,
			info,
			priorInfo: new Float64Array(NPARAM),
			active: [true, true, true, true, false, false],
			scale: 1,
			residuals: Float64Array.from({ length: n }, () => uniform(r, -1, 1)),
			sigma: new Float64Array(n).fill(1),
			weights: new Float64Array(n).fill(1),
			slope: new Float64Array(n).fill(0.2),
			f0: 1000,
			rmsPx: 2,
			workWidth: 1600,
			...over,
		};
	};
	it("accepts a clean, well-observed result with no reasons", () => {
		const c = computeConfidence(make());
		expect(c.accept).toBe(true);
		expect(c.score).toBeCloseTo(1, 6);
		expect(c.reasons).toEqual([]);
		expect(c.sigmaDeg.yaw).toBeLessThan(0.2);
		expect(c.metrics.rmsPx1600).toBeCloseTo(2, 9);
	});
	it("a weak correlation peak lowers the score and is explained", () => {
		const c = computeConfidence(make({ psr: 3.5 }));
		expect(c.score).toBeLessThan(1);
		expect(c.reasons.join(" ")).toMatch(/PSR/);
		expect(computeConfidence(make({ psr: 1 })).accept).toBe(false);
	});
	it("a flat skyline hard-fails regardless of other scores", () => {
		const c = computeConfidence(
			make({ slope: new Float64Array(300).fill(0.001) }),
		);
		expect(c.accept).toBe(false);
		expect(c.reasons.join(" ")).toMatch(/flat/);
		expect(c.metrics.rmsSlope).toBeCloseTo(0.001, 9);
	});
	it("a low inlier fraction hard-fails", () => {
		expect(computeConfidence(make({ inlierFraction: 0.25 })).accept).toBe(
			false,
		);
	});
	it("residual autocorrelation inflates sigma", () => {
		const n = 300;
		const smooth = Float64Array.from({ length: n }, (_, i) => Math.sin(i / 25));
		const a = computeConfidence(make());
		const b = computeConfidence(make({ residuals: smooth }));
		expect(b.metrics.corrLength).toBeGreaterThan(a.metrics.corrLength);
		expect(b.sigmaDeg.yaw).toBeGreaterThan(a.sigmaDeg.yaw);
	});
	it("inactive parameters have infinite sigma and rms scales with working width", () => {
		const c = computeConfidence(
			make({
				active: [true, false, false, false, false, false],
				workWidth: 800,
			}),
		);
		expect(c.sigmaDeg.pitch).toBe(Number.POSITIVE_INFINITY);
		expect(c.metrics.rmsPx1600).toBeCloseTo(4, 9);
	});
	it("zero-weight columns are excluded from the slope statistics", () => {
		const weights = new Float64Array(300).fill(1);
		const slope = new Float64Array(300).fill(0.2);
		for (let i = 0; i < 150; i++) {
			weights[i] = 0;
			slope[i] = 5;
		}
		expect(
			computeConfidence(make({ weights, slope })).metrics.rmsSlope,
		).toBeCloseTo(0.2, 9);
	});
	it("thresholds are monotone: bad < good for each ramp", () => {
		const t = DEFAULT_THRESHOLDS;
		expect(t.psr[0]).toBeLessThan(t.psr[1]);
		expect(t.modeRatio[0]).toBeGreaterThan(t.modeRatio[1]);
		expect(t.sigma[0]).toBeGreaterThan(t.sigma[1]);
	});
});
