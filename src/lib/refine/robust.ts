// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * Robust Gauss–Newton / Levenberg–Marquardt on per-column skyline residuals
 * over (yaw, pitch, roll, log f) plus optional refraction k and eye-height
 * offset, with analytic Jacobians from model.ts.
 *
 * - Per-column error model σ_u (model.ts `columnSigma`): pixel noise, DEM
 *   height error seen at the skyline distance, refraction and GPS error
 *   through the skyline slope. Residuals are normalised e_u = r_u/σ_u.
 * - IRLS: Huber (k = 1.345σ̂) then Tukey (c = 4.685σ̂), σ̂ = 1.4826·MAD(e).
 * - One-sided occluder rejection: a photo skyline more than 2σ̂ ABOVE the DEM
 *   (trees, people, cloud on a ridge) keeps only 5% of its weight.
 * - Run-based rejection: columns whose residual is locally jagged (texture
 *   the DEM can't explain, e.g. tree tops) are down-weighted, and short inlier
 *   islands between outlier runs are dropped.
 * - Priors as extra rows (pitch/roll 0.7°, f 2%, yaw 10°, k 0.13 ± 0.05 when
 *   enough columns lie beyond 60 km, dEye ± max(GPS vertical, 20 m) when
 *   near and far columns both exist; dEye is clamped to ±100 m).
 * - RANSAC over columns when the inlier fraction is < 60%.
 * - Coarse-to-fine schedule over column counts (800 → 1600 → all) with a
 *   progressively less smoothed horizon.
 */

import type { HorizonProfile } from "../geo/horizon";
import { choleskySolve } from "../linalg";
import {
	type Column,
	type ColumnEval,
	columnSigma,
	DEG,
	DEYE,
	type ErrorModel,
	evalColumn,
	type Geometry,
	type HorizonTable,
	horizonTable,
	KREF,
	LOGF,
	NPARAM,
	newEval,
	PITCH,
	ROLL,
	YAW,
} from "./model";

export interface PriorSigma {
	yawDeg: number;
	pitchDeg: number;
	rollDeg: number;
	/** Fractional focal-length σ. */
	focal: number;
	k: number;
	/** Eye-height offset σ, m. */
	dEye: number;
}

export interface ScheduleLevel {
	/** Max number of columns used at this level (subsampled evenly). */
	cols: number;
	/** Horizon smoothing half-width, degrees. */
	smoothDeg: number;
}

export interface RobustOptions {
	error: ErrorModel;
	priorSigma: PriorSigma;
	/** Solve f (default true). */
	fitFocal: boolean;
	/** Solve refraction k: "auto" = when ≥ 20% of the weight lies beyond 60 km. */
	fitK: boolean | "auto";
	/** Solve eye height: "auto" = when near and far columns both exist. */
	fitEye: boolean | "auto";
	/** Unresolved eye-height error folded into σ_z when the eye isn't solved, m. */
	eyeSigma: number;
	eyeClamp: number;
	schedule: ScheduleLevel[];
	maxIterations: number;
	/**
	 * Skyline residuals are strongly correlated along the skyline (DEM and
	 * detector errors span many columns), so the data term is scaled to count
	 * as at most this many independent observations. Keeps the priors
	 * meaningful (otherwise 800 columns overrule any prior, e.g. f runs off).
	 */
	effectiveColumns: number;
	/** Hard clamp on |log(f/f_prior)|. */
	focalClamp: number;
	/** One-sided occluder rejection in the final (Tukey) stage. */
	oneSided: boolean;
	/** Weight kept by columns > 2σ̂ above the DEM (default 0.05). */
	oneSidedFactor: number;
	/**
	 * Also apply one-sided rejection in the coarse and Huber stages (for
	 * skylines that include occluders, e.g. a sky-model mask with trees and
	 * buildings on the crest). Off by default.
	 */
	oneSidedEarly: boolean;
	/**
	 * Use the one-sided loss when comparing modes (scoreState). A mode that
	 * puts the DEM below the whole photo skyline makes every column look like
	 * an occluder, so a one-sided score can prefer it; symmetric scoring
	 * (false) avoids that.
	 */
	scoreOneSided: boolean;
	ransac: boolean;
	ransacIterations: number;
	/** Scale floor for σ̂ (normalised units). */
	minScale: number;
	/** Deterministic seed for RANSAC. */
	seed: number;
}

export const DEFAULT_PRIOR_SIGMA: PriorSigma = {
	yawDeg: 10,
	pitchDeg: 0.7,
	rollDeg: 0.7,
	focal: 0.02,
	k: 0.05,
	dEye: 20,
};

export const DEFAULT_SCHEDULE: ScheduleLevel[] = [
	{ cols: 800, smoothDeg: 0.3 },
	{ cols: 1600, smoothDeg: 0.1 },
	{ cols: Number.POSITIVE_INFINITY, smoothDeg: 0 },
];

export function defaultRobustOptions(
	o: Partial<RobustOptions> = {},
): RobustOptions {
	return {
		error: { sigmaPx: 1, sigmaZ: 8, sigmaK: 0.05, sigmaXY: 10 },
		priorSigma: DEFAULT_PRIOR_SIGMA,
		fitFocal: true,
		fitK: "auto",
		fitEye: "auto",
		eyeSigma: 10,
		eyeClamp: 100,
		schedule: DEFAULT_SCHEDULE,
		maxIterations: 12,
		effectiveColumns: 100,
		focalClamp: 0.06,
		oneSided: true,
		oneSidedFactor: 0.05,
		oneSidedEarly: false,
		scoreOneSided: true,
		ransac: true,
		ransacIterations: 200,
		minScale: 0.8,
		seed: 1,
		...o,
	};
}

export interface RobustProblem {
	geom: Geometry;
	/** All observed columns at the working resolution, sorted by x. */
	cols: Column[];
	horizon: HorizonProfile;
	/** Prior mean (yaw/pitch/roll/logf from the sensor prior, k = REFRACTION_K, dEye = 0). */
	prior: Float64Array;
}

export type Loss = "l2" | "huber" | "tukey";

export interface RobustResult {
	p: Float64Array;
	/** Which parameters were free in the final stage. */
	active: boolean[];
	/** Robust scale σ̂ of the normalised residuals. */
	scale: number;
	/** Final robust objective (Tukey at `scale`, plus priors). */
	cost: number;
	/** Weighted fraction of columns with |r| < 3σ_u. */
	inlierFraction: number;
	/** Tukey support Σ w·(1−(e/cσ̂)²)³, for comparing modes. */
	support: number;
	/** Per column (same order as problem.cols): residual px, σ_u px, final IRLS weight. */
	residuals: Float64Array;
	sigma: Float64Array;
	weights: Float64Array;
	/** Slope of the DEM skyline per column, rad/rad. */
	slope: Float64Array;
	/** Distance of the DEM skyline per column, m. */
	distance: Float64Array;
	/** Data information matrix Σ ω J Jᵀ (NPARAM², row-major), ω incl. 1/σ̂². */
	info: Float64Array;
	/** Prior information (diagonal). */
	priorInfo: Float64Array;
	iterations: number;
	ransac: boolean;
	kFitted: boolean;
	eyeFitted: boolean;
	/** Near/far differential shift (px) for a 20 m eye error, and far (>60 km) weight fraction. */
	eyeSensitivityPx: number;
	farFraction: number;
	/** Weighted RMS of inlier residuals, px at the working resolution. */
	rmsPx: number;
}

// ---------------------------------------------------------------- losses

const HUBER_K = 1.345;
const TUKEY_C = 4.685;
const ONE_SIDED_Z = 2;

function rho(loss: Loss, z: number) {
	const a = Math.abs(z);
	if (loss === "huber")
		return a <= HUBER_K ? 0.5 * z * z : HUBER_K * (a - 0.5 * HUBER_K);
	if (loss === "tukey") {
		if (a >= TUKEY_C) return (TUKEY_C * TUKEY_C) / 6;
		const t = 1 - (z / TUKEY_C) ** 2;
		return ((TUKEY_C * TUKEY_C) / 6) * (1 - t * t * t);
	}
	return 0.5 * z * z;
}

/** IRLS weight ψ(z)/z. */
function psiW(loss: Loss, z: number) {
	const a = Math.abs(z);
	if (loss === "huber") return a <= HUBER_K ? 1 : HUBER_K / a;
	if (loss === "tukey") return a >= TUKEY_C ? 0 : (1 - (z / TUKEY_C) ** 2) ** 2;
	return 1;
}

/**
 * One-sided variants: beyond +2σ̂ (photo above DEM) only `factor` of the
 * slope (factor 1 = symmetric loss).
 */
function rhoOS(loss: Loss, z: number, factor: number) {
	if (factor >= 1 || z <= ONE_SIDED_Z) return rho(loss, z);
	const r2 = rho(loss, ONE_SIDED_Z);
	return r2 + factor * (rho(loss, z) - r2);
}
function psiWOS(loss: Loss, z: number, factor: number) {
	const w = psiW(loss, z);
	return factor < 1 && z > ONE_SIDED_Z ? factor * w : w;
}

// ---------------------------------------------------------------- helpers

function median(v: number[]) {
	if (!v.length) return 0;
	const s = [...v].sort((a, b) => a - b);
	const m = s.length >> 1;
	return s.length % 2 ? s[m] : 0.5 * (s[m - 1] + s[m]);
}

/** σ̂ = 1.4826·MAD of the normalised residuals (columns with weight > 0). */
export function madScale(e: ArrayLike<number>, w: ArrayLike<number>) {
	const v: number[] = [];
	for (let i = 0; i < e.length; i++) if (w[i] > 0) v.push(e[i]);
	const m = median(v);
	return 1.4826 * median(v.map((x) => Math.abs(x - m)));
}

function priorSigmaVector(o: RobustOptions): Float64Array {
	const s = o.priorSigma;
	const v = new Float64Array(NPARAM);
	v[YAW] = s.yawDeg * DEG;
	v[PITCH] = s.pitchDeg * DEG;
	v[ROLL] = s.rollDeg * DEG;
	v[LOGF] = s.focal;
	v[KREF] = s.k;
	v[DEYE] = s.dEye;
	return v;
}

/** Evenly subsample to at most `n` columns. */
function subsample(cols: Column[], n: number): Column[] {
	if (cols.length <= n) return cols;
	const stride = cols.length / n;
	const out: Column[] = [];
	for (let i = 0; i < n; i++) out.push(cols[Math.floor(i * stride)]);
	return out;
}

// ---------------------------------------------------------------- core

interface Stage {
	geom: Geometry;
	table: HorizonTable;
	cols: Column[];
	/** Extra per-column multiplier (run/roughness rejection), same order as cols. */
	extra: Float64Array;
	active: boolean[];
	loss: Loss;
	/** One-sided factor (1 = off). */
	oneSided: number;
	error: ErrorModel;
	priorMean: Float64Array;
	priorSigma: Float64Array;
	eyeClamp: number;
	focalClamp: number;
	/** Multiplier on the data term (see RobustOptions.effectiveColumns). */
	dataScale: number;
	/** Fixed scale (else re-estimated each iteration). */
	fixedScale?: number;
	minScale: number;
}

interface Linearised {
	r: Float64Array;
	sigma: Float64Array;
	J: Float64Array;
	slope: Float64Array;
	dist: Float64Array;
}

const scratch: ColumnEval = newEval();

function linearise(p: Float64Array, s: Stage, withJ: boolean): Linearised {
	const n = s.cols.length;
	const r = new Float64Array(n);
	const sigma = new Float64Array(n);
	const slope = new Float64Array(n);
	const dist = new Float64Array(n);
	const J = new Float64Array(withJ ? n * NPARAM : 0);
	const row = new Float64Array(NPARAM);
	for (let i = 0; i < n; i++) {
		evalColumn(p, s.geom, s.table, s.cols[i], scratch, withJ ? row : undefined);
		r[i] = scratch.r;
		slope[i] = scratch.slope;
		dist[i] = scratch.d;
		sigma[i] = columnSigma(s.error, s.geom.f0, scratch.d, scratch.slope);
		if (withJ) J.set(row, i * NPARAM);
	}
	return { r, sigma, J, slope, dist };
}

function residualsOnly(p: Float64Array, s: Stage) {
	const n = s.cols.length;
	const r = new Float64Array(n);
	for (let i = 0; i < n; i++)
		r[i] = evalColumn(p, s.geom, s.table, s.cols[i], scratch).r;
	return r;
}

function objective(
	r: Float64Array,
	sigma: Float64Array,
	p: Float64Array,
	s: Stage,
	scale: number,
) {
	let c = 0;
	for (let i = 0; i < r.length; i++) {
		const w = s.cols[i].w * s.extra[i];
		if (w <= 0) continue;
		c += s.dataScale * w * rhoOS(s.loss, r[i] / sigma[i] / scale, s.oneSided);
	}
	for (let j = 0; j < NPARAM; j++) {
		if (!s.active[j]) continue;
		const d = (p[j] - s.priorMean[j]) / s.priorSigma[j];
		c += 0.5 * d * d;
	}
	return c;
}

function clampState(p: Float64Array, s: Stage) {
	p[DEYE] = Math.max(-s.eyeClamp, Math.min(s.eyeClamp, p[DEYE]));
	p[LOGF] = Math.max(-s.focalClamp, Math.min(s.focalClamp, p[LOGF]));
	p[KREF] = Math.max(-0.5, Math.min(0.8, p[KREF]));
}

interface StageResult {
	p: Float64Array;
	scale: number;
	iterations: number;
	lin: Linearised;
	omega: Float64Array;
	cost: number;
}

/** IRLS + LM on one stage. */
function runStage(p0: Float64Array, s: Stage, maxIt: number): StageResult {
	const act = s.active.map((a, j) => (a ? j : -1)).filter((j) => j >= 0);
	const m = act.length;
	let p: Float64Array = Float64Array.from(p0);
	let mu = 1e-3;
	let it = 0;
	let lin = linearise(p, s, true);
	let scale = s.fixedScale ?? s.minScale;
	let omega = new Float64Array(s.cols.length);
	for (; it < maxIt; it++) {
		const n = s.cols.length;
		const e = new Float64Array(n);
		const wv = new Float64Array(n);
		for (let i = 0; i < n; i++) {
			e[i] = lin.r[i] / lin.sigma[i];
			wv[i] = s.cols[i].w * s.extra[i];
		}
		if (s.fixedScale === undefined)
			scale = Math.max(s.minScale, madScale(e, wv));
		omega = new Float64Array(n);
		const A = new Float64Array(m * m);
		const g = new Float64Array(m);
		for (let i = 0; i < n; i++) {
			if (wv[i] <= 0) continue;
			const z = e[i] / scale;
			const om =
				(s.dataScale * wv[i] * psiWOS(s.loss, z, s.oneSided)) /
				(lin.sigma[i] * scale) ** 2;
			omega[i] = om;
			if (om === 0) continue;
			const o = i * NPARAM;
			for (let a = 0; a < m; a++) {
				const ja = lin.J[o + act[a]];
				g[a] += om * ja * lin.r[i];
				for (let b = a; b < m; b++) A[a * m + b] += om * ja * lin.J[o + act[b]];
			}
		}
		for (let a = 0; a < m; a++) {
			const j = act[a];
			const ps = s.priorSigma[j];
			A[a * m + a] += 1 / (ps * ps);
			g[a] += (p[j] - s.priorMean[j]) / (ps * ps);
			for (let b = 0; b < a; b++) A[a * m + b] = A[b * m + a];
		}
		const cost0 = objective(lin.r, lin.sigma, p, s, scale);
		let improved = false;
		let small = false;
		for (let tries = 0; tries < 10; tries++) {
			const Ad = Float64Array.from(A);
			for (let a = 0; a < m; a++) Ad[a * m + a] *= 1 + mu;
			const delta = choleskySolve(
				Ad,
				g.map((v) => -v),
				m,
			);
			if (!delta) {
				mu *= 10;
				continue;
			}
			const q = Float64Array.from(p);
			for (let a = 0; a < m; a++) q[act[a]] += delta[a];
			clampState(q, s);
			const rq = residualsOnly(q, s);
			// σ_u frozen within the iteration (it depends weakly on the pose).
			const cq = objective(rq, lin.sigma, q, s, scale);
			if (cq <= cost0) {
				p = q;
				mu = Math.max(mu / 3, 1e-9);
				improved = true;
				// Converged when the step is below ~1e-5 rad (0.0006°) and 1e-5 in log f.
				let big = 0;
				for (let a = 0; a < m; a++) {
					const j = act[a];
					const unit = j === DEYE ? 0.01 : j === KREF ? 1e-4 : 1e-5;
					big = Math.max(big, Math.abs(delta[a]) / unit);
				}
				small = big < 1;
				break;
			}
			mu *= 10;
		}
		lin = linearise(p, s, true);
		if (!improved || small) {
			it++;
			break;
		}
	}
	const cost = objective(lin.r, lin.sigma, p, s, scale);
	return { p, scale, iterations: it, lin, omega, cost };
}

/**
 * Run-based rejection multipliers from the residual sequence at pose p:
 * locally jagged residuals (unexplained texture such as tree tops) are
 * down-weighted, and inlier islands shorter than `minRun` squeezed between
 * outliers are dropped.
 */
function runRejection(
	cols: Column[],
	r: Float64Array,
	sigma: Float64Array,
	scale: number,
	sigmaPx: number,
): Float64Array {
	const n = cols.length;
	const extra = new Float64Array(n).fill(1);
	if (n < 5) return extra;
	// Local residual roughness: mean |second difference| over ±4 neighbours,
	// only across contiguous columns.
	const gaps: number[] = [];
	for (let i = 1; i < n; i++) gaps.push(cols[i].x - cols[i - 1].x);
	const gap0 = median(gaps);
	const d2 = new Float64Array(n);
	for (let i = 1; i < n - 1; i++) {
		const contiguous =
			cols[i + 1].x - cols[i].x <= 2 * gap0 &&
			cols[i].x - cols[i - 1].x <= 2 * gap0;
		d2[i] = contiguous ? Math.abs(r[i + 1] - 2 * r[i] + r[i - 1]) : 0;
	}
	const rad = 4;
	for (let i = 0; i < n; i++) {
		let s = 0;
		let c = 0;
		for (let j = Math.max(1, i - rad); j <= Math.min(n - 2, i + rad); j++) {
			s += d2[j];
			c++;
		}
		const rough = c ? s / c : 0;
		// iid noise gives E|Δ²| ≈ 1.95σ; beyond that, treat as texture.
		const t = Math.max(0, rough - 2 * sigmaPx) / (3 * sigmaPx);
		extra[i] = 1 / (1 + t * t);
	}
	// Short inlier islands between outliers.
	const out = new Uint8Array(n);
	for (let i = 0; i < n; i++)
		out[i] = Math.abs(r[i] / sigma[i]) > 3 * scale ? 1 : 0;
	const minRun = Math.max(5, Math.round(0.015 * n));
	let i = 0;
	while (i < n) {
		if (out[i]) {
			i++;
			continue;
		}
		let j = i;
		while (j < n && !out[j]) j++;
		const flankedLeft = i > 0 && out[i - 1];
		const flankedRight = j < n && out[j];
		if (j - i < minRun && flankedLeft && flankedRight)
			for (let k = i; k < j; k++) extra[k] = 0;
		i = j;
	}
	return extra;
}

function makeRng(seed: number) {
	let s = seed >>> 0 || 1;
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 2 ** 32;
	};
}

