// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// CR-49: invSymCov reports +Infinity variance for parameters in the null space of the information,
// where the pseudo-inverse invSym reports 0 (σ = 0 would make an integrity test fail open).
import { describe, expect, it } from "vitest";
import { seededRandom, uniform } from "#/test/helpers";
import { invSym, invSymCov } from "../index";

function randomSPD(rand: () => number, n: number) {
	const B = Array.from({ length: n }, () =>
		Array.from({ length: n }, () => uniform(rand, -1, 1)),
	);
	return Array.from({ length: n }, (_, i) =>
		Array.from(
			{ length: n },
			(_, j) =>
				B.reduce((s, row) => s + row[i] * row[j], 0) + (i === j ? 0.5 : 0),
		),
	);
}

describe("invSymCov", () => {
	it("is identical to invSym for full-rank matrices", () => {
		const rand = seededRandom(49);
		for (let t = 0; t < 20; t++) {
			const n = 2 + (t % 6);
			const A = randomSPD(rand, n);
			expect(invSymCov(A)).toEqual(invSym(A));
		}
	});
	it("gives Infinity variance to an unobserved parameter, leaves the observed block alone", () => {
		// parameter 2 has no information at all
		const A = [
			[4, 1, 0],
			[1, 2, 0],
			[0, 0, 0],
		];
		const pinv = invSym(A);
		expect(pinv[2][2]).toBe(0); // the fail-open value
		const C = invSymCov(A);
		expect(C[2][2]).toBe(Number.POSITIVE_INFINITY);
		const det = 4 * 2 - 1;
		expect(C[0][0]).toBeCloseTo(2 / det, 12);
		expect(C[1][1]).toBeCloseTo(4 / det, 12);
		expect(C[0][1]).toBeCloseTo(-1 / det, 12);
		expect(Number.isFinite(C[0][2])).toBe(true);
	});
	it("marks every parameter that mixes into the null space (only the sum is observed)", () => {
		// x0 + x1 observed, x0 − x1 not; x2 observed on its own
		const A = [
			[1, 1, 0],
			[1, 1, 0],
			[0, 0, 3],
		];
		const C = invSymCov(A);
		expect(C[0][0]).toBe(Number.POSITIVE_INFINITY);
		expect(C[1][1]).toBe(Number.POSITIVE_INFINITY);
		expect(C[2][2]).toBeCloseTo(1 / 3, 12);
	});
	it("an all-zero information matrix is unobservable everywhere", () => {
		const C = invSymCov([
			[0, 0],
			[0, 0],
		]);
		expect(C[0][0]).toBe(Number.POSITIVE_INFINITY);
		expect(C[1][1]).toBe(Number.POSITIVE_INFINITY);
	});
});
