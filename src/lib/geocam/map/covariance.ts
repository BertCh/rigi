// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// GA1 Laplace covariance at the MAP solution.
//
//   Σ = (Σ_f JᵀW J)⁻¹ over the free parameters, W = a·ψ(z) (thinning × IRLS weight at the solution),
//
// i.e. the Gauss–Newton Hessian of the robust objective (the same weighting GTSAM's robust noise models
// use for Marginals, so the Python reference can match it). The DATA block (factors with prior ≠ true)
// is divided by s², s = max(1, MAD scale of the pooled whitened data residuals) (refine/robust.ts
// madScale): when the data scatter more than their modelled σ the covariance widens accordingly; it
// never shrinks below the model. Rows / cols of fixed parameters are 0; an unobservable free
// parameter has variance +Infinity. perFamily.info is each family's
// (s-scaled for data) 7×7 information, reused by GA5 (integrity; GA2 observe was removed 2026-09-30).
import { invSymCov } from "../../linalg";
import { madScale } from "../../refine/robust";
import {
	type CueFamily,
	type Factor,
	type FamilyReport,
	type GeoState,
	IDX,
	NP,
	PARAMS,
	type ParamName,
} from "../core";
import { linearise, lossWeight, normalEquations, validRows } from "./lm";

export type CovarianceOpts = { madRescale?: boolean };

export type CovarianceOut = {
	cov: Float64Array;
	sigma: Record<ParamName, number>;
	sigmaEN: number;
	perFamily: FamilyReport[];
	mad: number;
	/** Total information (7×7, data block MAD-scaled). */
	info: Float64Array;
};

/** √ of the largest eigenvalue of a symmetric 2×2 [[a, b], [b, d]]. */
export function sqrtLambdaMax2(a: number, b: number, d: number): number {
	// an unobservable axis (variance +Infinity) would give ∞ − ∞ = NaN below
	if (a === Number.POSITIVE_INFINITY || d === Number.POSITIVE_INFINITY)
		return Number.POSITIVE_INFINITY;
	const t = (a + d) / 2;
	const q = Math.sqrt(Math.max(0, ((a - d) / 2) ** 2 + b * b));
	return Math.sqrt(Math.max(0, t + q));
}

/**
 * Inverse of the free sub-block of a 7×7 information matrix, embedded back (fixed rows/cols 0). A free
 * parameter the information does not observe gets variance +Infinity (linalg invSymCov, CR-49).
 */
export function covFromInfo(
	info: Float64Array,
	mask: readonly boolean[],
): Float64Array {
	const idx: number[] = [];
	for (let k = 0; k < NP; k++) if (mask[k]) idx.push(k);
	const A = idx.map((p) => idx.map((q) => info[p * NP + q]));
	const Ai = idx.length ? invSymCov(A) : [];
	const cov = new Float64Array(NP * NP);
	idx.forEach((p, i) => {
		idx.forEach((q, j) => {
			cov[p * NP + q] = Ai[i][j];
		});
	});
	return cov;
}

export function sigmaOf(cov: Float64Array): Record<ParamName, number> {
	const s = {} as Record<ParamName, number>;
	PARAMS.forEach((p, k) => {
		s[p] = Math.sqrt(Math.max(0, cov[k * NP + k]));
	});
	return s;
}

export const sigmaENOf = (cov: Float64Array) =>
	sqrtLambdaMax2(
		cov[IDX.E * NP + IDX.E],
		cov[IDX.E * NP + IDX.N],
		cov[IDX.N * NP + IDX.N],
	);

/** Laplace covariance of `factors` at x over the `mask` parameters. */
export function laplaceCovariance(
	factors: Factor[],
	x: GeoState,
	mask: readonly boolean[],
	o: CovarianceOpts = {},
): CovarianceOut {
	const L = linearise(factors, x, mask);
	// MAD of the pooled whitened data residuals
	const e: number[] = [];
	factors.forEach((f, i) => {
		if (f.prior) return;
		for (const z of L.r[i]) if (Number.isFinite(z)) e.push(z);
	});
	const mad = e.length >= 5 ? madScale(e, new Array(e.length).fill(1)) : 1;
	const s2 = o.madRescale === false ? 1 : Math.max(1, mad) ** 2;
	const info = new Float64Array(NP * NP);
	const fams = new Map<
		CueFamily,
		{ n: number; nEff: number; chi2: number; info: Float64Array }
	>();
	factors.forEach((f, i) => {
		const { A } = normalEquations(L, (j) => j === i);
		const k = f.prior ? 1 : 1 / s2;
		let rec = fams.get(f.family);
		if (!rec) {
			rec = { n: 0, nEff: 0, chi2: 0, info: new Float64Array(NP * NP) };
			fams.set(f.family, rec);
		}
		const n = validRows(L.r[i]);
		rec.n += n;
		rec.nEff += n * L.a[i];
		for (const z of L.r[i])
			if (Number.isFinite(z))
				rec.chi2 += L.a[i] * lossWeight(f.loss, z) * z * z;
		for (let q = 0; q < NP * NP; q++) {
			rec.info[q] += k * A[q];
			info[q] += k * A[q];
		}
	});
	const cov = covFromInfo(info, mask);
	return {
		cov,
		sigma: sigmaOf(cov),
		sigmaEN: sigmaENOf(cov),
		perFamily: [...fams].map(([family, r]) => ({ family, ...r })),
		mad,
		info,
	};
}
