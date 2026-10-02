// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { wrap360 } from "#/lib/geodesy";
// The tracker's own wide-window skyline search, the default relocaliser. A yaw sweep over the
// whole circle (or a window around a trusted prior yaw) times a small pitch/roll grid around the
// prior, scored by a truncated-quadratic cost of the skyline columns against the smoothed horizon,
// then the best few candidates are refined by the per-frame solve. It needs no engine: the live UI
// can pass `relocalise` that runs the full autoAlign / unknown-pose path instead.
// The sweep yields to the event loop every few milliseconds so a main-thread caller stays responsive.
import type { Pose } from "../camera";
import { REFRACTION_K } from "../geodesy";
import {
	type Column,
	DEG,
	DEYE,
	evalColumn,
	type HorizonTable,
	horizonTable,
	KREF,
	LOGF,
	NPARAM,
	newEval,
	PITCH,
	ROLL,
	YAW,
} from "../refine/model";
import { solvePose } from "./solve";
import type {
	RelocaliseRequest,
	RelocaliseResult,
	Relocaliser,
	TrackerTuning,
} from "./types";

export interface SearchOptions {
	/** Yaw step of the sweep, degrees. */
	yawStepDeg?: number;
	/** Half window around a prior yaw, degrees; 180 = full circle. */
	yawHalfWindowDeg?: number;
	/** Columns used by the sweep. */
	sweepColumns?: number;
	/** Candidates refined. */
	candidates?: number;
	/** Truncation of the sweep cost, px. */
	truncationPx?: number;
	/** Work budget between yields, ms. */
	sliceMs?: number;
}

const yieldNow = () => new Promise<void>((r) => setTimeout(r, 0));

/** Evenly subsample to at most n columns. */
function subsample(cols: Column[], n: number): Column[] {
	if (cols.length <= n) return cols;
	const out: Column[] = [];
	for (let i = 0; i < n; i++) out.push(cols[Math.floor((i * cols.length) / n)]);
	return out;
}

/** Skyline search; `tuning` supplies the solve priors. Null when nothing plausible was found. */
export async function searchSkyline(
	request: RelocaliseRequest,
	tuning: Pick<TrackerTuning, "sigmaPx" | "effectiveColumns">,
	opts: SearchOptions = {},
): Promise<RelocaliseResult | null> {
	const { geom, vfov, prior } = request;
	const cols = request.columns.filter((c) => c.w > 0.05);
	if (cols.length < 12) return null;
	const coarse: HorizonTable = horizonTable(request.horizon, 1);
	const fine: HorizonTable = horizonTable(request.horizon, 0);
	const sweep = subsample(cols, opts.sweepColumns ?? 64);
	const tau = opts.truncationPx ?? 10;
	const yawStep = opts.yawStepDeg ?? 1;
	const half = prior.yaw !== undefined ? (opts.yawHalfWindowDeg ?? 180) : 180;
	const pitchCentre = prior.pitch ?? 5;
	const rollCentre = prior.roll ?? 0;
	const pitchSpan = prior.pitch !== undefined ? 4 : 20;
	const rollSpan = prior.roll !== undefined ? 3 : 10;
	const rolls: number[] = [];
	for (let d = -rollSpan; d <= rollSpan + 1e-9; d += rollSpan / 4)
		rolls.push(rollCentre + d);
	const centreYaw = prior.yaw ?? 180;
	const sliceMs = opts.sliceMs ?? 8;
	const keep = opts.candidates ?? 4;

	const ev = newEval();
	const residuals = new Float64Array(sweep.length);
	const sorted = new Float64Array(sweep.length);
	const p = new Float64Array(NPARAM);
	p[LOGF] = 0;
	p[KREF] = REFRACTION_K;
	p[DEYE] = 0;
	type Candidate = { yaw: number; pitch: number; roll: number; cost: number };
	const best: Candidate[] = [];
	let sliceStart = performance.now();
	for (let dy = -half; dy < half; dy += yawStep) {
		const yaw = wrap360(centreYaw + dy);
		let bestHere: Candidate | null = null;
		for (const roll of rolls) {
			// pitch is a near-vertical shift of the whole skyline: solve it per (yaw, roll) as the
			// weighted-median residual instead of gridding it, then score the shifted residuals
			p[YAW] = yaw * DEG;
			p[PITCH] = pitchCentre * DEG;
			p[ROLL] = roll * DEG;
			for (let i = 0; i < sweep.length; i++) {
				evalColumn(p, geom, coarse, sweep[i], ev);
				residuals[i] = ev.r;
			}
			sorted.set(residuals);
			sorted.sort();
			const shiftPx = sorted[sweep.length >> 1];
			const pitchOffset = Math.max(
				-pitchSpan,
				Math.min(pitchSpan, -shiftPx / geom.f0 / DEG),
			);
			const appliedPx = -pitchOffset * DEG * geom.f0;
			let cost = 0;
			for (let i = 0; i < sweep.length; i++) {
				const r = Math.min(Math.abs(residuals[i] - appliedPx), tau);
				cost += sweep[i].w * r * r;
			}
			if (!bestHere || cost < bestHere.cost)
				bestHere = { yaw, pitch: pitchCentre + pitchOffset, roll, cost };
		}
		if (bestHere) best.push(bestHere);
		if (performance.now() - sliceStart > sliceMs) {
			await yieldNow();
			if (request.cancelled()) return null;
			sliceStart = performance.now();
		}
	}
	// local minima in yaw first, then the cheapest few
	const peaks = best
		.filter((c, i) => {
			const a = best[(i + best.length - 1) % best.length].cost;
			const b = best[(i + 1) % best.length].cost;
			return c.cost <= a && c.cost <= b;
		})
		.sort((a, b) => a.cost - b.cost)
		.slice(0, keep);
	let winner: { cost: number; pose: Pose; inlier: number } | null = null;
	let second = Number.POSITIVE_INFINITY;
	for (const c of peaks) {
		const r = solvePose(fine, geom, cols, {
			prior: { yaw: c.yaw, pitch: c.pitch, roll: c.roll },
			priorSigmaDeg: { yaw: 8, pitch: 8, roll: 8 },
			sigmaPx: tuning.sigmaPx,
			effectiveColumns: tuning.effectiveColumns,
			maxIterations: 8,
		});
		if (!r) continue;
		if (!winner || r.cost < winner.cost) {
			if (winner) second = Math.min(second, winner.cost);
			winner = {
				cost: r.cost,
				inlier: r.inlierFraction,
				pose: {
					yaw: r.angles.yaw,
					pitch: r.angles.pitch,
					roll: r.angles.roll,
					vfov,
				},
			};
		} else second = Math.min(second, r.cost);
	}
	if (!winner) return null;
	// confidence: inliers, tempered by how clearly the winner beats the runner-up
	const margin = Number.isFinite(second)
		? Math.max(0, Math.min(1, (second - winner.cost) / Math.max(1, second)))
		: 1;
	return {
		pose: winner.pose,
		confidence: winner.inlier * (0.5 + 0.5 * margin),
	};
}

/** The default relocaliser for the tracker. */
export const createSkylineRelocaliser =
	(
		tuning: Pick<TrackerTuning, "sigmaPx" | "effectiveColumns">,
		opts?: SearchOptions,
	): Relocaliser =>
	(request) =>
		searchSkyline(request, tuning, opts);
