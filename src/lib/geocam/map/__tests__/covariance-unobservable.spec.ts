// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// CR-49: a free parameter the information does not observe gets σ = +Infinity, not 0.
import { describe, expect, it } from "vitest";
import { invSym } from "../../../linalg";
import { IDX, NP } from "../../core";
import { covFromInfo, sigmaENOf, sigmaOf } from "../covariance";

const ALL_FREE = new Array(NP).fill(true);

/** Diagonal 7×7 information with the given per-parameter values. */
function diagInfo(d: number[]): Float64Array {
	const info = new Float64Array(NP * NP);
	d.forEach((v, k) => {
		info[k * NP + k] = v;
	});
	return info;
}

describe("covFromInfo with unobservable parameters", () => {
	it("full-rank information: the same covariance as the pseudo-inverse", () => {
		const info = diagInfo([4, 9, 1, 16, 0.25, 0.04, 2]);
		info[IDX.E * NP + IDX.N] = info[IDX.N * NP + IDX.E] = 0.05;
		const cov = covFromInfo(info, ALL_FREE);
		const A = Array.from({ length: NP }, (_, p) =>
			Array.from({ length: NP }, (_, q) => info[p * NP + q]),
		);
		const ref = invSym(A);
		for (let p = 0; p < NP; p++)
			for (let q = 0; q < NP; q++) expect(cov[p * NP + q]).toBe(ref[p][q]);
		expect(Number.isFinite(sigmaENOf(cov))).toBe(true);
	});
	it("a free eye with no eye information: σ_E, σ_N, σ_U and σ_EN are Infinity", () => {
		const info = diagInfo([4, 9, 1, 16, 0, 0, 0]);
		const cov = covFromInfo(info, ALL_FREE);
		const s = sigmaOf(cov);
		expect(s.E).toBe(Number.POSITIVE_INFINITY);
		expect(s.N).toBe(Number.POSITIVE_INFINITY);
		expect(s.U).toBe(Number.POSITIVE_INFINITY);
		expect(sigmaENOf(cov)).toBe(Number.POSITIVE_INFINITY);
		expect(s.yaw).toBeCloseTo(0.5, 12);
		expect(s.pitch).toBeCloseTo(1 / 3, 12);
	});
	it("a FIXED unobserved parameter stays 0 (not part of the solve)", () => {
		const info = diagInfo([4, 9, 1, 16, 0, 0, 0]);
		const mask = ALL_FREE.map((_, k) => k < IDX.E);
		const cov = covFromInfo(info, mask);
		const s = sigmaOf(cov);
		expect(s.E).toBe(0);
		expect(s.U).toBe(0);
		expect(sigmaENOf(cov)).toBe(0);
		expect(s.yaw).toBeCloseTo(0.5, 12);
	});
});
