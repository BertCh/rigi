// GA2 observability (reports/geometry-first-pose.md G2): Fisher information / Cramér–Rao bound per DoF.
//
// For every factor the Jacobian of its whitened residual w.r.t. the state is taken by central differences
// (analytic when the factor provides one). A whitened residual is (prediction − observation)/σ, so this is
// the Jacobian of the PREDICTIONS scaled by the row σ: the observations never enter. The information is
//     I = Σ_f a_f · J_fᵀ J_f          (a_f = min(1, nEff/rows): grid thinning, as the MAP solver)
// with no IRLS weights and no MAD rescale, i.e. the CRLB of the model at x under Gaussian row noise σ. It
// says what the geometry (cue positions, depths, priors) CAN determine, independent of how well the photo
// agrees. map/covariance.ts is the complementary Laplace covariance at a solution (robust weights + MAD).
//
// byFamily: sigmaEyeAlone = σ_EN from that family's information plus the prior families' (a data family
// alone rarely pins rotation); share = the family's part of the posterior E/N variance, from
// Σ = Σ·I·Σ = Σ_f Σ·I_f·Σ: share_f = tr((Σ I_f Σ)_EN) / tr(Σ_EN) (shares sum to 1).
// cond: condition number of the free block after scaling to unit diagonal (correlation form).
import {
	type CueFamily,
	type Factor,
	type GeoState,
	IDX,
	type MapProblem,
	NP,
	PARAMS,
	type ParamName,
	PRIOR_FAMILIES,
} from "../core";

/** Central-difference steps (core/types.ts): 1e-3° rotation, 1e-4 logf, 0.5 m eye. */
export const CRLB_STEPS: readonly number[] = [
	1e-3, 1e-3, 1e-3, 1e-4, 0.5, 0.5, 0.5,
];

export type FamilyFisher = {
	family: CueFamily;
	/** Valid rows. */
	n: number;
	/** This family's 7×7 information (thinned). */
	info: Float64Array;
	/** σ_EN (m) from this family + the prior families (∞ if singular). Priors: from all priors. */
	sigmaEyeAlone: number;
	/** Share of the posterior E/N variance attributable to this family (Σ shares = 1). */
	share: number;
};

export type FisherReport = {
	info: Float64Array;
	/** 7×7 CRLB covariance (free block inverted; fixed rows/cols 0). */
	cov: Float64Array;
	sigma: Record<ParamName, number>;
	/** √λmax of the E/N block (m): the horizontal eye bound (NaN if the eye is fixed). */
	sigmaEye: number;
	sigmaU: number;
	/** √λmax of the E/N/U block (m). */
	sigmaEye3: number;
	byFamily: FamilyFisher[];
	/** Condition number of the free block in correlation form (∞ if singular). */
	cond: number;
	mask: boolean[];
};

export type CrlbOpts = {
	steps?: readonly number[];
	/** Relinearize eye-dependent factors at x first. Default true. */
	relinearize?: boolean;
	/** Apply nEff thinning. Default true. */
	thinning?: boolean;
};

/** Free-parameter mask of a problem (rotation always free). */
export function problemMask(p: MapProblem): boolean[] {
	const m = new Array<boolean>(NP).fill(false);
	m[IDX.yaw] = m[IDX.pitch] = m[IDX.roll] = true;
	m[IDX.logf] = p.free.focal;
	m[IDX.E] = m[IDX.N] = m[IDX.U] = p.free.eye;
	return m;
}

/** dim×7 Jacobian of a factor's whitened residual (analytic or central differences on the mask). */
export function jacobianOf(
	f: Factor,
	x: GeoState,
	mask: readonly boolean[],
	steps: readonly number[] = CRLB_STEPS,
): Float64Array {
	if (f.jacobian) {
		const J = f.jacobian(x);
		for (let k = 0; k < NP; k++)
			if (!mask[k]) for (let i = 0; i < f.dim; i++) J[i * NP + k] = 0;
		return J;
	}
	const J = new Float64Array(f.dim * NP);
	const xp = Float64Array.from(x);
	for (let k = 0; k < NP; k++) {
		if (!mask[k]) continue;
		const h = steps[k];
		xp[k] = x[k] + h;
		const rp = f.residual(xp);
		xp[k] = x[k] - h;
		const rm = f.residual(xp);
		xp[k] = x[k];
		for (let i = 0; i < f.dim; i++) {
			const d = (rp[i] - rm[i]) / (2 * h);
			J[i * NP + k] = Number.isFinite(d) ? d : Number.NaN;
		}
	}
	return J;
}

