// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Equivalence of the consolidated 3×3 kernels with the per-module copies they replaced
// (reference implementations copied verbatim from the pre-consolidation sources).

import { describe, expect, it } from "vitest";
import { poseToR } from "#/lib/camera";
import { gaussJordan } from "#/lib/linalg";
import { seededRandom, uniform } from "#/test/helpers";
import {
	expSO3,
	mul3,
	rodrigues,
	rotationAngle,
	solveLinear,
	transpose3,
} from "../index";

// ---- references (old copies) ----
const oldMul3 = (a: ArrayLike<number>, b: ArrayLike<number>) => {
	const o = new Array(9).fill(0);
	for (let i = 0; i < 3; i++)
		for (let j = 0; j < 3; j++) {
			let s = 0;
			for (let k = 0; k < 3; k++) s += a[i * 3 + k] * b[k * 3 + j];
			o[i * 3 + j] = s;
		}
	return o;
};
const oldMat3Mul = (a: ArrayLike<number>, b: ArrayLike<number>) => {
	const o = new Array(9).fill(0);
	for (let i = 0; i < 3; i++)
		for (let j = 0; j < 3; j++)
			o[i * 3 + j] =
				a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
	return o;
};
const oldTranspose = (a: ArrayLike<number>) => [
	a[0],
	a[3],
	a[6],
	a[1],
	a[4],
	a[7],
	a[2],
	a[5],
	a[8],
];
const oldRodrigues = (w: ArrayLike<number>) => {
	const th = Math.hypot(w[0], w[1], w[2]);
	if (th < 1e-12) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
	const kx = w[0] / th;
	const ky = w[1] / th;
	const kz = w[2] / th;
	const s = Math.sin(th);
	const c = 1 - Math.cos(th);
	const K = [0, -kz, ky, kz, 0, -kx, -ky, kx, 0];
	const K2 = oldMat3Mul(K, K);
	return [1, 0, 0, 0, 1, 0, 0, 0, 1].map((v, i) => v + s * K[i] + c * K2[i]);
};
const oldAcosAngle = (R: ArrayLike<number>) =>
	Math.acos(Math.max(-1, Math.min(1, (R[0] + R[4] + R[8] - 1) / 2)));
// eyes.ts flat solver
function oldEyesSolve(A: number[], b: number[], n: number): number[] | null {
	const M = A.slice();
	const x = b.slice();
	for (let c = 0; c < n; c++) {
		let p = c;
		for (let r = c + 1; r < n; r++)
			if (Math.abs(M[r * n + c]) > Math.abs(M[p * n + c])) p = r;
		if (Math.abs(M[p * n + c]) < 1e-300) return null;
		if (p !== c) {
			for (let k = 0; k < n; k++) {
				const t = M[c * n + k];
				M[c * n + k] = M[p * n + k];
				M[p * n + k] = t;
			}
			const t = x[c];
			x[c] = x[p];
			x[p] = t;
		}
		for (let r = c + 1; r < n; r++) {
			const f = M[r * n + c] / M[c * n + c];
			if (f === 0) continue;
			for (let k = c; k < n; k++) M[r * n + k] -= f * M[c * n + k];
			x[r] -= f * x[c];
		}
	}
	for (let r = n - 1; r >= 0; r--) {
		let s = x[r];
		for (let k = r + 1; k < n; k++) s -= M[r * n + k] * x[k];
		x[r] = s / M[r * n + r];
	}
	return x.every(Number.isFinite) ? x : null;
}
// peakfix/fit.ts solve4
function oldSolve4(A: number[][], b: number[]): number[] | null {
	const n = 4;
	const M = A.map((row, i) => [...row, b[i]]);
	for (let c = 0; c < n; c++) {
		let piv = c;
		for (let r = c + 1; r < n; r++)
			if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
		if (Math.abs(M[piv][c]) < 1e-12) return null;
		[M[c], M[piv]] = [M[piv], M[c]];
		for (let r = 0; r < n; r++) {
			if (r === c) continue;
			const f = M[r][c] / M[c][c];
			for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
		}
	}
	return M.map((row, i) => row[n] / row[i]);
}