/**
 * RANSAC over columns: 4 columns (one per quarter of the skyline, favouring
 * sloped ones), a few GN steps on (yaw, pitch, roll) from `p0`, inliers at
 * |r| < 3σ_u. Returns the best pose and its inlier mask.
 */
function ransac(p0: Float64Array, s: Stage, iterations: number, seed: number) {
	const rng = makeRng(seed);
	const n = s.cols.length;
	const lin0 = linearise(p0, s, false);
	const cand = s.cols
		.map((_, i) => i)
		.filter((i) => s.cols[i].w > 0.2 && s.extra[i] > 0.3);
	if (cand.length < 8) return null;
	const quarters: number[][] = [[], [], [], []];
	cand.forEach((i, k) => {
		quarters[Math.min(3, Math.floor((4 * k) / cand.length))].push(i);
	});
	const sloped = quarters.map((q) =>
		q.filter((i) => Math.abs(lin0.slope[i]) > 0.2),
	);
	const act = [YAW, PITCH, ROLL];
	let best: { p: Float64Array; score: number } | null = null;
	const scoreStride = Math.max(1, Math.floor(n / 300));
	const row = new Float64Array(NPARAM);
	for (let it = 0; it < iterations; it++) {
		const pick = quarters.map((q, k) => {
			const pool = sloped[k].length && rng() < 0.6 ? sloped[k] : q;
			return pool[Math.floor(rng() * pool.length)];
		});
		const p = Float64Array.from(p0);
		// Random yaw/pitch jitter widens the search a little beyond p0.
		p[YAW] += (rng() - 0.5) * 2 * DEG;
		p[PITCH] += (rng() - 0.5) * 1 * DEG;
		for (let k = 0; k < 6; k++) {
			const A = new Float64Array(9);
			const g = new Float64Array(3);
			for (const i of pick) {
				const r = evalColumn(p, s.geom, s.table, s.cols[i], scratch, row).r;
				for (let a = 0; a < 3; a++) {
					g[a] += row[act[a]] * r;
					for (let b = 0; b < 3; b++) A[a * 3 + b] += row[act[a]] * row[act[b]];
				}
			}
			for (let a = 0; a < 3; a++) A[a * 3 + a] += 1e-3 + 1e-3 * A[a * 3 + a];
			const d = choleskySolve(
				A,
				g.map((v) => -v),
				3,
			);
			if (!d) break;
			for (let a = 0; a < 3; a++) p[act[a]] += d[a];
		}
		if (
			Math.abs(p[PITCH] - s.priorMean[PITCH]) > 5 * s.priorSigma[PITCH] ||
			Math.abs(p[ROLL] - s.priorMean[ROLL]) > 5 * s.priorSigma[ROLL]
		)
			continue;
		// Score on a subsample (≤ 300 columns); the winner is re-scored in full.
		let score = 0;
		for (let i = 0; i < n; i += scoreStride) {
			const r = evalColumn(p, s.geom, s.table, s.cols[i], scratch).r;
			if (Math.abs(r) < 3 * lin0.sigma[i]) score += s.cols[i].w * s.extra[i];
		}
		if (!best || score > best.score) best = { p, score };
	}
	if (!best) return null;
	const r = residualsOnly(best.p, s);
	const inl = new Uint8Array(n);
	for (let i = 0; i < n; i++)
		if (Math.abs(r[i]) < 3 * lin0.sigma[i]) inl[i] = 1;
	return { p: best.p, inl };
}

