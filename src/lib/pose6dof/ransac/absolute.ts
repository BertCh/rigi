// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// 6-DoF absolute pose LO-RANSAC, after poselib.estimate_absolute_pose (the call in tools/matcher/match.py
// solve_pnp_exif and the x5 verifier): minimal samples → MSAC score Σ min(e², thr²) over all points →
// local optimisation (LM with a truncated loss) whenever the best model improves → dynamic trial count
// (poselib: ⌈log(1 − p) / log(1 − w^s)⌉ × 3, clamped to [minIterations, maxIterations]) → final LM on
// the inliers with a Cauchy loss at 0.5 thr. Fixed focal: Grunert P3P (sample 3). Free focal (poselib
// has no free-focal estimate_absolute_pose; match.py hand-rolls P4Pf): linear 6-point DLT with the
// principal point known, then the same LO / refinement with log-focal as a 7th parameter.
// Camera convention: OpenCV (x right, y down, z forward); R, t map world → camera: p = R X + t.
import { jacobiEigen, realRoots } from "../../linalg";
import {
	driveSync,
	HYP_STRIDE,
	type HypothesisBatch,
	putHypothesis,
	type RansacLoop,
	scoreHypothesis,
} from "./batch";
import type { Intrinsics } from "./camera-rotation";
import { refinePoseLm } from "./lm";
import { createRng, sampleDistinct, trialsNeeded } from "./rng";
import { kabsch, rotationFromCovariance } from "./rot3";

export type AbsolutePoseOptions = {
	/** Inlier threshold, px (default 12, poselib's default; match.py uses 6). */
	maxReprojErrorPx?: number;
	/** Default 100000 (poselib). */
	maxIterations?: number;
	/** Default 1000 (poselib). */
	minIterations?: number;
	/** Success probability for the dynamic trial count (default 0.9999, poselib). */
	confidence?: number;
	/** Final LM on the inliers (default true). */
	refine?: boolean;
	seed?: number;
	/** "free": unknown focal (fx, fy scale together), 6-point DLT samples (default "fixed"). */
	focal?: "fixed" | "free";
	/** Free focal: accept models with fx within [lo, hi] × camera.fx (default [0.2, 5]). */
	focalRange?: [number, number];
	/** Samples per scored batch (default 1 on the CPU; the async GPU path uses 256). */
	batchSize?: number;
};

export type AbsolutePoseResult = {
	/** World → camera, row-major 3×3. */
	R: Float64Array;
	t: Float64Array;
	/** Solved fx (free focal only). */
	focal?: number;
	inliers: Uint8Array;
	inlierCount: number;
	iterations: number;
	rmsPx: number | null;
};

// ---------- minimal solvers ----------

/**
 * Grunert P3P: unit bearings (OpenCV camera frame) b[0..8] and world points X[0..8] → up to 4
 * (R, t) with s_i b_i = R X_i + t. Returns the number written into Rs (9 each) / ts (3 each).
 */
export function p3pGrunert(
	b: ArrayLike<number>,
	X: ArrayLike<number>,
	Rs: Float64Array,
	ts: Float64Array,
): number {
	const d = (i: number, j: number) =>
		Math.hypot(
			X[i * 3] - X[j * 3],
			X[i * 3 + 1] - X[j * 3 + 1],
			X[i * 3 + 2] - X[j * 3 + 2],
		);
	const dot = (i: number, j: number) =>
		b[i * 3] * b[j * 3] +
		b[i * 3 + 1] * b[j * 3 + 1] +
		b[i * 3 + 2] * b[j * 3 + 2];
	const a = d(1, 2);
	const bb = d(0, 2);
	const c = d(0, 1);
	if (a < 1e-9 || bb < 1e-9 || c < 1e-9) return 0;
	const ca = dot(1, 2);
	const cb = dot(0, 2);
	const cg = dot(0, 1);
	const a2 = a * a;
	const b2 = bb * bb;
	const c2 = c * c;
	const amc = (a2 - c2) / b2;
	const apc = (a2 + c2) / b2;
	const A4 = (amc - 1) ** 2 - ((4 * c2) / b2) * ca * ca;
	const A3 =
		4 *
		(amc * (1 - amc) * cb -
			(1 - apc) * ca * cg +
			((2 * c2) / b2) * ca * ca * cb);
	const A2 =
		2 *
		(amc * amc -
			1 +
			2 * amc * amc * cb * cb +
			2 * ((b2 - c2) / b2) * ca * ca -
			4 * apc * ca * cb * cg +
			2 * ((b2 - a2) / b2) * cg * cg);
	const A1 =
		4 *
		(-amc * (1 + amc) * cb +
			((2 * a2) / b2) * cg * cg * cb -
			(1 - apc) * ca * cg);
	const A0 = (1 + amc) ** 2 - ((4 * a2) / b2) * cg * cg;
	const Xc = new Float64Array(9);
	const R = new Float64Array(9);
	const xw = new Float64Array(9);
	const yc = new Float64Array(9);
	let m = 0;
	for (const v of realRoots([A4, A3, A2, A1, A0])) {
		if (m >= 4) break;
		if (!(v > 0)) continue;
		const den = 2 * (cg - v * ca);
		if (Math.abs(den) < 1e-15) continue;
		const u = ((-1 + amc) * v * v - 2 * amc * cb * v + 1 + amc) / den;
		if (!(u > 0)) continue;
		const s1sq = b2 / (1 + v * v - 2 * v * cb);
		if (!(s1sq > 0)) continue;
		const s1 = Math.sqrt(s1sq);
		const s = [s1, u * s1, v * s1];
		for (let i = 0; i < 3; i++)
			for (let k = 0; k < 3; k++) Xc[i * 3 + k] = s[i] * b[i * 3 + k];
		if (!rigidFit(X, Xc, 3, R, ts, m * 3, xw, yc)) continue;
		Rs.set(R, m * 9);
		m++;
	}
	return m;
}

