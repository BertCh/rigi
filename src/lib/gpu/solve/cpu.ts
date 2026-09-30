// CPU reference for solvePose's coarse stage (src/lib/geo/solve.ts solveOnce, "Coarse: small-angle
// grid over (dYaw, dPitch)"): the plan (observations, grids, truncation), the exact score of one yaw
// row, the whole-grid twin and the selection of seeds / coarse winner / ambiguity.
//
// solveOnce keeps its cost as a closure (`coarseCost`), so it cannot be imported from here (geo/ has
// another owner). This file rebuilds it from geo's exported pieces (horizonAt, unproject,
// azimuthElevation, resizeCamera) with the same expressions in the same order, and the bench
// (scripts/gpu/solve-bench.mjs) checks the result against solvePose's own SolveResult (coarse, and
// ambiguity, which depends on the winner's, the runner-up's and the median cost) bit for bit. The
// integration note (./README.md) exports coarseCost from solve.ts so this file imports it instead.

import {
	azimuthElevation,
	type Camera,
	resizeCamera,
	unproject,
} from "#/lib/geo/camera";
import type { HorizonProfile } from "#/lib/geo/horizon";
import {
	horizonAt,
	type SkylineRows,
	type SolveOptions,
} from "#/lib/geo/solve";
import { DEG } from "#/lib/geodesy";

/** solveOnce's DEFAULT_SIGMA (not exported by solve.ts). */
const DEFAULT_SIGMA = { yaw: 15, pitch: 1.5, roll: 1.5, focal: 0.06 };

/** One yawCosts entry of solveOnce: the best pitch at a yaw offset. */
export type YawCost = { dy: number; dp: number; c: number };

/** Everything solveOnce's coarse grid reads, in float64. */
export type CoarsePlan = {
	horizon: HorizonProfile;
	/** coarse observations (every 2nd usable column): azimuth / elevation under cam0 (deg), weight */
	az: Float64Array;
	el: Float64Array;
	w: Float64Array;
	/** Σw, summed in observation order as solveOnce does */
	wSum: number;
	/** truncated-L1 cutoff, deg */
	trunc: number;
	/** the yaw and pitch offsets, accumulated exactly as solveOnce's loops do */
	dys: Float64Array;
	dps: Float64Array;
	sigmaYaw: number;
	sigmaPitch: number;
};

/**
 * solveOnce's coarse inputs for (prior, sky, opts), where `opts` are the options solveOnce itself
 * receives (for the full-360° pass: fullSearchOptions(opts)). null where solveOnce returns
 * "no-skyline" before the grid.
 */
export function planCoarse(
	prior: Camera,
	horizon: HorizonProfile,
	sky: SkylineRows,
	opts: SolveOptions = {},
): CoarsePlan | null {
	const yawRange = opts.yawRange ?? 25;
	const pitchRange = opts.pitchRange ?? 3;
	const sigma = opts.sigma ?? DEFAULT_SIGMA;
	const cam0 = resizeCamera(prior, sky.width);
	// observations(sky, 1)
	const obs: { x: number; y: number; w: number }[] = [];
	for (let x = 0; x < sky.width; x += 1) {
		const y = sky.rows[x];
		const w = sky.weight[x];
		if (Number.isFinite(y) && w > 0.05) obs.push({ x: x + 0.5, y, w });
	}
	if (obs.length < sky.width * 0.1) return null;
	const coarse = obs.filter((_, i) => i % 2 === 0);
	const n = coarse.length;
	const az = new Float64Array(n);
	const el = new Float64Array(n);
	const w = new Float64Array(n);
	coarse.forEach((o, i) => {
		const ae = azimuthElevation(unproject(cam0, o.x, o.y));
		az[i] = ae[0];
		el[i] = ae[1];
		w[i] = o.w;
	});
	const degPerPx = 1 / (cam0.f * DEG);
	const trunc = 12 * degPerPx;
	const yawStep = Math.max(0.1, 1.5 * degPerPx);
	const pitchStep = Math.max(0.1, 1.5 * degPerPx);
	const wSum = coarse.reduce((s, o) => s + o.w, 0);
	const dys: number[] = [];
	for (let dy = -yawRange; dy <= yawRange + 1e-9; dy += yawStep) dys.push(dy);
	const dps: number[] = [];
	for (let dp = -pitchRange; dp <= pitchRange + 1e-9; dp += pitchStep)
		dps.push(dp);
	return {
		horizon,
		az,
		el,
		w,
		wSum,
		trunc,
		dys: Float64Array.from(dys),
		dps: Float64Array.from(dps),
		sigmaYaw: sigma.yaw,
		sigmaPitch: sigma.pitch,
	};
}

/** solvePose's options for its full-360° pass (solve.ts fullOpts, minus the accept threshold). */
export function fullSearchOptions(opts: SolveOptions = {}): SolveOptions {
	return {
		...opts,
		yawRange: 180,
		sigma: { ...(opts.sigma ?? DEFAULT_SIGMA), yaw: 1e6 },
	};
}

/** solveOnce's coarseCost(dy, dp), exactly (same expressions, same summation order). */
export function coarseCost(p: CoarsePlan, dy: number, dp: number) {
	const { az, el, w, horizon, trunc } = p;
	let c = 0;
	for (let i = 0; i < az.length; i++) {
		const r = Math.abs(el[i] + dp - horizonAt(horizon, az[i] + dy));
		c += w[i] * Math.min(r, trunc);
	}
	return (
		c / p.wSum +
		0.02 * trunc * ((dy / p.sigmaYaw) ** 2 + (dp / p.sigmaPitch) ** 2)
	);
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
