// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Camera-centre-fixed rotation solve (port of tools/matcher/match.py solve_rotation): 2-point TRIAD
// rotation RANSAC on bearing pairs (world direction eye → X vs the pixel's camera ray), per focal try,
// then three rounds of robust (soft_l1) LM on the rotation vector (+ log focal when free) over the
// inliers. Sampling uses mulberry32 instead of numpy's default_rng(0), so hypotheses differ from the
// Python run; the refined optimum is the same.
//
// Hypothesis scoring (iters × N cosines per focal) is `scoreHypotheses`; the GPU variant
// (./rotation-gpu.ts, a luma compute-graph kernel) replaces it when a compute device is available.

import {
	type Mat3,
	matrixToRotvec,
	mulberry32,
	rotvecToMatrix,
} from "./geometry";
import { leastSquares } from "./lm";

export const PX_THRESH = 6.0;
export const RANSAC_ITERS = 3000;

export type RotationSolve = {
	R: Mat3;
	f: number;
	inliers: Uint8Array;
	rmse: number | null;
};

/** Inlier counts of K hypotheses (Rs: K×9 row-major) over N bearing pairs (wd, b: N×3). */
export type HypothesisScorer = (
	Rs: Float64Array,
	wd: Float64Array,
	b: Float64Array,
	cosThr: number,
) => Promise<Int32Array> | Int32Array;

export function scoreHypothesesCpu(
	Rs: Float64Array,
	wd: Float64Array,
	b: Float64Array,
	cosThr: number,
): Int32Array {
	const K = Rs.length / 9;
	const N = wd.length / 3;
	const out = new Int32Array(K);
	for (let k = 0; k < K; k++) {
		const o = k * 9;
		const r0 = Rs[o];
		const r1 = Rs[o + 1];
		const r2 = Rs[o + 2];
		const r3 = Rs[o + 3];
		const r4 = Rs[o + 4];
		const r5 = Rs[o + 5];
		const r6 = Rs[o + 6];
		const r7 = Rs[o + 7];
		const r8 = Rs[o + 8];
		let c = 0;
		for (let i = 0; i < N; i++) {
			const x = wd[i * 3];
			const y = wd[i * 3 + 1];
			const z = wd[i * 3 + 2];
			const d =
				(r0 * x + r1 * y + r2 * z) * b[i * 3] +
				(r3 * x + r4 * y + r5 * z) * b[i * 3 + 1] +
				(r6 * x + r7 * y + r8 * z) * b[i * 3 + 2];
			if (d > cosThr) c++;
		}
		out[k] = c;
	}
	return out;
}

/** TRIAD: rotation R with R a ≈ b from two vector pairs (match.triad, one pair set). */
export function triad(
	a1: ArrayLike<number>,
	a2: ArrayLike<number>,
	b1: ArrayLike<number>,
	b2: ArrayLike<number>,
	out: Float64Array,
	o = 0,
) {
	const frame = (v1: ArrayLike<number>, v2: ArrayLike<number>) => {
		const n1 = Math.hypot(v1[0], v1[1], v1[2]);
		const t1 = [v1[0] / n1, v1[1] / n1, v1[2] / n1];
		let t2 = [
			v1[1] * v2[2] - v1[2] * v2[1],
			v1[2] * v2[0] - v1[0] * v2[2],
			v1[0] * v2[1] - v1[1] * v2[0],
		];
		const n2 = Math.hypot(t2[0], t2[1], t2[2]) + 1e-12;
		t2 = [t2[0] / n2, t2[1] / n2, t2[2] / n2];
		const t3 = [
			t1[1] * t2[2] - t1[2] * t2[1],
			t1[2] * t2[0] - t1[0] * t2[2],
			t1[0] * t2[1] - t1[1] * t2[0],
		];
		return [t1, t2, t3]; // columns
	};
	const A = frame(a1, a2);
	const B = frame(b1, b2);
	// R = B Aᵀ: R_ij = Σ_k B[k][i] A[k][j]
	for (let i = 0; i < 3; i++)
		for (let j = 0; j < 3; j++)
			out[o + i * 3 + j] =
				B[0][i] * A[0][j] + B[1][i] * A[1][j] + B[2][i] * A[2][j];
}

/** Unit world directions eye → X (N×3). */
export function worldDirs(X: Float64Array, eye: ArrayLike<number>) {
	const n = X.length / 3;
	const wd = new Float64Array(n * 3);
	for (let i = 0; i < n; i++) {
		const x = X[i * 3] - eye[0];
		const y = X[i * 3 + 1] - eye[1];
		const z = X[i * 3 + 2] - eye[2];
		const l = Math.hypot(x, y, z);
		wd[i * 3] = x / l;
		wd[i * 3 + 1] = y / l;
		wd[i * 3 + 2] = z / l;
	}
	return wd;
}

