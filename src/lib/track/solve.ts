// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The per-frame solve: robust IRLS Gauss-Newton over (yaw, pitch, roll) of the observed skyline
// columns against the resident horizon, warm-started from the propagated pose. Focal length stays
// fixed (the tracker holds the lens), refraction and eye height stay at their nominal values.
// It reuses refine/model.ts (evalColumn with analytic Jacobians) and robust.ts (madScale); the
// full refineRobust (RANSAC, schedules, focal) is the still-photo path and too heavy per frame.
// Non-certified f64 on the CPU: 3x3 normal equations over a few hundred columns is tens of
// microseconds, so a GPU reduction would not pay for its dispatch and readback.
import { REFRACTION_K } from "../geodesy";
import {
	type Column,
	columnSigma,
	DEG,
	DEYE,
	evalColumn,
	type Geometry,
	type HorizonTable,
	KREF,
	LOGF,
	NPARAM,
	newEval,
	PITCH,
	ROLL,
	YAW,
} from "../refine/model";
import { madScale } from "../refine/robust";

export interface Angles {
	yaw: number;
	pitch: number;
	roll: number;
}

export interface SolveOptions {
	/** Prior mean, degrees. */
	prior: Angles;
	/** Prior σ, degrees. */
	priorSigmaDeg: Angles;
	/** Skyline detector noise, px at the working resolution. */
	sigmaPx: number;
	/** Data term counts as at most this many independent columns. */
	effectiveColumns: number;
	maxIterations?: number;
	/** Scale floor for the robust σ̂ (normalised units). */
	minScale?: number;
}

export interface SolveResult {
	/** Solved angles, degrees (yaw wrapped to 0..360). */
	angles: Angles;
	/** Weighted RMS of the inlier residuals, degrees. */
	residualDeg: number;
	/** Weight fraction of columns with |r| < 3σ_u (absolute, not relative to the MAD scale). */
	inlierFraction: number;
	/** Posterior σ per axis, degrees (data + prior). */
	sigmaDeg: Angles;
	/** Columns with positive weight. */
	used: number;
	iterations: number;
	/** Robust objective of the final state (lower is better), for comparing candidates. */
	cost: number;
}

/** Error model of the per-frame solve: DEM errors enter as a floor over distance. */
const ERROR_MODEL = { sigmaZ: 8, sigmaK: 0.05, sigmaXY: 10 };

const tukey = (u: number) => {
	const a = Math.abs(u);
	return a >= 1 ? 0 : (1 - a * a) ** 2;
};
const huber = (u: number) => {
	const a = Math.abs(u);
	return a <= 1.345 ? 1 : 1.345 / a;
};

/** Inverse of a symmetric positive 3x3 (row-major, 9 entries); null when singular. */
export function invert3(a: ArrayLike<number>): Float64Array | null {
	const [a00, a01, a02, , a11, a12, , , a22] = Array.from(
		a as ArrayLike<number>,
	);
	const c00 = a11 * a22 - a12 * a12;
	const c01 = a02 * a12 - a01 * a22;
	const c02 = a01 * a12 - a02 * a11;
	const det = a00 * c00 + a01 * c01 + a02 * c02;
	if (!(Math.abs(det) > 1e-300)) return null;
	const c11 = a00 * a22 - a02 * a02;
	const c12 = a01 * a02 - a00 * a12;
	const c22 = a00 * a11 - a01 * a01;
	const s = 1 / det;
	return Float64Array.from([
		c00 * s,
		c01 * s,
		c02 * s,
		c01 * s,
		c11 * s,
		c12 * s,
		c02 * s,
		c12 * s,
		c22 * s,
	]);
}

/**
 * Solves yaw/pitch/roll for `cols` against `table`. Returns null when fewer than 3 columns have
 * weight. `geom.f0` must be the focal length (px) at the working resolution.
 */