function inlierStats(
	cols: Column[],
	r: Float64Array,
	sigma: Float64Array,
	scale: number,
) {
	let wIn = 0;
	let wAll = 0;
	let ss = 0;
	let support = 0;
	for (let i = 0; i < cols.length; i++) {
		const w = cols[i].w;
		wAll += w;
		if (Math.abs(r[i]) < 3 * sigma[i]) {
			wIn += w;
			ss += w * r[i] * r[i];
		}
		const z = r[i] / sigma[i] / scale;
		if (Math.abs(z) < TUKEY_C) support += w * (1 - (z / TUKEY_C) ** 2) ** 3;
	}
	return {
		inlierFraction: wAll > 0 ? wIn / wAll : 0,
		rmsPx: wIn > 0 ? Math.sqrt(ss / wIn) : Number.NaN,
		support,
	};
}

/** Decides which of k / dEye are observable for this skyline at pose p. */
export function observability(
	p: Float64Array,
	geom: Geometry,
	cols: Column[],
	horizon: HorizonProfile,
	sigmaPx: number,
) {
	const t = horizonTable(horizon, 0);
	let wFar = 0;
	let wAll = 0;
	const inv: { v: number; w: number }[] = [];
	const e = newEval();
	for (const c of cols) {
		evalColumn(p, geom, t, c, e);
		wAll += c.w;
		if (e.d > 60_000) wFar += c.w;
		inv.push({ v: 1 / e.d, w: c.w });
	}
	inv.sort((a, b) => a.v - b.v);
	const q = (f: number) => {
		let acc = 0;
		for (const x of inv) {
			acc += x.w;
			if (acc >= f * wAll) return x.v;
		}
		return inv.length ? inv[inv.length - 1].v : 0;
	};
	const farFraction = wAll > 0 ? wFar / wAll : 0;
	// Differential shift (px) between near and far columns for a 20 m eye error.
	const eyeSensitivityPx = geom.f0 * 20 * (q(0.9) - q(0.1));
	return {
		farFraction,
		fitK: farFraction >= 0.2 && cols.length * farFraction >= 50,
		eyeSensitivityPx,
		fitEye: eyeSensitivityPx > 3 * sigmaPx,
	};
}