/** World → camera rigid fit y ≈ R x + t on n points (Kabsch on centred points). */
function rigidFit(
	x: ArrayLike<number>,
	y: ArrayLike<number>,
	n: number,
	R: Float64Array,
	ts: Float64Array,
	tOff: number,
	xw: Float64Array,
	yc: Float64Array,
): boolean {
	const cx = [0, 0, 0];
	const cy = [0, 0, 0];
	for (let i = 0; i < n; i++)
		for (let k = 0; k < 3; k++) {
			cx[k] += x[i * 3 + k] / n;
			cy[k] += y[i * 3 + k] / n;
		}
	for (let i = 0; i < n; i++)
		for (let k = 0; k < 3; k++) {
			xw[i * 3 + k] = x[i * 3 + k] - cx[k];
			yc[i * 3 + k] = y[i * 3 + k] - cy[k];
		}
	kabsch(xw.subarray(0, n * 3), yc.subarray(0, n * 3), undefined, R);
	for (let k = 0; k < 3; k++)
		ts[tOff + k] =
			cy[k] - (R[k * 3] * cx[0] + R[k * 3 + 1] * cx[1] + R[k * 3 + 2] * cx[2]);
	return (
		Number.isFinite(ts[tOff]) &&
		Number.isFinite(ts[tOff + 1]) &&
		Number.isFinite(ts[tOff + 2])
	);
}

/**
 * Linear DLT with a known principal point and square-ish pixels: normalised image coords
 * (x/fx, y/fy) and ≥6 world points → (R, t, focal scale s) with s ≈ f / f0. Null when degenerate.
 */
export function dltFocal(
	xn: ArrayLike<number>,
	X: ArrayLike<number>,
	idx: ArrayLike<number>,
): { R: Float64Array; t: Float64Array; scale: number } | null {
	const n = idx.length;
	const c = [0, 0, 0];
	for (let j = 0; j < n; j++)
		for (let k = 0; k < 3; k++) c[k] += X[idx[j] * 3 + k] / n;
	let sc = 0;
	for (let j = 0; j < n; j++) {
		const i = idx[j];
		sc +=
			Math.hypot(X[i * 3] - c[0], X[i * 3 + 1] - c[1], X[i * 3 + 2] - c[2]) / n;
	}
	if (!(sc > 0)) return null;
	const AtA = Array.from({ length: 12 }, () => new Array<number>(12).fill(0));
	const row = new Float64Array(12);
	const add = () => {
		for (let p = 0; p < 12; p++) {
			if (row[p] === 0) continue;
			for (let q = 0; q < 12; q++) AtA[p][q] += row[p] * row[q];
		}
	};
	for (let j = 0; j < n; j++) {
		const i = idx[j];
		const P = [
			(X[i * 3] - c[0]) / sc,
			(X[i * 3 + 1] - c[1]) / sc,
			(X[i * 3 + 2] - c[2]) / sc,
			1,
		];
		const x = xn[i * 2];
		const y = xn[i * 2 + 1];
		row.fill(0);
		for (let k = 0; k < 4; k++) {
			row[k] = P[k];
			row[8 + k] = -x * P[k];
		}
		add();
		row.fill(0);
		for (let k = 0; k < 4; k++) {
			row[4 + k] = P[k];
			row[8 + k] = -y * P[k];
		}
		add();
	}
	const { vectors } = jacobiEigen(AtA);
	const p = vectors.map((r) => r[0]);
	const m3 = Math.hypot(p[8], p[9], p[10]);
	if (!(m3 > 1e-12)) return null;
	for (let k = 0; k < 12; k++) p[k] /= m3;
	const n1 = Math.hypot(p[0], p[1], p[2]);
	const n2 = Math.hypot(p[4], p[5], p[6]);
	const s = (n1 + n2) / 2;
	if (!(s > 1e-6)) return null;
	const M = [
		p[0] / s,
		p[1] / s,
		p[2] / s,
		p[4] / s,
		p[5] / s,
		p[6] / s,
		p[8],
		p[9],
		p[10],
	];
	let t = [p[3] / s, p[7] / s, p[11]];
	const det =
		M[0] * (M[4] * M[8] - M[5] * M[7]) -
		M[1] * (M[3] * M[8] - M[5] * M[6]) +
		M[2] * (M[3] * M[7] - M[4] * M[6]);
	if (det < 0) {
		for (let k = 0; k < 9; k++) M[k] = -M[k];
		t = t.map((x) => -x);
	}
	// nearest rotation to M: Horn with S = Mᵀ (x = e_i, y = M e_i)
	const S = [M[0], M[3], M[6], M[1], M[4], M[7], M[2], M[5], M[8]];
	const R = rotationFromCovariance(S);
	// back to world units: p = R (X − c) / sc + t  ∝  R X + (sc t − R c)
	const tw = new Float64Array(3);
	for (let k = 0; k < 3; k++)
		tw[k] =
			sc * t[k] - (R[k * 3] * c[0] + R[k * 3 + 1] * c[1] + R[k * 3 + 2] * c[2]);
	if (!tw.every(Number.isFinite)) return null;
	return { R, t: tw, scale: s };
}

