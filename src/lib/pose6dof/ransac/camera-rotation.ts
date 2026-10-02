// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Camera rotation with the centre fixed at the eye (+ optional focal): a port of
// tools/matcher/match.py solve_rotation, the solver behind the matcher service's render-match
// (server/core.py solve, server/fuse.py). 2-point TRIAD hypotheses per focal candidate
// (f0 × 0.9 … 1.1 when the focal is free), inlier = angle(R d, ray) < thr / f, the strictly best
// count wins; then 3 rounds of { inliers at 1.5 thr in px, robust LM (soft_l1, f_scale 2) on the
// rotation (+ log focal with a 5 % prior) }, and the final inliers at thr.
import {
	chord2OfAngle,
	driveSync,
	HYP_STRIDE,
	type HypothesisBatch,
	putHypothesis,
	type RansacLoop,
} from "./batch";
import { refinePoseLm } from "./lm";
import { createRng, sampleDistinct } from "./rng";
import type { Mat3 } from "./rot3";

export type Intrinsics = { fx: number; fy: number; cx: number; cy: number };

export type CameraRotationOptions = {
	/** Inlier threshold, px (default 6, match.py PX_THRESH). */
	maxReprojErrorPx?: number;
	/** Hypotheses per focal candidate (default 3000). */
	maxIterations?: number;
	seed?: number;
	/** "free": search f × focalScales and refine the focal with a log prior (default "fixed"). */
	focal?: "fixed" | "free";
	focalScales?: number[];
	/** σ of the log-focal prior (default 0.05). */
	focalPriorSigma?: number;
	/** Fewer inliers than this after a re-fit → null (default 6). */
	minInliers?: number;
};

export type CameraRotationResult = {
	/** World → camera (OpenCV axes: x right, y down, z forward), row-major. */
	R: Float64Array;
	/** Solved fx (fy scales with it). */
	focal: number;
	inliers: Uint8Array;
	inlierCount: number;
	rmsPx: number | null;
	iterations: number;
};

/** TRIAD: R with R a1 ∥ b1 and R (a1 × a2) ∥ (b1 × b2). */
export function triad(
	a1: ArrayLike<number>,
	a2: ArrayLike<number>,
	b1: ArrayLike<number>,
	b2: ArrayLike<number>,
	out: Mat3 = new Float64Array(9),
): Mat3 {
	const A = frame(a1, a2);
	const B = frame(b1, b2);
	// R = B Aᵀ (frames as columns)
	for (let r = 0; r < 3; r++)
		for (let c = 0; c < 3; c++)
			out[r * 3 + c] = B[r] * A[c] + B[3 + r] * A[3 + c] + B[6 + r] * A[6 + c];
	return out;
}

/** Orthonormal frame [t1, t2, t3] (stored as three consecutive vectors). */
function frame(v1: ArrayLike<number>, v2: ArrayLike<number>) {
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
	return [...t1, ...t2, ...t3];
}

/** Unit world directions and principal-point offsets for the solver. */
export function cameraRotationInputs(
	points2d: Float64Array,
	worldDirs: Float64Array,
	camera: Intrinsics,
) {
	const n = Math.min(points2d.length / 2, worldDirs.length / 3);
	const dirs = new Float64Array(n * 3);
	const obs = new Float64Array(n * 2);
	for (let i = 0; i < n; i++) {
		const x = worldDirs[i * 3];
		const y = worldDirs[i * 3 + 1];
		const z = worldDirs[i * 3 + 2];
		const l = Math.hypot(x, y, z) || 1;
		dirs[i * 3] = x / l;
		dirs[i * 3 + 1] = y / l;
		dirs[i * 3 + 2] = z / l;
		obs[i * 2] = points2d[i * 2] - camera.cx;
		obs[i * 2 + 1] = points2d[i * 2 + 1] - camera.cy;
	}
	return { n, dirs, obs };
}