/** Thinned Gaussian information JᵀJ of one factor at x (rows with a non-finite residual or Jacobian dropped). */
export function factorInfo(
	f: Factor,
	x: GeoState,
	mask: readonly boolean[],
	o: CrlbOpts = {},
): { info: Float64Array; n: number } {
	const r = f.residual(x);
	const J = jacobianOf(f, x, mask, o.steps);
	const rows: number[] = [];
	for (let i = 0; i < f.dim; i++) {
		if (!Number.isFinite(r[i])) continue;
		let ok = true;
		for (let k = 0; k < NP; k++)
			if (mask[k] && !Number.isFinite(J[i * NP + k])) ok = false;
		if (ok) rows.push(i);
	}
	const a =
		o.thinning === false || f.nEff === undefined || !rows.length
			? 1
			: Math.min(1, f.nEff / rows.length);
	const info = new Float64Array(NP * NP);
	for (const i of rows)
		for (let p = 0; p < NP; p++) {
			const jp = J[i * NP + p];
			if (!jp || !mask[p]) continue;
			for (let q = 0; q < NP; q++) {
				if (!mask[q]) continue;
				info[p * NP + q] += a * jp * J[i * NP + q];
			}
		}
	return { info, n: rows.length };
}

/**
 * Inverse of the masked block of a 7×7 symmetric PSD matrix (null if singular), embedded back. The block is
 * scaled to unit diagonal first (degrees vs metres differ by orders of magnitude), so the singularity test
 * (pivot < 1e-12) is unit-free.
 */
export function invMasked(
	A: Float64Array,
	mask: readonly boolean[],
): Float64Array | null {
	const idx: number[] = [];
	for (let k = 0; k < NP; k++) if (mask[k]) idx.push(k);
	const n = idx.length;
	const dg = idx.map((k) => Math.sqrt(A[k * NP + k]));
	if (dg.some((d) => !(d > 0) || !Number.isFinite(d))) return null;
	const M = idx.map((p, i) => [
		...idx.map((q, j) => A[p * NP + q] / (dg[i] * dg[j])),
		...idx.map((_, j) => (j === i ? 1 : 0)),
	]);
	for (let c = 0; c < n; c++) {
		let piv = c;
		for (let r = c + 1; r < n; r++)
			if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
		if (!(Math.abs(M[piv][c]) > 1e-12)) return null;
		[M[c], M[piv]] = [M[piv], M[c]];
		const d = M[c][c];
		for (let j = 0; j < 2 * n; j++) M[c][j] /= d;
		for (let r = 0; r < n; r++) {
			if (r === c) continue;
			const f = M[r][c];
			if (f === 0) continue;
			for (let j = 0; j < 2 * n; j++) M[r][j] -= f * M[c][j];
		}
	}
	const out = new Float64Array(NP * NP);
	idx.forEach((p, i) => {
		idx.forEach((q, j) => {
			out[p * NP + q] = M[i][n + j] / (dg[i] * dg[j]);
		});
	});
	return out;
}

/** Eigenvalues of a small symmetric matrix (cyclic Jacobi). */
export function symEigenvalues(S: number[][]): number[] {
	const n = S.length;
	const a = S.map((r) => [...r]);
	for (let sweep = 0; sweep < 60; sweep++) {
		let off = 0;
		for (let p = 0; p < n; p++)
			for (let q = p + 1; q < n; q++) off += a[p][q] ** 2;
		if (off < 1e-30) break;
		for (let p = 0; p < n; p++)
			for (let q = p + 1; q < n; q++) {
				if (Math.abs(a[p][q]) < 1e-300) continue;
				const th = (a[q][q] - a[p][p]) / (2 * a[p][q]);
				const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1));
				const c = 1 / Math.sqrt(t * t + 1);
				const s = t * c;
				for (let k = 0; k < n; k++) {
					const akp = a[k][p];
					const akq = a[k][q];
					a[k][p] = c * akp - s * akq;
					a[k][q] = s * akp + c * akq;
				}
				for (let k = 0; k < n; k++) {
					const apk = a[p][k];
					const aqk = a[q][k];
					a[p][k] = c * apk - s * aqk;
					a[q][k] = s * apk + c * aqk;
				}
			}
	}
	return a.map((r, i) => r[i]);
}

const block = (C: Float64Array, ks: number[]) =>
	ks.map((p) => ks.map((q) => C[p * NP + q]));

