// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { IDENTITY_INTRINSICS } from "../../../concord/core";
import { type Factor, IDX, type MapProblem, NP } from "../../core";
import {
	covFromInfo,
	laplaceCovariance,
	sigmaENOf,
	sigmaOf,
	sqrtLambdaMax2,
} from "../covariance";
import { gpsFactor } from "../factors";
import { solveMap } from "../solve";

/** A linear scalar measurement x[idx] ~ N(mu, sigma). */
function measure(
	idx: number,
	mu: number,
	sigma: number,
	prior: boolean,
	family: Factor["family"],
): Factor {
	return {
		family,
		name: `m${idx}`,
		dim: 1,
		loss: { kind: "l2" },
		prior,
		residual: (x) => Float64Array.of((x[idx] - mu) / sigma),
		jacobian: () => {
			const J = new Float64Array(NP);
			J[idx] = 1 / sigma;
			return J;
		},
	};
}

describe("sqrtLambdaMax2", () => {
	it("is the sqrt of the larger eigenvalue", () => {
		expect(sqrtLambdaMax2(9, 0, 4)).toBeCloseTo(3, 12);
		expect(sqrtLambdaMax2(4, 0, 9)).toBeCloseTo(3, 12);
		// [[5,2],[2,2]] has eigenvalues 6 and 1
		expect(sqrtLambdaMax2(5, 2, 2)).toBeCloseTo(Math.sqrt(6), 12);
	});
	it("clamps a slightly negative eigenvalue to 0", () => {
		expect(sqrtLambdaMax2(-1, 0, -2)).toBe(0);
	});
});

describe("covFromInfo / sigmaOf", () => {
	it("inverts the free block and zeroes fixed rows and columns", () => {
		const info = new Float64Array(NP * NP);
		info[IDX.E * NP + IDX.E] = 4;
		info[IDX.N * NP + IDX.N] = 16;
		info[IDX.E * NP + IDX.N] = info[IDX.N * NP + IDX.E] = 0;
		info[IDX.yaw * NP + IDX.yaw] = 99; // fixed: must not leak
		const mask = Array(NP).fill(false);
		mask[IDX.E] = mask[IDX.N] = true;
		const cov = covFromInfo(info, mask);
		expect(cov[IDX.E * NP + IDX.E]).toBeCloseTo(0.25, 12);
		expect(cov[IDX.N * NP + IDX.N]).toBeCloseTo(1 / 16, 12);
		expect(cov[IDX.yaw * NP + IDX.yaw]).toBe(0);
		const s = sigmaOf(cov);
		expect(s.E).toBeCloseTo(0.5, 12);
		expect(s.N).toBeCloseTo(0.25, 12);
		expect(s.yaw).toBe(0);
		expect(sigmaENOf(cov)).toBeCloseTo(0.5, 12);
	});
	it("returns an all-zero covariance when nothing is free", () => {
		const cov = covFromInfo(new Float64Array(NP * NP), Array(NP).fill(false));
		expect(Array.from(cov).every((v) => v === 0)).toBe(true);
	});
	it("handles correlated blocks (2x2 inverse)", () => {
		const info = new Float64Array(NP * NP);
		info[IDX.E * NP + IDX.E] = 2;
		info[IDX.E * NP + IDX.N] = info[IDX.N * NP + IDX.E] = 1;
		info[IDX.N * NP + IDX.N] = 2;
		const mask = Array(NP).fill(false);
		mask[IDX.E] = mask[IDX.N] = true;
		const cov = covFromInfo(info, mask);
		expect(cov[IDX.E * NP + IDX.E]).toBeCloseTo(2 / 3, 12);
		expect(cov[IDX.E * NP + IDX.N]).toBeCloseTo(-1 / 3, 12);
	});
});