// ---------- LO-RANSAC ----------

export function* absolutePoseLoop(
	points2d: Float64Array,
	points3d: Float64Array,
	camera: Intrinsics,
	opts: AbsolutePoseOptions = {},
): RansacLoop<AbsolutePoseResult | null> {
	const free = opts.focal === "free";
	const sampleSize = free ? 6 : 3;
	const n = Math.min(points2d.length / 2, points3d.length / 3);
	if (n < sampleSize) return null;
	const thr = opts.maxReprojErrorPx ?? 12;
	const thr2 = thr * thr;
	const maxIt = opts.maxIterations ?? 100000;
	const minIt = Math.min(opts.minIterations ?? 1000, maxIt);
	const conf = opts.confidence ?? 0.9999;
	const B = Math.max(1, opts.batchSize ?? 1);
	const [fLo, fHi] = opts.focalRange ?? [0.2, 5];
	const rng = createRng(opts.seed ?? 0);

	// centre the world points (precision of f32 GPU scoring; translation is restored at the end)
	const c = [0, 0, 0];
	for (let i = 0; i < n; i++)
		for (let k = 0; k < 3; k++) c[k] += points3d[i * 3 + k] / n;
	const X = new Float64Array(n * 3);
	for (let i = 0; i < n; i++)
		for (let k = 0; k < 3; k++) X[i * 3 + k] = points3d[i * 3 + k] - c[k];
	const obs = new Float64Array(n * 2);
	const bear = new Float64Array(n * 3);
	const xn = new Float64Array(n * 2);
	for (let i = 0; i < n; i++) {
		const dx = points2d[i * 2] - camera.cx;
		const dy = points2d[i * 2 + 1] - camera.cy;
		obs[i * 2] = dx;
		obs[i * 2 + 1] = dy;
		xn[i * 2] = dx / camera.fx;
		xn[i * 2 + 1] = dy / camera.fy;
		const l = Math.hypot(xn[i * 2], xn[i * 2 + 1], 1);
		bear[i * 3] = xn[i * 2] / l;
		bear[i * 3 + 1] = xn[i * 2 + 1] / l;
		bear[i * 3 + 2] = 1 / l;
	}
	const pick = new Int32Array(sampleSize);
	const sb = new Float64Array(9);
	const sX = new Float64Array(9);
	const Rs = new Float64Array(36);
	const ts = new Float64Array(12);

	type Model = { R: Float64Array; t: Float64Array; fx: number; fy: number };
	let best: Model | null = null;
	let bestCost = Number.POSITIVE_INFINITY;
	let bestCount = 0;
	let iterations = 0;
	let dynamic = maxIt;
	const one: HypothesisBatch = {
		mode: "reproj",
		hyps: new Float64Array(HYP_STRIDE),
		count: 1,
		a: X,
		b: obs,
		n,
		thr2,
	};
	const scoreOf = (m: Model) => {
		putHypothesis(one.hyps, 0, m.R, m.t, m.fx, m.fy);
		return scoreHypothesis(one, 0);
	};

	while (
		iterations < maxIt &&
		!(iterations >= minIt && iterations >= dynamic)
	) {
		const nb = Math.min(B, maxIt - iterations);
		const hyps = new Float64Array(nb * 4 * HYP_STRIDE);
		let k = 0;
		for (let s = 0; s < nb; s++) {
			sampleDistinct(rng, n, sampleSize, pick);
			if (free) {
				const m = dltFocal(xn, X, pick);
				if (m && m.scale > fLo && m.scale < fHi)
					putHypothesis(
						hyps,
						k++,
						m.R,
						m.t,
						camera.fx * m.scale,
						camera.fy * m.scale,
					);
			} else {
				for (let j = 0; j < 3; j++)
					for (let q = 0; q < 3; q++) {
						sb[j * 3 + q] = bear[pick[j] * 3 + q];
						sX[j * 3 + q] = X[pick[j] * 3 + q];
					}
				const m = p3pGrunert(sb, sX, Rs, ts);
				for (let j = 0; j < m; j++)
					putHypothesis(
						hyps,
						k++,
						Rs.subarray(j * 9, j * 9 + 9),
						ts.subarray(j * 3, j * 3 + 3),
						camera.fx,
						camera.fy,
					);
			}
		}
		iterations += nb;
		if (k > 0) {
			const batch: HypothesisBatch = {
				mode: "reproj",
				hyps: hyps.subarray(0, k * HYP_STRIDE),
				count: k,
				a: X,
				b: obs,
				n,
				thr2,
			};
			const win = yield batch;
			// re-score the winner in f64 (the GPU scores in f32)
			const sw = win.index >= 0 ? scoreHypothesis(batch, win.index) : null;
			if (sw && sw.cost < bestCost) {
				const o = win.index * HYP_STRIDE;
				best = {
					R: hyps.slice(o, o + 9),
					t: hyps.slice(o + 9, o + 12),
					fx: hyps[o + 12],
					fy: hyps[o + 13],
				};
				bestCost = sw.cost;
				bestCount = sw.count;
				// local optimisation: truncated-loss LM over all points (outliers get zero weight)
				const lo = {
					R: best.R.slice(),
					t: best.t.slice(),
					fx: best.fx,
					fy: best.fy,
				};
				refinePoseLm(X, obs, lo, {
					translation: true,
					focal: free,
					loss: "truncated",
					scale: thr,
					maxIterations: 25,
				});
				const s = scoreOf(lo);
				if (s.cost < bestCost) {
					best = lo;
					bestCost = s.cost;
					bestCount = s.count;
				}
				dynamic = Math.min(
					maxIt,
					trialsNeeded(bestCount / n, sampleSize, conf) * 3,
				);
			}
		}
	}
	if (!best) return null;
	const mask = new Uint8Array(n);
	putHypothesis(one.hyps, 0, best.R, best.t, best.fx, best.fy);
	scoreHypothesis(one, 0, mask);
	if (opts.refine ?? true) {
		const idx: number[] = [];
		for (let i = 0; i < n; i++) if (mask[i]) idx.push(i);
		if (idx.length >= sampleSize) {
			const fin = {
				R: best.R.slice(),
				t: best.t.slice(),
				fx: best.fx,
				fy: best.fy,
			};
			refinePoseLm(
				X,
				obs,
				fin,
				{
					translation: true,
					focal: free,
					loss: "cauchy",
					scale: 0.5 * thr,
					maxIterations: 100,
				},
				idx,
			);
			best = fin;
		}
	}
	const err = new Float64Array(n);
	putHypothesis(one.hyps, 0, best.R, best.t, best.fx, best.fy);
	const { count } = scoreHypothesis(one, 0, mask, err);
	let sum = 0;
	for (let i = 0; i < n; i++) if (mask[i]) sum += err[i];
	// undo the centring: p = R (X − c) + t = R X + (t − R c)
	const R = best.R;
	const t = new Float64Array(3);
	for (let k = 0; k < 3; k++)
		t[k] =
			best.t[k] - (R[k * 3] * c[0] + R[k * 3 + 1] * c[1] + R[k * 3 + 2] * c[2]);
	return {
		R,
		t,
		...(free ? { focal: best.fx } : {}),
		inliers: mask,
		inlierCount: count,
		iterations,
		rmsPx: count ? Math.sqrt(sum / count) : null,
	};
}

/**
 * Absolute pose from 2D–3D correspondences (points2d N×2 px, points3d N×3 world), poselib-style
 * LO-RANSAC. Pass camera {fx: 1, fy: 1, cx: 0, cy: 0} for normalised image coordinates (the threshold
 * is then in those units). Synchronous CPU path; absolutePoseRansacAsync scores batches on the GPU.
 */
export function absolutePoseRansac(
	points2d: Float64Array,
	points3d: Float64Array,
	camera: Intrinsics,
	opts: AbsolutePoseOptions = {},
): AbsolutePoseResult | null {
	return driveSync(absolutePoseLoop(points2d, points3d, camera, opts));
}