export function* cameraRotationLoop(
	points2d: Float64Array,
	worldDirs: Float64Array,
	camera: Intrinsics,
	opts: CameraRotationOptions = {},
): RansacLoop<CameraRotationResult | null> {
	const { n, dirs, obs } = cameraRotationInputs(points2d, worldDirs, camera);
	const minInl = opts.minInliers ?? 6;
	if (n < minInl) return null;
	const thr = opts.maxReprojErrorPx ?? 6;
	const iters = Math.max(1, opts.maxIterations ?? 3000);
	const free = opts.focal === "free";
	const scales = free ? (opts.focalScales ?? [0.9, 0.95, 1, 1.05, 1.1]) : [1];
	const rng = createRng(opts.seed ?? 0);
	const K = iters * scales.length;
	const batch: HypothesisBatch = {
		mode: "angular",
		hyps: new Float64Array(K * HYP_STRIDE),
		count: K,
		a: dirs,
		b: obs,
		n,
		thr2: 0,
	};
	const pick = new Int32Array(2);
	const R = new Float64Array(9);
	const b1 = new Float64Array(3);
	const b2 = new Float64Array(3);
	const ray = (i: number, fx: number, fy: number, out: Float64Array) => {
		const x = obs[i * 2] / fx;
		const y = obs[i * 2 + 1] / fy;
		const l = Math.sqrt(x * x + y * y + 1);
		out[0] = x / l;
		out[1] = y / l;
		out[2] = 1 / l;
	};
	let k = 0;
	for (const s of scales) {
		const fx = camera.fx * s;
		const fy = camera.fy * s;
		const c2 = chord2OfAngle(thr / fx);
		for (let j = 0; j < iters; j++, k++) {
			sampleDistinct(rng, n, 2, pick);
			ray(pick[0], fx, fy, b1);
			ray(pick[1], fx, fy, b2);
			triad(
				dirs.subarray(pick[0] * 3, pick[0] * 3 + 3),
				dirs.subarray(pick[1] * 3, pick[1] * 3 + 3),
				b1,
				b2,
				R,
			);
			putHypothesis(batch.hyps, k, R, null, fx, fy, c2);
		}
	}
	const win = yield batch;
	if (win.index < 0) return null;
	const o = win.index * HYP_STRIDE;
	const state = {
		R: batch.hyps.slice(o, o + 9),
		t: new Float64Array(3),
		fx: batch.hyps[o + 12],
		fy: batch.hyps[o + 13],
	};
	const logF0 = Math.log(camera.fx);
	for (let round = 0; round < 3; round++) {
		const { mask, count } = inliersPx(dirs, obs, n, state, thr * 1.5);
		if (count < minInl) return null;
		const idx: number[] = [];
		for (let i = 0; i < n; i++) if (mask[i]) idx.push(i);
		refinePoseLm(
			dirs,
			obs,
			state,
			{
				translation: false,
				focal: free,
				focalPrior: free
					? {
							logScale: logF0 - Math.log(state.fx),
							sigma: opts.focalPriorSigma ?? 0.05,
						}
					: undefined,
				loss: "soft_l1",
				scale: 2,
			},
			idx,
		);
	}
	const fin = inliersPx(dirs, obs, n, state, thr);
	return {
		R: state.R,
		focal: state.fx,
		inliers: fin.mask,
		inlierCount: fin.count,
		rmsPx: fin.count ? Math.sqrt(fin.sum / fin.count) : null,
		iterations: K,
	};
}

/** Pixel inliers (in front, error < thr) of a centred camera, with Σ e² over them. */
function inliersPx(
	dirs: Float64Array,
	obs: Float64Array,
	n: number,
	s: { R: ArrayLike<number>; fx: number; fy: number },
	thr: number,
) {
	const R = s.R;
	const mask = new Uint8Array(n);
	let count = 0;
	let sum = 0;
	for (let i = 0; i < n; i++) {
		const x = dirs[i * 3];
		const y = dirs[i * 3 + 1];
		const z = dirs[i * 3 + 2];
		const pz = R[6] * x + R[7] * y + R[8] * z;
		if (!(pz > 0)) continue;
		const du = (s.fx * (R[0] * x + R[1] * y + R[2] * z)) / pz - obs[i * 2];
		const dv = (s.fy * (R[3] * x + R[4] * y + R[5] * z)) / pz - obs[i * 2 + 1];
		const e2 = du * du + dv * dv;
		if (e2 < thr * thr) {
			mask[i] = 1;
			count++;
			sum += e2;
		}
	}
	return { mask, count, sum };
}

/**
 * Camera rotation with the centre fixed (match.py solve_rotation). points2d: N×2 px; worldDirs: N×3
 * (X − eye, any length). Null below minInliers. Synchronous CPU path (cameraRotationRansacAsync: GPU scoring).
 */
export function cameraRotationRansac(
	points2d: Float64Array,
	worldDirs: Float64Array,
	camera: Intrinsics,
	opts: CameraRotationOptions = {},
): CameraRotationResult | null {
	return driveSync(cameraRotationLoop(points2d, worldDirs, camera, opts));
}