describe("laplaceCovariance and solveMap on a linear-Gaussian problem", () => {
	const base = {
		pose: { yaw: 0, pitch: 0, roll: 0, vfov: 40 },
		eye: [0, 0, 0] as [number, number, number],
		aspect: 1.5,
		intr: IDENTITY_INTRINSICS,
	};
	// rotation priors keep the (otherwise unobserved) rotation block invertible
	const rot = (idx: number) => measure(idx, 0, 10, true, "compass");
	const factors = (extra: Factor[] = []): Factor[] => [
		gpsFactor(100, 50, 10),
		measure(IDX.U, 1200, 3, true, "alt"),
		rot(IDX.yaw),
		rot(IDX.pitch),
		rot(IDX.roll),
		...extra,
	];
	const problem = (fs: Factor[]): MapProblem => ({
		base,
		f0Px1600: 1500,
		factors: fs,
		free: { rotation: true, focal: false, eye: true },
	});

	it("matches the closed-form precision-weighted posterior", async () => {
		const data = measure(IDX.E, 110, 5, false, "point");
		// start at the prior means: solveMap clips eye steps to trustM (25 m) per outer iteration
		const x0 = new Float64Array(NP);
		x0[IDX.E] = 100;
		x0[IDX.N] = 50;
		x0[IDX.U] = 1200;
		const res = await solveMap(problem(factors([data])), x0);
		// E: prior 100 +- 10, data 110 +- 5 => 108, sigma = sqrt(1 / (1/100 + 1/25))
		expect(res.x[IDX.E]).toBeCloseTo(108, 4);
		expect(res.sigma.E).toBeCloseTo(Math.sqrt(1 / (1 / 100 + 1 / 25)), 5);
		// N and U are observed only by their priors
		expect(res.x[IDX.N]).toBeCloseTo(50, 4);
		expect(res.sigma.N).toBeCloseTo(10, 5);
		expect(res.x[IDX.U]).toBeCloseTo(1200, 4);
		expect(res.sigma.U).toBeCloseTo(3, 5);
		expect(res.converged).toBe(true);
		expect(res.cam.eye[0]).toBeCloseTo(108, 4);
		// the focal is fixed: logf covariance is zero
		expect(res.sigma.logf).toBe(0);
	});
	it("adding data never widens the covariance", async () => {
		const x = new Float64Array(NP);
		const without = laplaceCovariance(factors(), x, [
			true,
			true,
			true,
			false,
			true,
			true,
			true,
		]);
		const withData = laplaceCovariance(
			factors([measure(IDX.E, 100, 5, false, "point")]),
			x,
			[true, true, true, false, true, true, true],
		);
		expect(withData.sigma.E).toBeLessThan(without.sigma.E);
		expect(withData.sigma.N).toBeCloseTo(without.sigma.N, 9);
	});
	it("widens the covariance when the data scatter beyond their stated sigma (MAD rescale)", () => {
		const x = new Float64Array(NP);
		const mask = [true, true, true, false, true, true, true];
		// 20 rows of a data factor whose residuals are +-3 sigma at the current state
		const noisy: Factor = {
			family: "point",
			name: "noisy",
			dim: 20,
			loss: { kind: "l2" },
			residual: () =>
				Float64Array.from({ length: 20 }, (_, i) => (i % 2 ? 3 : -3)),
			jacobian: () => {
				const J = new Float64Array(20 * NP);
				for (let r = 0; r < 20; r++) J[r * NP + IDX.E] = 1;
				return J;
			},
		};
		const scaled = laplaceCovariance(factors([noisy]), x, mask);
		const unscaled = laplaceCovariance(factors([noisy]), x, mask, {
			madRescale: false,
		});
		expect(scaled.mad).toBeCloseTo(1.4826 * 3, 6);
		expect(scaled.sigma.E).toBeGreaterThan(unscaled.sigma.E);
		// the data block is divided by s^2 (s = MAD scale)
		const precPrior = 1 / 100;
		const precData = 20 / (1.4826 * 3) ** 2;
		expect(scaled.sigma.E).toBeCloseTo(
			Math.sqrt(1 / (precPrior + precData)),
			6,
		);
	});
	it("reports per-family information", () => {
		const c = laplaceCovariance(factors(), new Float64Array(NP), [
			true,
			true,
			true,
			false,
			true,
			true,
			true,
		]);
		const gps = c.perFamily.find((f) => f.family === "gps");
		expect(gps?.n).toBe(2);
		expect(gps?.info[IDX.E * NP + IDX.E]).toBeCloseTo(1 / 100, 12);
	});
});
