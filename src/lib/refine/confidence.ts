/**
 * Confidence for a refined pose. Combines:
 *   - peak-to-sidelobe ratio (PSR) of the yaw correlation (init.ts);
 *   - mode ratio s2/s1: Tukey support of the best distinct (>1°) runner-up
 *     mode over the winner's;
 *   - covariance Σ = σ̂²(JᵀWJ)⁻¹ with the data information divided by the
 *     residual correlation length L (i.e. σ inflated by √L), plus the priors;
 *   - weighted inlier fraction (|r| < 3σ_u);
 *   - yaw observability Σw·s²·f² (flat skylines give no yaw), reported as the
 *     weight-averaged RMS skyline slope;
 *   - RMS inlier residual, px at 1600 wide.
 * Each term is a soft 0..1 ramp; `score` is their product and `accept` needs
 * score ≥ 0.5 with no hard failure. Rejected results should go to the
 * manual tap-a-peak flow.
 */

import { invertSPD } from "../linalg";
import { DEG, DEYE, LOGF, NPARAM, PITCH, ROLL, YAW } from "./model";

export interface Confidence {
	accept: boolean;
	/** 0..1. */
	score: number;
	/** 1σ, degrees (inflated for residual correlation). */
	sigmaDeg: { yaw: number; pitch: number; roll: number };
	/** Why the score is reduced / the result rejected. Empty when clean. */
	reasons: string[];
	metrics: ConfidenceMetrics;
}

export interface ConfidenceMetrics {
	psr: number;
	modeRatio: number;
	inlierFraction: number;
	/** Residual correlation length, columns. */
	corrLength: number;
	/** Weighted RMS skyline slope over the used columns (yaw observability). */
	rmsSlope: number;
	/** Σ w s² f², the yaw information before the robust scale (px²/rad²). */
	yawInfo: number;
	rmsPx1600: number;
	scale: number;
	sigmaFocal: number;
	sigmaEye: number;
}

export interface ConfidenceThresholds {
	psr: [number, number];
	modeRatio: [number, number];
	inlier: [number, number];
	/** max(σ_yaw, σ_pitch), degrees. */
	sigma: [number, number];
	rmsSlope: [number, number];
	rmsPx1600: [number, number];
	/** Hard gates. */
	minInlier: number;
	minRmsSlope: number;
}

/**
 * Ramps [bad, good]. Calibrated on the 9 hand-solved photos in
 * data/ground-truth.json (all of which converge to within 0.6° yaw): correct
 * results there have PSR 4–10, correlation-inflated σ 0.04–0.7° and RMS
 * 1.5–8 px at 1600 wide, which is dominated by DEM error, not detection.
 */
export const DEFAULT_THRESHOLDS: ConfidenceThresholds = {
	psr: [2.5, 5],
	modeRatio: [0.95, 0.75],
	inlier: [0.35, 0.6],
	sigma: [0.6, 0.2],
	rmsSlope: [0.02, 0.08],
	rmsPx1600: [12, 5],
	minInlier: 0.3,
	minRmsSlope: 0.015,
};

const ramp = (v: number, bad: number, good: number) => {
	const t = Math.max(0, Math.min(1, (v - bad) / (good - bad)));
	return t * t * (3 - 2 * t);
};

/** Integrated autocorrelation length of a residual sequence (in samples). */
export function correlationLength(e: ArrayLike<number>, maxLag = 100) {
	const n = e.length;
	if (n < 8) return 1;
	let mean = 0;
	for (let i = 0; i < n; i++) mean += e[i];
	mean /= n;
	let v0 = 0;
	for (let i = 0; i < n; i++) v0 += (e[i] - mean) ** 2;
	if (v0 <= 0) return 1;
	let L = 1;
	for (let k = 1; k < Math.min(maxLag, n >> 1); k++) {
		let c = 0;
		for (let i = 0; i + k < n; i++) c += (e[i] - mean) * (e[i + k] - mean);
		const rho = c / v0;
		if (rho < 0.05) break;
		L += 2 * rho;
	}
	return Math.max(1, Math.min(n / 5, L));
}

export interface ConfidenceInput {
	psr: number;
	modeRatio: number;
	inlierFraction: number;
	/** Data information Σ ω J Jᵀ (NPARAM² row-major), already divided by σ̂². */
	info: Float64Array;
	priorInfo: Float64Array;
	active: boolean[];
	scale: number;
	/** Per used column (sorted by x): residual px, σ_u px, IRLS weight, slope. */
	residuals: Float64Array;
	sigma: Float64Array;
	weights: Float64Array;
	slope: Float64Array;
	f0: number;
	rmsPx: number;
	workWidth: number;
}

