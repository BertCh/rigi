// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The render-match building blocks (port of tools/matcher/server/core.py and match.py lift):
// lifting render keypoints through a view's xyz buffer, the stale-buffer check, frame coverage, and
// the legacy v0.1 render-match solve with its heuristic confidence (still used for stage-1 sweeps and
// as `matchConfidence`).

import type { Pose } from "#/lib/camera";
import type { Corr } from "./fusion";
import {
	dang,
	focalPx,
	median,
	plainPose,
	poseToR,
	round,
	rToPose,
	vfovFromF,
} from "./geometry";
import { solveRotation } from "./rotation";

export const MIN_RANGE = 250.0;

/** One rendered view: satellite-style RGBA + ENU xyz per pixel (H×W×3, row 0 = top, sky = 0,0,0). */
export type View = {
	tag: string;
	pose: Pose;
	W: number;
	H: number;
	rgba: Uint8ClampedArray | Uint8Array;
	xyz: Float32Array;
};

export type PerView = {
	tag: string;
	matches: number;
	lifted: number;
	keypoints: number;
	terrainFrac: number;
	rgbStd: number;
};

/** Correspondences from correspond(): lifted photo↔ENU pairs over every view, plus per-view stats. */
export type Correspondences = Corr & { perView: PerView[]; matchMs: number };

/** numpy round (half to even). */
const roundHalfEven = (x: number) => {
	const r = Math.round(x);
	return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
};

/**
 * match.lift: render keypoints (N×2 px) → ENU points, dropping sky, terrain nearer than `minRange` and
 * depth discontinuities (5×5 range spread > 8 %). Returns X (N×3) and the keep mask.
 */
export function lift(
	kp: ArrayLike<number>,
	xyz: Float32Array,
	W: number,
	H: number,
	eye: ArrayLike<number>,
	minRange = MIN_RANGE,
): { X: Float64Array; ok: Uint8Array } {
	const n = kp.length / 2;
	const X = new Float64Array(n * 3);
	const ok = new Uint8Array(n);
	const rangeAt = (x: number, y: number) => {
		const i = (y * W + x) * 3;
		const a = xyz[i];
		const b = xyz[i + 1];
		const c = xyz[i + 2];
		if (a === 0 && b === 0 && c === 0) return Number.POSITIVE_INFINITY;
		return Math.hypot(a - eye[0], b - eye[1], c - eye[2]);
	};
	for (let k = 0; k < n; k++) {
		const xi = Math.min(Math.max(roundHalfEven(kp[k * 2]), 0), W - 1);
		const yi = Math.min(Math.max(roundHalfEven(kp[k * 2 + 1]), 0), H - 1);
		const i = (yi * W + xi) * 3;
		X[k * 3] = xyz[i];
		X[k * 3 + 1] = xyz[i + 1];
		X[k * 3 + 2] = xyz[i + 2];
		const r0 = rangeAt(xi, yi);
		if (!(Number.isFinite(r0) && r0 > minRange)) continue;
		let lo = Number.POSITIVE_INFINITY;
		let hi = 0;
		for (let dy = -2; dy <= 2; dy++)
			for (let dx = -2; dx <= 2; dx++) {
				const v = rangeAt(
					Math.min(Math.max(xi + dx, 0), W - 1),
					Math.min(Math.max(yi + dy, 0), H - 1),
				);
				if (v < lo) lo = v;
				if (v > hi) hi = v;
			}
		if (hi < lo * 1.08) ok[k] = 1;
	}
	return { X, ok };
}

/**
 * core.check_view: median reprojection (px) of up to 300 terrain pixels of the view's own xyz under
 * its pose (catches stale geometry buffers). Samples a fixed stride instead of numpy's rng choice.
 */
export function checkView(v: View, eye: ArrayLike<number>): number {
	const { W, H, xyz } = v;
	const terrain: number[] = [];
	for (let i = 0; i < W * H; i++)
		if (xyz[i * 3] !== 0 || xyz[i * 3 + 1] !== 0 || xyz[i * 3 + 2] !== 0)
			terrain.push(i);
	if (!terrain.length) return Number.POSITIVE_INFINITY;
	const m = Math.min(300, terrain.length);
	const R = poseToR(v.pose);
	const fp = focalPx(v.pose.vfov, H);
	const errs: number[] = [];
	for (let k = 0; k < m; k++) {
		const i = terrain[Math.floor((k * terrain.length) / m)];
		const x = xyz[i * 3] - eye[0];
		const y = xyz[i * 3 + 1] - eye[1];
		const z = xyz[i * 3 + 2] - eye[2];
		const c0 = R[0] * x + R[1] * y + R[2] * z;
		const c1 = R[3] * x + R[4] * y + R[5] * z;
		const c2 = R[6] * x + R[7] * y + R[8] * z;
		if (!(c2 > 0)) continue;
		const px = i % W;
		const py = Math.floor(i / W);
		errs.push(
			Math.hypot(
				W / 2 + (fp * c0) / c2 - (px + 0.5),
				H / 2 + (fp * c1) / c2 - (py + 0.5),
			),
		);
	}
	return errs.length ? median(errs) : Number.POSITIVE_INFINITY;
}