/** match.reproj: pixel positions of directions wd under R, f; and front (z > 0). */
export function reproj(
	R: ArrayLike<number>,
	f: number,
	wd: Float64Array,
	cx: number,
	cy: number,
	idx?: ArrayLike<number>,
) {
	const n = idx ? idx.length : wd.length / 3;
	const p = new Float64Array(n * 2);
	const front = new Uint8Array(n);
	for (let k = 0; k < n; k++) {
		const i = idx ? idx[k] : k;
		const x = wd[i * 3];
		const y = wd[i * 3 + 1];
		const z = wd[i * 3 + 2];
		const c0 = R[0] * x + R[1] * y + R[2] * z;
		const c1 = R[3] * x + R[4] * y + R[5] * z;
		const c2 = R[6] * x + R[7] * y + R[8] * z;
		const zz = Math.max(c2, 1e-9);
		p[k * 2] = cx + (f * c0) / zz;
		p[k * 2 + 1] = cy + (f * c1) / zz;
		front[k] = c2 > 0 ? 1 : 0;
	}
	return { p, front };
}

export async function solveRotation(
	x2d: Float64Array,
	X: Float64Array,
	eye: ArrayLike<number>,
	W: number,
	H: number,
	f0: number,
	freeFocal: boolean,
	opts: {
		iters?: number;
		seed?: number;
		thr?: number;
		scorer?: HypothesisScorer;
	} = {},
): Promise<RotationSolve | null> {
	const n = x2d.length / 2;
	if (n < 6) return null;
	const iters = opts.iters ?? RANSAC_ITERS;
	const thr = opts.thr ?? PX_THRESH;
	const scorer = opts.scorer ?? scoreHypothesesCpu;
	const cx = W / 2;
	const cy = H / 2;
	const wd = worldDirs(X, eye);
	const rand = mulberry32(opts.seed ?? 0);
	let best: { R: Mat3 | null; cnt: number; f: number } = {
		R: null,
		cnt: -1,
		f: f0,
	};
	const fTries = freeFocal
		? [0.9, 0.95, 1.0, 1.05, 1.1].map((s) => f0 * s)
		: [f0];
	for (const fTry of fTries) {
		const b = new Float64Array(n * 3);
		for (let i = 0; i < n; i++) {
			const x = (x2d[i * 2] - cx) / fTry;
			const y = (x2d[i * 2 + 1] - cy) / fTry;
			const l = Math.hypot(x, y, 1);
			b[i * 3] = x / l;
			b[i * 3 + 1] = y / l;
			b[i * 3 + 2] = 1 / l;
		}
		const Rs = new Float64Array(iters * 9);
		let K = 0;
		for (let k = 0; k < iters; k++) {
			const i0 = Math.floor(rand() * n);
			const i1 = Math.floor(rand() * n);
			if (i0 === i1) continue;
			triad(
				wd.subarray(i0 * 3, i0 * 3 + 3),
				wd.subarray(i1 * 3, i1 * 3 + 3),
				b.subarray(i0 * 3, i0 * 3 + 3),
				b.subarray(i1 * 3, i1 * 3 + 3),
				Rs,
				K * 9,
			);
			K++;
		}
		const cnt = await scorer(
			Rs.subarray(0, K * 9),
			wd,
			b,
			Math.cos(thr / fTry),
		);
		let kb = 0;
		for (let k = 1; k < K; k++) if (cnt[k] > cnt[kb]) kb = k;
		if (K && cnt[kb] > best.cnt)
			best = { R: Rs.slice(kb * 9, kb * 9 + 9), cnt: cnt[kb], f: fTry };
	}
	let R = best.R;
	let f = best.f;
	if (!R) return null;
	for (let round = 0; round < 3; round++) {
		const { p, front } = reproj(R, f, wd, cx, cy);
		const inl: number[] = [];
		for (let i = 0; i < n; i++) {
			const e = Math.hypot(
				p[i * 2] - x2d[i * 2],
				p[i * 2 + 1] - x2d[i * 2 + 1],
			);
			if (e < thr * 1.5 && front[i]) inl.push(i);
		}
		if (inl.length < 6) return null;
		const rv0 = matrixToRotvec(R);
		const x0 = freeFocal ? [...rv0, Math.log(f)] : rv0;
		const fFixed = f;
		const res = (x: Float64Array) => {
			const Rr = rotvecToMatrix(x);
			const ff = freeFocal ? Math.exp(x[3]) : fFixed;
			const { p: pp } = reproj(Rr, ff, wd, cx, cy, inl);
			const m = inl.length * 2 + (freeFocal ? 1 : 0);
			const r = new Float64Array(m);
			for (let k = 0; k < inl.length; k++) {
				r[k * 2] = pp[k * 2] - x2d[inl[k] * 2];
				r[k * 2 + 1] = pp[k * 2 + 1] - x2d[inl[k] * 2 + 1];
			}
			// weak EXIF focal prior (5 %)
			if (freeFocal) r[m - 1] = (x[3] - Math.log(f0)) / 0.05;
			return r;
		};
		const sol = leastSquares(res, x0, { loss: "soft_l1", fScale: 2.0 });
		R = rotvecToMatrix(sol.x);
		if (freeFocal) f = Math.exp(sol.x[3]);
	}
	const { p, front } = reproj(R, f, wd, cx, cy);
	const inliers = new Uint8Array(n);
	let s2 = 0;
	let ni = 0;
	for (let i = 0; i < n; i++) {
		const e = Math.hypot(p[i * 2] - x2d[i * 2], p[i * 2 + 1] - x2d[i * 2 + 1]);
		if (e < thr && front[i]) {
			inliers[i] = 1;
			s2 += e * e;
			ni++;
		}
	}
	return { R, f, inliers, rmse: ni ? Math.sqrt(s2 / ni) : null };
}