export function computeConfidence(
	c: ConfidenceInput,
	th: ConfidenceThresholds = DEFAULT_THRESHOLDS,
): Confidence {
	// Residual correlation length over inlier columns.
	const e: number[] = [];
	for (let i = 0; i < c.residuals.length; i++)
		if (c.weights[i] > 0) e.push(c.residuals[i] / c.sigma[i]);
	const L = correlationLength(e);

	// Covariance over the active parameters.
	const act: number[] = [];
	for (let j = 0; j < NPARAM; j++) if (c.active[j]) act.push(j);
	const m = act.length;
	const A = new Float64Array(m * m);
	for (let a = 0; a < m; a++) {
		for (let b = 0; b < m; b++)
			A[a * m + b] = c.info[act[a] * NPARAM + act[b]] / L;
		A[a * m + a] += c.priorInfo[act[a]];
	}
	const cov = invertSPD(A, m);
	const sd = (j: number) => {
		const a = act.indexOf(j);
		return cov && a >= 0
			? Math.sqrt(Math.max(0, cov[a * m + a]))
			: Number.POSITIVE_INFINITY;
	};
	const sigmaDeg = {
		yaw: sd(YAW) / DEG,
		pitch: sd(PITCH) / DEG,
		roll: sd(ROLL) / DEG,
	};

	// Yaw observability.
	let sw = 0;
	let ss = 0;
	let yawInfo = 0;
	for (let i = 0; i < c.weights.length; i++) {
		const w = c.weights[i];
		if (!(w > 0)) continue;
		sw += w;
		ss += w * c.slope[i] * c.slope[i];
		yawInfo += w * (c.slope[i] * c.f0) ** 2;
	}
	const rmsSlope = sw > 0 ? Math.sqrt(ss / sw) : 0;
	const rmsPx1600 = (c.rmsPx * 1600) / c.workWidth;

	const reasons: string[] = [];
	const terms = {
		psr: ramp(c.psr, th.psr[0], th.psr[1]),
		mode: ramp(c.modeRatio, th.modeRatio[0], th.modeRatio[1]),
		inlier: ramp(c.inlierFraction, th.inlier[0], th.inlier[1]),
		sigma: ramp(
			Math.max(sigmaDeg.yaw, sigmaDeg.pitch),
			th.sigma[0],
			th.sigma[1],
		),
		slope: ramp(rmsSlope, th.rmsSlope[0], th.rmsSlope[1]),
		rms: ramp(
			Number.isFinite(rmsPx1600) ? rmsPx1600 : 1e9,
			th.rmsPx1600[0],
			th.rmsPx1600[1],
		),
	};
	if (terms.psr < 1)
		reasons.push(`weak yaw correlation peak (PSR ${c.psr.toFixed(1)})`);
	if (terms.mode < 1)
		reasons.push(
			`ambiguous: runner-up mode at ${(100 * c.modeRatio).toFixed(0)}% of best`,
		);
	if (terms.inlier < 1)
		reasons.push(
			`only ${(100 * c.inlierFraction).toFixed(0)}% of the skyline fits the DEM`,
		);
	if (terms.sigma < 1)
		reasons.push(
			`uncertain: σ yaw ${sigmaDeg.yaw.toFixed(2)}°, pitch ${sigmaDeg.pitch.toFixed(2)}°`,
		);
	if (terms.slope < 1)
		reasons.push(
			`flat skyline: yaw weakly observable (rms slope ${rmsSlope.toFixed(3)})`,
		);
	if (terms.rms < 1)
		reasons.push(`residual ${rmsPx1600.toFixed(1)} px at 1600 wide`);
	const score =
		terms.psr *
		terms.mode *
		terms.inlier *
		terms.sigma *
		terms.slope *
		terms.rms;
	const hardFail = c.inlierFraction < th.minInlier || rmsSlope < th.minRmsSlope;
	return {
		accept: score >= 0.5 && !hardFail,
		score,
		sigmaDeg,
		reasons,
		metrics: {
			psr: c.psr,
			modeRatio: c.modeRatio,
			inlierFraction: c.inlierFraction,
			corrLength: L,
			rmsSlope,
			yawInfo,
			rmsPx1600,
			scale: c.scale,
			sigmaFocal: sd(LOGF),
			sigmaEye: sd(DEYE),
		},
	};
}