/** core.coverage: fraction of an nx×ny grid holding ≥ minPts of the points (N×2). */
export function coverage(
	x2d: ArrayLike<number>,
	W: number,
	H: number,
	nx = 4,
	ny = 3,
	minPts = 3,
): number {
	const n = x2d.length / 2;
	if (!n) return 0;
	const cnt = new Int32Array(nx * ny);
	for (let i = 0; i < n; i++) {
		const gx = Math.min(Math.max(Math.trunc((x2d[i * 2] / W) * nx), 0), nx - 1);
		const gy = Math.min(
			Math.max(Math.trunc((x2d[i * 2 + 1] / H) * ny), 0),
			ny - 1,
		);
		cnt[gy * nx + gx]++;
	}
	let k = 0;
	for (const c of cnt) if (c >= minPts) k++;
	return k / (nx * ny);
}

const sat = (x: number) => Math.max(0, Math.min(1, x));

export type LegacySolve = {
	nLifted: number;
	perView: PerView[];
	timingMs: Record<string, number>;
	pose: Pose | null;
	inliers: number;
	confidence: number;
	reason?: string;
	inlierFrac?: number;
	residualPx?: number | null;
	coverage?: number;
	deltaYawFromPrior?: number;
	focalPx?: number;
	freeFocal?: boolean;
	size?: { W: number; H: number };
};

/** Select rows of a correspondence set. */
export function subsetCorr<T extends Corr>(c: T, mask: ArrayLike<number>): T {
	const idx: number[] = [];
	for (let i = 0; i < mask.length; i++) if (mask[i]) idx.push(i);
	const x2d = new Float64Array(idx.length * 2);
	const X = new Float64Array(idx.length * 3);
	idx.forEach((i, k) => {
		x2d[k * 2] = c.x2d[i * 2];
		x2d[k * 2 + 1] = c.x2d[i * 2 + 1];
		X[k * 3] = c.X[i * 3];
		X[k * 3 + 1] = c.X[i * 3 + 1];
		X[k * 3 + 2] = c.X[i * 3 + 2];
	});
	return { ...c, x2d, X };
}

/** core.solve: legacy render-match (rotation RANSAC + LM, centre at the eye) with the v0.1 confidence. */
export async function legacySolve(
	corr: Correspondences,
	views: Pick<View, "pose">[],
	eye: ArrayLike<number>,
	prior: Pose,
	opts: { freeFocal?: boolean } = {},
): Promise<LegacySolve> {
	const { x2d, X, W, H, perView } = corr;
	const freeFocal = !!opts.freeFocal;
	const f0 = focalPx(prior.vfov, H);
	const t1 = performance.now();
	const s = await solveRotation(x2d, X, eye, W, H, f0, freeFocal, {});
	const solveMs = performance.now() - t1;
	const base = {
		nLifted: x2d.length / 2,
		perView,
		timingMs: { match: Math.round(corr.matchMs), solve: Math.round(solveMs) },
	};
	if (!s)
		return {
			...base,
			pose: null,
			inliers: 0,
			confidence: 0.0,
			reason: "too few lifted matches",
		};
	const pose = rToPose(s.R, vfovFromF(s.f, H));
	let nInl = 0;
	for (const v of s.inliers) nInl += v;
	const frac = s.inliers.length ? nInl / s.inliers.length : 0;
	const resid = s.rmse;
	const cov = coverage(subsetCorr(corr, s.inliers).x2d, W, H);
	const dyaw = dang(pose.yaw, prior.yaw);
	const span =
		Math.max(...views.map((v) => Math.abs(v.pose.yaw - prior.yaw))) +
		prior.vfov * 0.5 * (W / H);
	// heuristic, uncalibrated: enough inliers, consistent, spread over the frame, tight fit, in the fan
	const conf =
		sat(nInl / 200) *
		sat(frac / 0.6) *
		sat(cov / 0.4) *
		(resid == null || resid <= 3.5 ? 1.0 : 3.5 / resid) *
		(Math.abs(dyaw) <= span ? 1.0 : 0.0);
	return {
		...base,
		pose: plainPose(pose),
		inliers: nInl,
		inlierFrac: round(frac, 4),
		residualPx: resid == null ? null : round(resid, 3),
		coverage: round(cov, 3),
		deltaYawFromPrior: round(dyaw, 3),
		confidence: round(conf, 3),
		focalPx: round(s.f, 2),
		freeFocal,
		size: { W, H },
	};
}
