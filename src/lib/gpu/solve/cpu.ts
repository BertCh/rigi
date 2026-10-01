// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// CPU reference for solvePose's coarse stage (src/lib/geo/solve.ts coarseStage, "Coarse: small-angle
// grid over (dYaw, dPitch)"): the exact score of one yaw row, the whole-grid twin and the selection of
// seeds / coarse winner / ambiguity.
//
// The plan (observations, grids, truncation) and the per-cell cost are solve.ts's own (planCoarse,
// coarseCost), re-exported here; the selection is rebuilt with the same expressions in the same
// order, and the bench (scripts/gpu/solve-bench.mjs) checks the result against solvePose's own
// SolveResult (coarse, and ambiguity, which depends on the winner's, the runner-up's and the median
// cost) bit for bit.

import {
	type CoarsePlan,
	coarseCost,
	DEFAULT_SIGMA,
	type SolveOptions,
} from "#/lib/geo/solve";

export { type CoarsePlan, coarseCost, planCoarse } from "#/lib/geo/solve";

/** One yawCosts entry of solveOnce: the best pitch at a yaw offset. */
export type YawCost = { dy: number; dp: number; c: number };

/** solvePose's options for its full-360° pass (solve.ts fullOpts, minus the accept threshold). */
export function fullSearchOptions(opts: SolveOptions = {}): SolveOptions {
	return {
		...opts,
		yawRange: 180,
		sigma: { ...(opts.sigma ?? DEFAULT_SIGMA), yaw: 1e6 },
	};
}

/**
 * One yaw row of solveOnce's grid: the first pitch with the lowest cost. `from`..`to` (inclusive)
 * limits the scan to pitches known to hold that first minimum (every other pitch costs strictly more).
 */
export function coarseRow(
	p: CoarsePlan,
	iy: number,
	from = 0,
	to = p.dps.length - 1,
): YawCost {
	const dy = p.dys[iy];
	let best = { dy, dp: 0, c: Number.POSITIVE_INFINITY };
	for (let j = from; j <= to; j++) {
		const dp = p.dps[j];
		const c = coarseCost(p, dy, dp);
		if (c < best.c) best = { dy, dp, c };
	}
	return best;
}

/** What solveOnce takes from its coarse stage into the fine stage and the SolveResult. */
export type CoarseResult = {
	/** SolveResult.coarse (minima[0]) */
	coarse: { yaw: number; pitch: number };
	/** LM start offsets, best first (≤ 3, > 1.5° apart) */
	seeds: YawCost[];
	/** SolveResult.ambiguity */
	ambiguity: number;
	best: YawCost;
	runnerUp: YawCost | undefined;
	medianCost: number;
	nYaw: number;
	nPitch: number;
};

/** solveOnce's selection over the full yawCosts list (minima, seeds, runner-up, median, ambiguity). */
export function selectCoarse(
	yawCosts: YawCost[],
	nPitch: number,
): CoarseResult {
	const minima = yawCosts
		.filter(
			(v, i) =>
				(i === 0 || v.c <= yawCosts[i - 1].c) &&
				(i === yawCosts.length - 1 || v.c <= yawCosts[i + 1].c),
		)
		.sort((a, b) => a.c - b.c);
	const seeds: YawCost[] = [];
	for (const m of minima) {
		if (seeds.every((s) => Math.abs(s.dy - m.dy) > 1.5)) seeds.push(m);
		if (seeds.length === 3) break;
	}
	const runnerUp = minima.find((m) => Math.abs(m.dy - minima[0].dy) > 2);
	const sortedCosts = yawCosts.map((v) => v.c).sort((a, b) => a - b);
	const medianCost = sortedCosts[Math.floor(sortedCosts.length / 2)];
	return finish(
		minima[0],
		seeds,
		runnerUp,
		medianCost,
		yawCosts.length,
		nPitch,
	);
}

/** The ambiguity expression of solveOnce, shared by the CPU and GPU selections. */
export function finish(
	best: YawCost,
	seeds: YawCost[],
	runnerUp: YawCost | undefined,
	medianCost: number,
	nYaw: number,
	nPitch: number,
): CoarseResult {
	const spread = medianCost - best.c;
	const ambiguity =
		runnerUp && spread > 0
			? Math.max(0, Math.min(1, 1 - (runnerUp.c - best.c) / spread))
			: 0;
	return {
		coarse: { yaw: best.dy, pitch: best.dp },
		seeds,
		ambiguity,
		best,
		runnerUp,
		medianCost,
		nYaw,
		nPitch,
	};
}

/** The whole grid on the CPU (the reference): identical to solveOnce's coarse stage. */
export function coarseCpu(p: CoarsePlan): CoarseResult {
	const yawCosts: YawCost[] = [];
	for (let iy = 0; iy < p.dys.length; iy++) yawCosts.push(coarseRow(p, iy));
	return selectCoarse(yawCosts, p.dps.length);
}