const maxDiff = (a: ArrayLike<number>, b: ArrayLike<number>) => {
	let m = 0;
	for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
	return m;
};
const rand9 = (rnd: () => number) =>
	Array.from({ length: 9 }, () => uniform(rnd, -3, 3));

describe("3×3 kernels", () => {
	const rnd = seededRandom(7);
	const mats = Array.from({ length: 200 }, () => rand9(rnd));

	it("mul3 / transpose3 match the old copies exactly", () => {
		for (let i = 0; i < mats.length; i++) {
			const a = mats[i];
			const b = mats[(i + 1) % mats.length];
			expect(mul3(a, b)).toEqual(oldMul3(a, b));
			expect(mul3(a, b)).toEqual(oldMat3Mul(a, b));
			expect(transpose3(a)).toEqual(oldTranspose(a));
		}
	});

	it("out-parameter form fills Float64Array and number[] alike", () => {
		const a = mats[0];
		const b = mats[1];
		const f = mul3(a, b, new Float64Array(9));
		expect(f).toBeInstanceOf(Float64Array);
		expect(Array.from(f)).toEqual(oldMul3(a, b));
		const t = transpose3(a, new Float64Array(9));
		expect(Array.from(t)).toEqual(oldTranspose(a));
	});

	it("rodrigues agrees with the old K-form to 1e-12 (incl. tiny and zero vectors)", () => {
		const ws: number[][] = [
			[0, 0, 0],
			[1e-13, 0, 0],
			[1e-9, -2e-9, 1e-9],
		];
		for (let i = 0; i < 300; i++)
			ws.push([uniform(rnd, -3, 3), uniform(rnd, -3, 3), uniform(rnd, -3, 3)]);
		let worst = 0;
		for (const w of ws) {
			worst = Math.max(worst, maxDiff(rodrigues(w), oldRodrigues(w)));
			expect(maxDiff(expSO3(w[0], w[1], w[2]), rodrigues(w))).toBe(0);
		}
		expect(worst).toBeLessThan(1e-12);
	});

	it("rotationAngle equals the old acos form exactly and recovers the angle", () => {
		for (let i = 0; i < 100; i++) {
			const R = poseToR({
				yaw: uniform(rnd, -180, 180),
				pitch: uniform(rnd, -60, 60),
				roll: uniform(rnd, -90, 90),
				vfov: 40,
			});
			expect(rotationAngle(R)).toBe(oldAcosAngle(R));
		}
		const th = 0.7;
		expect(rotationAngle(rodrigues([0, th, 0]))).toBeCloseTo(th, 12);
	});
});

describe("solver delegation", () => {
	const rnd = seededRandom(11);
	it("flat eyes solver == linalg.solveLinear on rows (exact)", () => {
		for (let t = 0; t < 100; t++) {
			const n = 3 + (t % 6);
			const flat = Array.from({ length: n * n }, () => uniform(rnd, -2, 2));
			const b = Array.from({ length: n }, () => uniform(rnd, -2, 2));
			const rows = Array.from({ length: n }, (_, r) =>
				flat.slice(r * n, r * n + n),
			);
			expect(solveLinear(rows, b)).toEqual(oldEyesSolve(flat, b, n));
		}
		// singular
		expect(
			solveLinear(
				[
					[0, 0],
					[0, 0],
				],
				[1, 1],
			),
		).toBeNull();
		expect(oldEyesSolve([0, 0, 0, 0], [1, 1], 2)).toBeNull();
	});
	it("peakfix solve4 == gaussJordan(…, 1e-12) (exact)", () => {
		for (let t = 0; t < 100; t++) {
			const A = Array.from({ length: 4 }, () =>
				Array.from({ length: 4 }, () => uniform(rnd, -2, 2)),
			);
			const b = Array.from({ length: 4 }, () => uniform(rnd, -2, 2));
			expect(gaussJordan(A, b, 1e-12)).toEqual(oldSolve4(A, b));
		}
		const sing = [
			[1, 2, 3, 4],
			[2, 4, 6, 8],
			[0, 1, 0, 1],
			[1, 0, 1, 0],
		];
		expect(gaussJordan(sing, [1, 2, 3, 4], 1e-12)).toEqual(
			oldSolve4(sing, [1, 2, 3, 4]),
		);
	});
});
