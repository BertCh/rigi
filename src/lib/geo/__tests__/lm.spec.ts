// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { expectArrayClose, seededRandom, uniform } from "#/test/helpers";
import { levenbergMarquardt } from "../lm";

describe("levenbergMarquardt", () => {
	it("solves a linear least squares problem exactly", () => {
		const xs = [0, 1, 2, 3, 4];
		const fn = ([a, b]: number[]) => xs.map((x) => a * x + b - (2 * x + 1));
		const r = levenbergMarquardt(fn, [0, 0], {
			steps: [1e-6, 1e-6],
			maxIterations: 50,
		});
		expectArrayClose(r.params, [2, 1], 1e-5);
		expect(r.cost).toBeLessThan(1e-9);
	});
	it("fits an exponential from a rough start", () => {
		const xs = Array.from({ length: 20 }, (_, i) => i / 10);
		const fn = ([a, k]: number[]) =>
			xs.map((x) => a * Math.exp(k * x) - 3 * Math.exp(-0.7 * x));
		const r = levenbergMarquardt(fn, [1, 0], {
			steps: [1e-6, 1e-6],
			maxIterations: 100,
		});
		expectArrayClose(r.params, [3, -0.7], 1e-4);
	});
	it("returns the initial params when already at the optimum", () => {
		const r = levenbergMarquardt(([a]) => [a - 5], [5]);
		expect(r.params[0]).toBe(5);
		expect(r.cost).toBe(0);
	});
	it("never increases the cost and does not mutate `initial`", () => {
		const init = [10, -10];
		const fn = ([a, b]: number[]) => [a - 1, b - 2, a * b - 2];
		const c0 = fn(init).reduce((s, v) => s + 0.5 * v * v, 0);
		const r = levenbergMarquardt(fn, init, { steps: [1e-6, 1e-6] });
		expect(r.cost).toBeLessThanOrEqual(c0);
		expect(init).toEqual([10, -10]);
	});
	it("ignores NaN residuals", () => {
		const fn = ([a]: number[]) => [a - 3, Number.NaN, a - 3];
		const r = levenbergMarquardt(fn, [0], { steps: [1e-6] });
		expect(r.params[0]).toBeCloseTo(3, 5);
		expect(Number.isFinite(r.cost)).toBe(true);
	});
	it("Cauchy loss resists a gross outlier better than L2", () => {
		const rand = seededRandom(5);
		const ys = Array.from({ length: 30 }, () => 4 + uniform(rand, -0.05, 0.05));
		ys[3] = 400;
		const fn = ([a]: number[]) => ys.map((y) => a - y);
		const l2 = levenbergMarquardt(fn, [4.5], {
			steps: [1e-6],
			maxIterations: 100,
		});
		const cauchy = levenbergMarquardt(fn, [4.5], {
			cauchy: 0.2,
			steps: [1e-6],
			maxIterations: 100,
		});
		const huber = levenbergMarquardt(fn, [4.5], {
			huber: 0.2,
			steps: [1e-6],
			maxIterations: 100,
		});
		expect(Math.abs(cauchy.params[0] - 4)).toBeLessThan(0.1);
		expect(Math.abs(huber.params[0] - 4)).toBeLessThan(
			Math.abs(l2.params[0] - 4),
		);
		expect(l2.params[0]).toBeGreaterThan(10);
	});
	it("a Gaussian prior pulls a poorly determined parameter toward its mean", () => {
		// one data residual constrains a+b only
		const fn = ([a, b]: number[]) => [a + b - 10];
		const r = levenbergMarquardt(fn, [0, 0], {
			steps: [1e-6, 1e-6],
			maxIterations: 100,
			prior: { mean: [8, 0], sigma: [0.1, 100] },
		});
		expect(r.params[0]).toBeGreaterThan(7.5);
		expect(r.params[0] + r.params[1]).toBeCloseTo(10, 1);
		expect(r.residuals).toHaveLength(3);
	});
	it("honours maxIterations", () => {
		const r = levenbergMarquardt(([a]) => [a * a * a - 1000], [1], {
			maxIterations: 2,
			steps: [1e-6],
		});
		expect(r.iterations).toBeLessThanOrEqual(2);
	});
});