/** √λmax of a covariance sub-block. */
export const sqrtLambdaMax = (C: Float64Array, ks: number[]) =>
	Math.sqrt(Math.max(0, ...symEigenvalues(block(C, ks))));

const EN = [IDX.E, IDX.N];
const ENU = [IDX.E, IDX.N, IDX.U];

/**
 * CRLB of the problem at x. Factors with `relinearize` are re-linearised at x first (default), so their
 * eye-dependent predictions (horizons, junctions) are those of x.
 */
export async function crlb(
	p: MapProblem,
	x: GeoState,
	o: CrlbOpts = {},
): Promise<FisherReport> {
	const mask = problemMask(p);
	if (o.relinearize !== false)
		for (const f of p.factors) if (f.relinearize) await f.relinearize(x);
	const fams = new Map<CueFamily, { n: number; info: Float64Array }>();
	const info = new Float64Array(NP * NP);
	for (const f of p.factors) {
		const fi = factorInfo(f, x, mask, o);
		let r = fams.get(f.family);
		if (!r) {
			r = { n: 0, info: new Float64Array(NP * NP) };
			fams.set(f.family, r);
		}
		r.n += fi.n;
		for (let q = 0; q < NP * NP; q++) {
			r.info[q] += fi.info[q];
			info[q] += fi.info[q];
		}
	}
	const inv = invMasked(info, mask);
	const cov = inv ?? new Float64Array(NP * NP).fill(Number.POSITIVE_INFINITY);
	const sigma = {} as Record<ParamName, number>;
	PARAMS.forEach((pn, k) => {
		sigma[pn] = mask[k] ? Math.sqrt(Math.max(0, cov[k * NP + k])) : 0;
	});
	const eyeFree = mask[IDX.E];
	const sigmaEye = !eyeFree
		? Number.NaN
		: inv
			? sqrtLambdaMax(cov, EN)
			: Infinity;
	const sigmaEye3 = !eyeFree
		? Number.NaN
		: inv
			? sqrtLambdaMax(cov, ENU)
			: Infinity;

	// prior information (for sigmaEyeAlone)
	const priorInfo = new Float64Array(NP * NP);
	for (const [fam, r] of fams)
		if (PRIOR_FAMILIES.includes(fam))
			for (let q = 0; q < NP * NP; q++) priorInfo[q] += r.info[q];
	const trEN = inv
		? cov[IDX.E * NP + IDX.E] + cov[IDX.N * NP + IDX.N]
		: Number.NaN;
	const byFamily: FamilyFisher[] = [...fams].map(([family, r]) => {
		const isPrior = PRIOR_FAMILIES.includes(family);
		// data family: its information + all priors; prior family: all priors
		const A = new Float64Array(NP * NP);
		for (let q = 0; q < NP * NP; q++)
			A[q] = isPrior ? priorInfo[q] : r.info[q] + priorInfo[q];
		const Ai = eyeFree ? invMasked(A, mask) : null;
		const sigmaEyeAlone = !eyeFree
			? Number.NaN
			: Ai
				? sqrtLambdaMax(Ai, EN)
				: Infinity;
		// share of tr(Σ_EN): (Σ I_f Σ)_ee summed over e ∈ {E, N}
		let share = Number.NaN;
		if (inv && eyeFree && trEN > 0) {
			let s = 0;
			for (const e of EN)
				for (let p_ = 0; p_ < NP; p_++)
					for (let q = 0; q < NP; q++)
						s += cov[e * NP + p_] * r.info[p_ * NP + q] * cov[q * NP + e];
			share = s / trEN;
		}
		return { family, n: r.n, info: r.info, sigmaEyeAlone, share };
	});

	// condition number in correlation form
	const idx: number[] = [];
	for (let k = 0; k < NP; k++) if (mask[k]) idx.push(k);
	const dg = idx.map((k) => Math.sqrt(Math.max(info[k * NP + k], 1e-300)));
	const Cn = idx.map((pi, i) =>
		idx.map((qi, j) => info[pi * NP + qi] / (dg[i] * dg[j])),
	);
	const ev = symEigenvalues(Cn);
	const lmin = Math.min(...ev);
	const cond = lmin > 1e-15 ? Math.max(...ev) / lmin : Infinity;

	return {
		info,
		cov,
		sigma,
		sigmaEye,
		sigmaU: eyeFree ? sigma.U : Number.NaN,
		sigmaEye3,
		byFamily,
		cond,
		mask,
	};
}
