// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Batched RANSAC hypothesis scoring: K hypotheses × N correspondences → the winner. The CPU scorer
// here (f64) is the reference twin of the GPU kernel in src/lib/gpu/ransac (f32, one workgroup per
// hypothesis, arg-max on the GPU, only the winner read back). Both take the same packed batch.
//
// Hypothesis layout, HYP_STRIDE f64 per hypothesis:
//   [0..8] R row-major, [9..11] t, [12] fx, [13] fy, [14] per-hypothesis chord² threshold (angular), [15] 0
// Correspondence layout: `a` N×3, `b` N×3 (chord) or N×2 (angular, reproj: px offsets from the principal point).
// Modes:
//   chord   |b − R a|² < thr2                                    (pure rotation on bearings; count wins)
//   angular |normalize(b.x/fx, b.y/fy, 1) − R a|² < hyp[14]       (fixed-centre camera rotation; count wins)
//   reproj  |(fx p.x/p.z, fy p.y/p.z) − b|² < thr2, p = R a + t, behind = outlier (MSAC cost wins)
// Winner: the highest count (chord, angular) or the lowest MSAC cost Σ min(e², thr2) (reproj); ties go
// to the lowest index, as a sequential loop that only replaces on a strict improvement.

export const HYP_STRIDE = 16;
export type ScoreMode = "chord" | "angular" | "reproj";

export type HypothesisBatch = {
	mode: ScoreMode;
	/** count × HYP_STRIDE */
	hyps: Float64Array;
	count: number;
	a: Float64Array;
	b: Float64Array;
	n: number;
	/** Squared threshold (chord: chord², reproj: px²; angular uses hyp[14]). */
	thr2: number;
};

export type BatchWinner = { index: number; count: number; cost: number };

/** Score of one hypothesis (count of inliers and MSAC cost), optionally writing the inlier mask. */
export function scoreHypothesis(
	batch: HypothesisBatch,
	k: number,
	mask?: Uint8Array,
	errors?: Float64Array,
): { count: number; cost: number } {
	const h = batch.hyps;
	const o = k * HYP_STRIDE;
	const r0 = h[o];
	const r1 = h[o + 1];
	const r2 = h[o + 2];
	const r3 = h[o + 3];
	const r4 = h[o + 4];
	const r5 = h[o + 5];
	const r6 = h[o + 6];
	const r7 = h[o + 7];
	const r8 = h[o + 8];
	const { a, b, n, thr2 } = batch;
	let count = 0;
	let cost = 0;
	if (batch.mode === "chord") {
		for (let i = 0; i < n; i++) {
			const x = a[i * 3];
			const y = a[i * 3 + 1];
			const z = a[i * 3 + 2];
			const dx = b[i * 3] - (r0 * x + r1 * y + r2 * z);
			const dy = b[i * 3 + 1] - (r3 * x + r4 * y + r5 * z);
			const dz = b[i * 3 + 2] - (r6 * x + r7 * y + r8 * z);
			const e2 = dx * dx + dy * dy + dz * dz;
			const inl = e2 < thr2;
			if (inl) count++;
			if (mask) mask[i] = inl ? 1 : 0;
			if (errors) errors[i] = e2;
			cost += e2 < thr2 ? e2 : thr2;
		}
	} else if (batch.mode === "angular") {
		const fx = h[o + 12];
		const fy = h[o + 13];
		const t2 = h[o + 14];
		for (let i = 0; i < n; i++) {
			const x = a[i * 3];
			const y = a[i * 3 + 1];
			const z = a[i * 3 + 2];
			let qx = b[i * 2] / fx;
			let qy = b[i * 2 + 1] / fy;
			const inv = 1 / Math.sqrt(qx * qx + qy * qy + 1);
			qx *= inv;
			qy *= inv;
			const dx = qx - (r0 * x + r1 * y + r2 * z);
			const dy = qy - (r3 * x + r4 * y + r5 * z);
			const dz = inv - (r6 * x + r7 * y + r8 * z);
			const e2 = dx * dx + dy * dy + dz * dz;
			const inl = e2 < t2;
			if (inl) count++;
			if (mask) mask[i] = inl ? 1 : 0;
			if (errors) errors[i] = e2;
			cost += e2 < t2 ? e2 : t2;
		}
	} else {
		const t0 = h[o + 9];
		const t1 = h[o + 10];
		const tz = h[o + 11];
		const fx = h[o + 12];
		const fy = h[o + 13];
		for (let i = 0; i < n; i++) {
			const x = a[i * 3];
			const y = a[i * 3 + 1];
			const z = a[i * 3 + 2];
			const pz = r6 * x + r7 * y + r8 * z + tz;
			let e2 = Number.POSITIVE_INFINITY;
			if (pz > 0) {
				const du = (fx * (r0 * x + r1 * y + r2 * z + t0)) / pz - b[i * 2];
				const dv = (fy * (r3 * x + r4 * y + r5 * z + t1)) / pz - b[i * 2 + 1];
				e2 = du * du + dv * dv;
			}
			const inl = e2 < thr2;
			if (inl) count++;
			if (mask) mask[i] = inl ? 1 : 0;
			if (errors) errors[i] = e2;
			cost += inl ? e2 : thr2;
		}
	}
	return { count, cost };
}

