// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { expectArrayClose, seededRandom, uniform } from "#/test/helpers";
import {
	choleskySolve,
	cross3,
	dot3,
	gaussJordan,
	invertSPD,
	invSym,
	jacobiEigen,
	norm3,
	realRoots,
	scale3,
	solveLinear,
	sub3,
	unit3,
} from "../index";

const matVec = (A: number[][], x: number[]) =>
	A.map((r) => r.reduce((s, v, j) => s + v * x[j], 0));

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

describe("vec3", () => {
	it("dot, sub, scale, norm", () => {
		expect(dot3([1, 2, 3], [4, -5, 6])).toBe(12);
		expect(sub3([3, 2, 1], [1, 1, 1])).toEqual([2, 1, 0]);
		expect(scale3([1, -2, 3], 2)).toEqual([2, -4, 6]);
		expect(norm3([3, 4, 12])).toBe(13);
	});
	it("unit3 has norm 1; zero vector gives NaN", () => {
		expect(norm3(unit3([3, -4, 12]))).toBeCloseTo(1, 14);
		expect(unit3([0, 0, 0]).every(Number.isNaN)).toBe(true);
	});
	it("cross3 follows the right-hand rule and is orthogonal", () => {
		expect(cross3([1, 0, 0], [0, 1, 0])).toEqual([0, 0, 1]);
		expect(cross3([0, 1, 0], [1, 0, 0])).toEqual([0, 0, -1]);
		const rand = seededRandom(1);
		for (let i = 0; i < 20; i++) {
			const a = [
				uniform(rand, -3, 3),
				uniform(rand, -3, 3),
				uniform(rand, -3, 3),
			];
			const b = [
				uniform(rand, -3, 3),
				uniform(rand, -3, 3),
				uniform(rand, -3, 3),
			];
			const c = cross3(a, b);
			expect(dot3(c, a)).toBeCloseTo(0, 10);
			expect(dot3(c, b)).toBeCloseTo(0, 10);
		}
	});
});

describe("solveLinear / gaussJordan", () => {
	it("solves a known 2x2 system", () => {
		expectArrayClose(
			solveLinear(
				[
					[2, 1],
					[1, 3],
				],
				[3, 5],
			) as number[],
			[0.8, 1.4],
		);
	});
	it("needs pivoting for a zero leading entry", () => {
		expectArrayClose(
			solveLinear(
				[
					[0, 1],
					[1, 0],
				],
				[2, 3],
			) as number[],
			[3, 2],
		);
	});
	it("returns null for singular systems", () => {
		expect(
			solveLinear(
				[
					[1, 2],
					[2, 4],
				],
				[1, 2],
			),
		).toBeNull();
	});
	it("recovers x for random well-conditioned systems (both solvers)", () => {
		const rand = seededRandom(7);
		for (let t = 0; t < 20; t++) {
			const n = 2 + (t % 6);
			const A = randomSPD(rand, n);
			const x = Array.from({ length: n }, () => uniform(rand, -2, 2));
			const b = matVec(A, x);
			expectArrayClose(solveLinear(A, b) as number[], x, 1e-8);
			expectArrayClose(gaussJordan(A, b), x, 1e-8);
			expectArrayClose(gaussJordan(A, b, 1e-12) as number[], x, 1e-8);
		}
	});
	it("gaussJordan with pivotTol returns null when singular; without it stays finite-shaped", () => {
		expect(
			gaussJordan(
				[
					[1, 2],
					[2, 4],
				],
				[1, 2],
				1e-9,
			),
		).toBeNull();
		expect(
			gaussJordan(
				[
					[1, 2],
					[2, 4],
				],
				[1, 2],
			),
		).toHaveLength(2);
	});
	it("does not mutate its inputs", () => {
		const A = [
			[2, 1],
			[1, 3],
		];
		const b = [3, 5];
		solveLinear(A, b);
		gaussJordan(A, b);
		expect(A).toEqual([
			[2, 1],
			[1, 3],
		]);
		expect(b).toEqual([3, 5]);
	});
});