export function solvePose(
	table: HorizonTable,
	geom: Geometry,
	cols: Column[],
	o: SolveOptions,
): SolveResult | null {
	const n = cols.length;
	if (n < 3) return null;
	const p = new Float64Array(NPARAM);
	p[YAW] = o.prior.yaw * DEG;
	p[PITCH] = o.prior.pitch * DEG;
	p[ROLL] = o.prior.roll * DEG;
	p[LOGF] = 0;
	p[KREF] = REFRACTION_K;
	p[DEYE] = 0;
	const p0 = [p[YAW], p[PITCH], p[ROLL]];
	const priorInfo = [
		1 / (o.priorSigmaDeg.yaw * DEG) ** 2,
		1 / (o.priorSigmaDeg.pitch * DEG) ** 2,
		1 / (o.priorSigmaDeg.roll * DEG) ** 2,
	];
	const model = { ...ERROR_MODEL, sigmaPx: o.sigmaPx };
	const ev = newEval();
	const J = new Float64Array(NPARAM);
	const e = new Float64Array(n);
	const sig = new Float64Array(n);
	const jac = new Float64Array(n * 3);
	const w = new Float64Array(n);
	const minScale = o.minScale ?? 0.8;
	const maxIter = o.maxIterations ?? 6;
	let scale = 1;
	let iterations = 0;
	let info = new Float64Array(9);
	let cost = 0;

	const linearise = () => {
		for (let i = 0; i < n; i++) {
			evalColumn(p, geom, table, cols[i], ev, J);
			sig[i] = columnSigma(model, geom.f0, ev.d, ev.slope);
			e[i] = ev.r / sig[i];
			jac[i * 3] = J[YAW] / sig[i];
			jac[i * 3 + 1] = J[PITCH] / sig[i];
			jac[i * 3 + 2] = J[ROLL] / sig[i];
		}
	};
	const weigh = (final: boolean) => {
		const base = new Float64Array(n);
		for (let i = 0; i < n; i++) base[i] = cols[i].w;
		scale = Math.max(minScale, madScale(e, base));
		let sum = 0;
		for (let i = 0; i < n; i++) {
			const u = e[i] / scale;
			w[i] = cols[i].w * (final ? tukey(u / 4.685) : huber(u));
			sum += w[i];
		}
		// the data term counts as at most effectiveColumns independent observations
		return sum > o.effectiveColumns ? o.effectiveColumns / sum : 1;
	};

	for (let it = 0; it < maxIter; it++) {
		iterations = it + 1;
		linearise();
		const k = weigh(it >= 2);
		info = new Float64Array(9);
		const g = [0, 0, 0];
		for (let i = 0; i < n; i++) {
			if (w[i] <= 0) continue;
			const wi = (w[i] * k) / (scale * scale);
			const j0 = jac[i * 3];
			const j1 = jac[i * 3 + 1];
			const j2 = jac[i * 3 + 2];
			info[0] += wi * j0 * j0;
			info[1] += wi * j0 * j1;
			info[2] += wi * j0 * j2;
			info[4] += wi * j1 * j1;
			info[5] += wi * j1 * j2;
			info[8] += wi * j2 * j2;
			g[0] += wi * j0 * e[i];
			g[1] += wi * j1 * e[i];
			g[2] += wi * j2 * e[i];
		}
		info[3] = info[1];
		info[6] = info[2];
		info[7] = info[5];
		for (let a = 0; a < 3; a++) {
			info[a * 4] += priorInfo[a];
			g[a] += priorInfo[a] * (p[a] - p0[a]);
		}
		const inv = invert3(info);
		if (!inv) break;
		let stepMax = 0;
		for (let a = 0; a < 3; a++) {
			let d = 0;
			for (let b = 0; b < 3; b++) d -= inv[a * 3 + b] * g[b];
			// trust region: no step beyond 3 degrees per iteration
			d = Math.max(-3 * DEG, Math.min(3 * DEG, d));
			p[a] += d;
			stepMax = Math.max(stepMax, Math.abs(d));
		}
		if (stepMax < 0.002 * DEG && it >= 2) break;
	}

	// final statistics at the solved state
	linearise();
	weigh(true);
	let wSum = 0;
	let inW = 0;
	let rss = 0;
	let rssW = 0;
	cost = 0;
	let used = 0;
	for (let i = 0; i < n; i++) {
		const u = e[i] / scale;
		wSum += cols[i].w;
		// inliers by the ABSOLUTE normalised residual (not the MAD scale): a bad fit has a large
		// scale, and judging it by its own scale would pass it
		if (Math.abs(e[i]) < 3) {
			inW += cols[i].w;
			rss += cols[i].w * (e[i] * sig[i]) ** 2;
			rssW += cols[i].w;
		}
		if (w[i] > 0) used++;
		cost += cols[i].w * Math.min(u * u, 4.685 ** 2);
	}
	for (let a = 0; a < 3; a++) cost += priorInfo[a] * (p[a] - p0[a]) ** 2;
	const inv = invert3(info);
	const sd = (a: number) =>
		inv && inv[a * 4] > 0 ? Math.sqrt(inv[a * 4]) / DEG : o.priorSigmaDeg.yaw;
	const wrapped = ((p[YAW] / DEG) % 360) + 360;
	return {
		angles: { yaw: wrapped % 360, pitch: p[PITCH] / DEG, roll: p[ROLL] / DEG },
		residualDeg: rssW > 0 ? Math.sqrt(rss / rssW) / geom.f0 / DEG : Number.NaN,
		inlierFraction: wSum > 0 ? inW / wSum : 0,
		sigmaDeg: { yaw: sd(0), pitch: sd(1), roll: sd(2) },
		used,
		iterations,
		cost,
	};
}