export const winsByCost = (mode: ScoreMode) => mode === "reproj";

/** The CPU twin of the GPU scorer: the winner of a batch. */
export function scoreBatchCpu(batch: HypothesisBatch): BatchWinner {
	const byCost = winsByCost(batch.mode);
	let best: BatchWinner = {
		index: -1,
		count: -1,
		cost: Number.POSITIVE_INFINITY,
	};
	for (let k = 0; k < batch.count; k++) {
		const s = scoreHypothesis(batch, k);
		if (byCost ? s.cost < best.cost : s.count > best.count)
			best = { index: k, ...s };
	}
	return best;
}

/** Scorer used by the RANSAC drivers: sync on the CPU, or async (GPU, with the CPU as fallback). */
export type BatchScorer = (
	batch: HypothesisBatch,
) => BatchWinner | Promise<BatchWinner>;

/** Write R (row-major 9), t and fx / fy into hypothesis slot k. */
export function putHypothesis(
	hyps: Float64Array,
	k: number,
	R: ArrayLike<number>,
	t: ArrayLike<number> | null,
	fx = 1,
	fy = 1,
	chord2 = 0,
) {
	const o = k * HYP_STRIDE;
	for (let i = 0; i < 9; i++) hyps[o + i] = R[i];
	hyps[o + 9] = t ? t[0] : 0;
	hyps[o + 10] = t ? t[1] : 0;
	hyps[o + 11] = t ? t[2] : 0;
	hyps[o + 12] = fx;
	hyps[o + 13] = fy;
	hyps[o + 14] = chord2;
	hyps[o + 15] = 0;
}

/** Chord² between unit vectors at angle θ (rad): 2 − 2 cos θ, written stably. */
export const chord2OfAngle = (theta: number) => {
	const s = 2 * Math.sin(theta / 2);
	return s * s;
};

/**
 * RANSAC drivers are generators that yield batches and receive their winners, so the same loop runs
 * synchronously on the CPU scorer or asynchronously on the GPU one.
 */
export type RansacLoop<T> = Generator<HypothesisBatch, T, BatchWinner>;

export function driveSync<T>(
	loop: RansacLoop<T>,
	scorer: (b: HypothesisBatch) => BatchWinner = scoreBatchCpu,
): T {
	let step = loop.next(undefined as unknown as BatchWinner);
	while (!step.done) step = loop.next(scorer(step.value));
	return step.value;
}

export async function driveAsync<T>(
	loop: RansacLoop<T>,
	scorer: BatchScorer,
): Promise<T> {
	let step = loop.next(undefined as unknown as BatchWinner);
	while (!step.done) step = loop.next(await scorer(step.value));
	return step.value;
}
