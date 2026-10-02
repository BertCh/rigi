// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Pure-rotation RANSAC over bearing pairs: R with bearings1 ≈ R · bearings0. A port of
// tools/nearfield/propagate/run_propagate.py rot_ransac (the relative-rotation service's estimator):
// 2-point Kabsch hypotheses, inlier = chord |b1 − R b0| below the threshold, the first hypothesis with
// the strictly highest count wins, then 3 Kabsch re-fits on the inliers.
// The service's threshold is a chord of thr_px / f_B; pass maxErrorDeg = 2·asin(thr/2) (≈ thr in rad),
// or use maxChord directly.
import {
	chord2OfAngle,
	driveSync,
	HYP_STRIDE,
	type HypothesisBatch,
	putHypothesis,
	type RansacLoop,
	scoreHypothesis,
} from "./batch";
import { createRng, sampleDistinct, trialsNeeded } from "./rng";
import { kabsch } from "./rot3";

export type RotationRansacOptions = {
	/** Inlier threshold as the angle between b1 and R b0, degrees (default 0.25). */
	maxErrorDeg?: number;
	/** Inlier threshold as a chord length (overrides maxErrorDeg; the service uses thr_px / f_B). */
	maxChord?: number;
	/** Hypotheses (default 2000, as the service). */
	maxIterations?: number;
	/**
	 * Adaptive stop: end once an all-inlier pair was drawn with this probability (checked every 256
	 * hypotheses). Default: none, all maxIterations hypotheses are scored (the service's behaviour).
	 */
	confidence?: number;
	seed?: number;
	/** Kabsch re-fits on the inliers after the search (default 3, as the service). */
	refineRounds?: number;
};

export type RotationRansacResult = {
	/** Row-major, bearings1 ≈ R bearings0. */
	R: Float64Array;
	inliers: Uint8Array;
	inlierCount: number;
	iterations: number;
	/** RMS chord over the final inliers (≈ rad; × f_B = the service's rmsPx); null with no inliers. */
	rmsChord: number | null;
};

const BATCH = 256;

export function* rotationRansacLoop(
	bearings0: Float64Array,
	bearings1: Float64Array,
	opts: RotationRansacOptions = {},
): RansacLoop<RotationRansacResult | null> {
	const n = Math.min(bearings0.length, bearings1.length) / 3;
	if (n < 3) return null;
	const thr2 =
		opts.maxChord !== undefined
			? opts.maxChord ** 2
			: chord2OfAngle(((opts.maxErrorDeg ?? 0.25) * Math.PI) / 180);
	const total = Math.max(1, opts.maxIterations ?? 2000);
	const rng = createRng(opts.seed ?? 0);
	const pick = new Int32Array(2);
	const R = new Float64Array(9);
	let bestR: Float64Array | null = null;
	let bestCount = -1;
	let done = 0;
	let needed = total;
	while (done < Math.min(total, needed)) {
		const k =
			opts.confidence !== undefined
				? Math.min(BATCH, total - done)
				: total - done;
		const batch: HypothesisBatch = {
			mode: "chord",
			hyps: new Float64Array(k * HYP_STRIDE),
			count: k,
			a: bearings0,
			b: bearings1,
			n,
			thr2,
		};
		for (let j = 0; j < k; j++) {
			sampleDistinct(rng, n, 2, pick);
			kabsch(bearings0, bearings1, pick, R);
			putHypothesis(batch.hyps, j, R, null);
		}
		const win = yield batch;
		done += k;
		// re-score the winner in f64 (the GPU scores in f32)
		const sw = win.index >= 0 ? scoreHypothesis(batch, win.index) : null;
		if (sw && sw.count > bestCount) {
			bestCount = sw.count;
			bestR = batch.hyps.slice(
				win.index * HYP_STRIDE,
				win.index * HYP_STRIDE + 9,
			);
		}
		if (opts.confidence !== undefined)
			needed = trialsNeeded(bestCount / n, 2, opts.confidence);
	}
	if (!bestR) return null;
	return refineRotation(
		bearings0,
		bearings1,
		bestR,
		thr2,
		opts.refineRounds ?? 3,
		done,
	);
}

/** The service's post-search re-fit (rot_ransac's 3-round loop), and its RMS. */
export function refineRotation(
	b0: Float64Array,
	b1: Float64Array,
	R0: Float64Array,
	thr2: number,
	rounds: number,
	iterations: number,
): RotationRansacResult {
	const n = Math.min(b0.length, b1.length) / 3;
	const one: HypothesisBatch = {
		mode: "chord",
		hyps: new Float64Array(HYP_STRIDE),
		count: 1,
		a: b0,
		b: b1,
		n,
		thr2,
	};
	const mask = new Uint8Array(n);
	const err = new Float64Array(n);
	putHypothesis(one.hyps, 0, R0, null);
	let { count } = scoreHypothesis(one, 0, mask);
	let R: Float64Array = R0.slice();
	for (let r = 0; r < rounds; r++) {
		const idx: number[] = [];
		for (let i = 0; i < n; i++) if (mask[i]) idx.push(i);
		R = kabsch(b0, b1, idx);
		putHypothesis(one.hyps, 0, R, null);
		({ count } = scoreHypothesis(one, 0, mask, err));
		if (count < 3) break;
	}
	let s = 0;
	for (let i = 0; i < n; i++) if (mask[i]) s += err[i];
	return {
		R,
		inliers: mask,
		inlierCount: count,
		iterations,
		rmsChord: count ? Math.sqrt(s / count) : null,
	};
}

/**
 * Pure-rotation RANSAC on unit bearings (N×3 each): R with bearings1 ≈ R bearings0. Null when N < 3.
 * Synchronous CPU path; rotationRansacAsync scores large batches on the GPU.
 */
export function rotationRansac(
	bearings0: Float64Array,
	bearings1: Float64Array,
	opts: RotationRansacOptions = {},
): RotationRansacResult | null {
	return driveSync(rotationRansacLoop(bearings0, bearings1, opts));
}