/**
 * Robust refinement from a start state. Runs the coarse-to-fine schedule
 * (Huber on smoothed horizons), then the final Tukey + one-sided + run-based
 * stage at full resolution, with RANSAC as a fallback when inliers < 60%.
 */
export function refineRobust(
	prob: RobustProblem,
	start: Float64Array,
	opts: RobustOptions,
): RobustResult {
	const priorSigma = priorSigmaVector(opts);
	const baseActive = [true, true, true, opts.fitFocal, false, false];
	let p: Float64Array = Float64Array.from(start);
	let iterations = 0;
	const levels = opts.schedule.length ? opts.schedule : DEFAULT_SCHEDULE;
	const mk = (
		cols: Column[],
		table: HorizonTable,
		active: boolean[],
		loss: Loss,
		oneSided: boolean,
		error: ErrorModel,
		extra?: Float64Array,
		fixedScale?: number,
	): Stage => ({
		geom: prob.geom,
		table,
		cols,
		extra: extra ?? new Float64Array(cols.length).fill(1),
		active,
		loss,
		oneSided: oneSided ? opts.oneSidedFactor : 1,
		error,
		priorMean: prob.prior,
		priorSigma,
		eyeClamp: opts.eyeClamp,
		focalClamp: opts.focalClamp,
		dataScale: Math.min(1, opts.effectiveColumns / Math.max(1, cols.length)),
		fixedScale,
		minScale: opts.minScale,
	});

	// Error model while the eye is unsolved: fold its uncertainty into σ_z.
	const errNoEye: ErrorModel = {
		...opts.error,
		sigmaZ: Math.hypot(opts.error.sigmaZ, opts.eyeSigma),
	};

	// Coarse-to-fine (all but the last level): Huber.
	for (let li = 0; li < levels.length - 1; li++) {
		const L = levels[li];
		const cols = subsample(prob.cols, L.cols);
		const st = mk(
			cols,
			horizonTable(prob.horizon, L.smoothDeg),
			baseActive,
			"huber",
			opts.oneSidedEarly,
			errNoEye,
		);
		const res = runStage(p, st, opts.maxIterations);
		p = res.p;
		iterations += res.iterations;
	}

	// Final level.
	const last = levels[levels.length - 1];
	const cols = subsample(prob.cols, last.cols);
	const table = horizonTable(prob.horizon, last.smoothDeg);
	const obs = observability(
		p,
		prob.geom,
		cols,
		prob.horizon,
		opts.error.sigmaPx,
	);
	const kFitted = opts.fitK === "auto" ? obs.fitK : opts.fitK;
	const eyeFitted = opts.fitEye === "auto" ? obs.fitEye : opts.fitEye;
	const active = [...baseActive];
	active[KREF] = kFitted;
	active[DEYE] = eyeFitted;
	const err = eyeFitted ? opts.error : errNoEye;

	// Huber at full resolution, then run-based rejection, then Tukey.
	let st = mk(cols, table, active, "huber", opts.oneSidedEarly, err);
	let res = runStage(p, st, opts.maxIterations);
	iterations += res.iterations;
	const extra = runRejection(
		cols,
		res.lin.r,
		res.lin.sigma,
		res.scale,
		opts.error.sigmaPx,
	);
	st = mk(cols, table, active, "tukey", opts.oneSided, err, extra);
	res = runStage(res.p, st, opts.maxIterations);
	iterations += res.iterations;
	let stats = inlierStats(cols, res.lin.r, res.lin.sigma, res.scale);
	let usedRansac = false;

	if (opts.ransac && stats.inlierFraction < 0.6) {
		const rs = ransac(res.p, st, opts.ransacIterations, opts.seed);
		if (rs) {
			// IRLS on the RANSAC inliers, then re-scored on everything.
			const ex2 = Float64Array.from(extra);
			for (let i = 0; i < ex2.length; i++) if (!rs.inl[i]) ex2[i] = 0;
			const s2 = mk(cols, table, active, "huber", false, err, ex2);
			let r2 = runStage(rs.p, s2, opts.maxIterations);
			const s3 = mk(cols, table, active, "tukey", opts.oneSided, err, extra);
			r2 = runStage(r2.p, s3, opts.maxIterations);
			iterations += r2.iterations;
			const stats2 = inlierStats(cols, r2.lin.r, r2.lin.sigma, r2.scale);
			if (stats2.inlierFraction > stats.inlierFraction + 0.02) {
				res = r2;
				stats = stats2;
				st = s3;
				usedRansac = true;
			}
		}
	}

	// Final outputs.
	const n = cols.length;
	// Information WITHOUT the effective-columns scaling (confidence.ts applies
	// its own measured correlation length instead).
	const info = new Float64Array(NPARAM * NPARAM);
	for (let i = 0; i < n; i++) {
		const om = res.omega[i] / st.dataScale;
		if (!om) continue;
		const o = i * NPARAM;
		for (let a = 0; a < NPARAM; a++)
			for (let b = 0; b < NPARAM; b++)
				info[a * NPARAM + b] += om * res.lin.J[o + a] * res.lin.J[o + b];
	}
	const priorInfo = new Float64Array(NPARAM);
	for (let j = 0; j < NPARAM; j++) priorInfo[j] = 1 / priorSigma[j] ** 2;
	return {
		p: res.p,
		active,
		scale: res.scale,
		cost: res.cost,
		inlierFraction: stats.inlierFraction,
		support: stats.support,
		residuals: res.lin.r,
		sigma: res.lin.sigma,
		weights: res.omega,
		slope: res.lin.slope,
		distance: res.lin.dist,
		info,
		priorInfo,
		iterations,
		ransac: usedRansac,
		kFitted,
		eyeFitted,
		eyeSensitivityPx: obs.eyeSensitivityPx,
		farFraction: obs.farFraction,
		rmsPx: stats.rmsPx,
	};
}