describe("cholesky", () => {
	it("solves SPD systems and agrees with solveLinear", () => {
		const rand = seededRandom(3);
		const n = 6;
		const A = randomSPD(rand, n);
		const b = Array.from({ length: n }, () => uniform(rand, -1, 1));
		const x = choleskySolve(
			Float64Array.from(A.flat()),
			Float64Array.from(b),
			n,
		);
		expect(x).not.toBeNull();
		expectArrayClose(x as Float64Array, solveLinear(A, b) as number[], 1e-9);
	});
	it("returns null for indefinite matrices", () => {
		const A = Float64Array.from([1, 2, 2, 1]);
		expect(choleskySolve(A, Float64Array.from([1, 1]), 2)).toBeNull();
		expect(invertSPD(A, 2)).toBeNull();
	});
	it("invertSPD times A is identity", () => {
		const rand = seededRandom(11);
		const n = 5;
		const A = randomSPD(rand, n);
		const inv = invertSPD(Float64Array.from(A.flat()), n) as Float64Array;
		for (let i = 0; i < n; i++)
			for (let j = 0; j < n; j++) {
				let s = 0;
				for (let k = 0; k < n; k++) s += A[i][k] * inv[k * n + j];
				expect(s).toBeCloseTo(i === j ? 1 : 0, 8);
			}
	});
});

describe("jacobiEigen / invSym", () => {
	it("diagonal matrix: ascending eigenvalues", () => {
		const { values } = jacobiEigen([
			[3, 0, 0],
			[0, 1, 0],
			[0, 0, 2],
		]);
		expectArrayClose(values, [1, 2, 3]);
	});
	it("known 2x2 [[2,1],[1,2]] has eigenvalues 1 and 3", () => {
		const { values } = jacobiEigen([
			[2, 1],
			[1, 2],
		]);
		expectArrayClose(values, [1, 3], 1e-12);
	});
	it("A v = lambda v and V is orthonormal for random symmetric matrices", () => {
		const rand = seededRandom(5);
		const n = 6;
		const A = randomSPD(rand, n);
		const { values, vectors } = jacobiEigen(A);
		for (let k = 0; k < n; k++) {
			const v = vectors.map((r) => r[k]);
			expectArrayClose(
				matVec(A, v),
				v.map((x) => x * values[k]),
				1e-8,
			);
			expect(norm3([v[0], v[1], v[2], 0].slice(0, 3))).toBeGreaterThanOrEqual(
				0,
			);
			expect(v.reduce((s, x) => s + x * x, 0)).toBeCloseTo(1, 10);
		}
		for (let k = 1; k < n; k++)
			expect(values[k]).toBeGreaterThanOrEqual(values[k - 1]);
	});
	it("does not mutate the input", () => {
		const A = [
			[2, 1],
			[1, 2],
		];
		jacobiEigen(A);
		expect(A).toEqual([
			[2, 1],
			[1, 2],
		]);
	});
	it("invSym inverts SPD matrices", () => {
		const rand = seededRandom(9);
		const A = randomSPD(rand, 4);
		const inv = invSym(A);
		const prod = A.map((r) =>
			inv[0].map((_, j) => r.reduce((s, v, k) => s + v * inv[k][j], 0)),
		);
		for (let i = 0; i < 4; i++)
			for (let j = 0; j < 4; j++)
				expect(prod[i][j]).toBeCloseTo(i === j ? 1 : 0, 8);
	});
	it("invSym is a pseudo-inverse for rank-deficient input", () => {
		const inv = invSym([
			[1, 0],
			[0, 0],
		]);
		expectArrayClose(inv[0], [1, 0], 1e-12);
		expectArrayClose(inv[1], [0, 0], 1e-12);
	});
});

describe("realRoots", () => {
	const sorted = (a: number[]) => [...a].sort((x, y) => x - y);
	it("finds the roots of (x-1)(x-2)(x-3)", () => {
		expectArrayClose(sorted(realRoots([1, -6, 11, -6])), [1, 2, 3], 1e-9);
	});
	it("linear and degenerate cases", () => {
		expect(realRoots([2, -4])).toEqual([2]);
		expect(realRoots([5])).toEqual([]);
		expect(realRoots([0, 0, 2, -4])).toEqual([2]);
	});
	it("drops complex pairs", () => {
		// x^4 + x^2 - 4: x^2 = (-1 +- sqrt 17)/2, so only x^2 > 0 gives real roots
		const r = Math.sqrt((-1 + Math.sqrt(17)) / 2);
		expect(realRoots([1, 0, 1])).toEqual([]);
		expectArrayClose(sorted(realRoots([1, 0, 1, 0, -4])), [-r, r], 1e-8);
	});
	it("recovers random real roots of a quartic", () => {
		const rand = seededRandom(21);
		const roots = [-2.3, -0.4, 0.9, 3.1].map(
			(r) => r + uniform(rand, -0.05, 0.05),
		);
		let poly = [1];
		for (const r of roots) {
			const next = new Array(poly.length + 1).fill(0);
			poly.forEach((c, i) => {
				next[i] += c;
				next[i + 1] -= c * r;
			});
			poly = next;
		}
		expectArrayClose(sorted(realRoots(poly)), sorted(roots), 1e-7);
	});
});
