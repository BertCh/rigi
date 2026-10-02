// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Keypoint parity between two weight files of ViTPose-B (fp16 vs int8): per keypoint the decoded position
// difference in the 192 x 256 network input frame, the heatmap peak change and whether the argmax cell moved.
// Pure CPU, used by scripts/body/vitpose-weights-eval.ts.
import { decodeHeatmaps, VITPOSE_B } from "./vitpose";

export type KeypointDiff = {
	/** decoded position difference, pixels of the network input frame */
	errPx: number;
	/** |score_b - score_a| (heatmap peak) */
	scoreDelta: number;
	/** peak of the reference heatmap */
	scoreA: number;
	/** the argmax heatmap cell differs */
	argmaxMoved: boolean;
};

function argmax(hm: Float32Array, offset: number, n: number): number {
	let best = 0;
	for (let i = 1; i < n; i++) if (hm[offset + i] > hm[offset + best]) best = i;
	return best;
}

/** Per keypoint differences of heatmaps `b` against the reference `a` (both [K, H, W]). */
export function compareHeatmaps(
	a: Float32Array,
	b: Float32Array,
	K: number,
	H: number = VITPOSE_B.heatmap[0],
	W: number = VITPOSE_B.heatmap[1],
): KeypointDiff[] {
	const [IH, IW] = VITPOSE_B.input;
	const sx = (IW - 1) / (W - 1);
	const sy = (IH - 1) / (H - 1);
	const da = decodeHeatmaps(a, K, H, W);
	const db = decodeHeatmaps(b, K, H, W);
	const out: KeypointDiff[] = [];
	for (let k = 0; k < K; k++)
		out.push({
			errPx: Math.hypot((db.x[k] - da.x[k]) * sx, (db.y[k] - da.y[k]) * sy),
			scoreDelta: Math.abs(db.score[k] - da.score[k]),
			scoreA: da.score[k],
			argmaxMoved: argmax(a, k * H * W, H * W) !== argmax(b, k * H * W, H * W),
		});
	return out;
}

/** Nearest-rank-with-interpolation percentile (q in 0..1) of a list; NaN for an empty list. */
export function percentile(values: readonly number[], q: number): number {
	if (!values.length) return Number.NaN;
	const s = [...values].sort((x, y) => x - y);
	const p = (s.length - 1) * Math.min(1, Math.max(0, q));
	const lo = Math.floor(p);
	const hi = Math.ceil(p);
	return s[lo] + (s[hi] - s[lo]) * (p - lo);
}

export type ParitySummary = {
	count: number;
	errMedian: number;
	errP90: number;
	errMax: number;
	scoreDeltaMedian: number;
	scoreDeltaMax: number;
	argmaxMovedFraction: number;
};

/** Median / p90 / max of the position error, the peak change and the moved-argmax fraction. */
export function summarizeParity(diffs: readonly KeypointDiff[]): ParitySummary {
	const err = diffs.map((d) => d.errPx);
	const sc = diffs.map((d) => d.scoreDelta);
	return {
		count: diffs.length,
		errMedian: percentile(err, 0.5),
		errP90: percentile(err, 0.9),
		errMax: err.length ? Math.max(...err) : Number.NaN,
		scoreDeltaMedian: percentile(sc, 0.5),
		scoreDeltaMax: sc.length ? Math.max(...sc) : Number.NaN,
		argmaxMovedFraction: diffs.length
			? diffs.filter((d) => d.argmaxMoved).length / diffs.length
			: Number.NaN,
	};
}