/**
 * Robust cost of a state at a FIXED scale over all columns (Tukey, one-sided,
 * priors on yaw/pitch/roll/f): used to compare modes on an equal footing.
 */
export function scoreState(
	prob: RobustProblem,
	p: Float64Array,
	opts: RobustOptions,
	scale: number,
) {
	const priorSigma = priorSigmaVector(opts);
	const st: Stage = {
		geom: prob.geom,
		table: horizonTable(prob.horizon, 0),
		cols: prob.cols,
		extra: new Float64Array(prob.cols.length).fill(1),
		active: [true, true, true, opts.fitFocal, false, false],
		loss: "tukey",
		oneSided: opts.oneSided && opts.scoreOneSided ? opts.oneSidedFactor : 1,
		error: {
			...opts.error,
			sigmaZ: Math.hypot(opts.error.sigmaZ, opts.eyeSigma),
		},
		priorMean: prob.prior,
		priorSigma,
		eyeClamp: opts.eyeClamp,
		focalClamp: opts.focalClamp,
		dataScale: Math.min(
			1,
			opts.effectiveColumns / Math.max(1, prob.cols.length),
		),
		fixedScale: scale,
		minScale: opts.minScale,
	};
	const lin = linearise(p, st, false);
	const stats = inlierStats(prob.cols, lin.r, lin.sigma, scale);
	return { cost: objective(lin.r, lin.sigma, p, st, scale), ...stats };
}
