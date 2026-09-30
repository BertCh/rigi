// GA1 dense Levenberg–Marquardt over the 7-parameter GeoState (reports/geometry-first-pose.md G3).
//
// Every Factor carries its own loss; the solver is IRLS: at each linearisation a row with whitened
// residual z gets weight a·ψ(z), a = min(1, nEff / validRows) (grid thinning, held fixed within one
// inner solve so the cost stays comparable between trial steps), ψ the loss's IRLS weight:
//   l2 1 · huber min(1, c/|z|) · cauchy 1/(1 + z²/c²) · student (ν+1)/(ν+z²)
// and the cost is Σ a·ρ(z) with ρ(z) = z² (l2), the Huber/Cauchy ρ as in the removed concord/solve/joint.ts, and
// (ν+1)·ln(1 + z²/ν) (student; ρ'(z)/2z = ψ(z)). NaN rows are dropped from the normal equations and
// cost a constant penalty ρ(3·scale) in the objective (as joint.ts) so a step that loses rows is not
// rewarded. Fixed parameters (MapProblem.free) are never updated. Jacobians: factor.jacobian when given,
// else central differences with the core/types.ts steps (1e-3° rotation, 1e-4 logf, 0.5 m eye). Yaw is
// wrapped to [0, 360) after every step; factors must use dAngle for yaw differences.
//
// Pure TS, no DOM.
import { choleskySolve } from "../../linalg";
import { type Factor, type GeoState, IDX, type Loss, NP } from "../core";

/** Central-difference steps per parameter (core/types.ts Factor doc). */
export const FD_STEPS: readonly number[] = [
	1e-3, 1e-3, 1e-3, 1e-4, 0.5, 0.5, 0.5,
];

/** Robust cost ρ(z) of a whitened residual. */
export function lossRho(l: Loss, z: number): number {
	const z2 = z * z;
	switch (l.kind) {
		case "l2":
			return z2;
		case "huber": {
			const a = Math.abs(z);
			return a <= l.c ? z2 : 2 * l.c * a - l.c * l.c;
		}
		case "cauchy":
			return l.c * l.c * Math.log1p(z2 / (l.c * l.c));
		case "student":
			return (l.nu + 1) * Math.log1p(z2 / l.nu);
	}
}

/** IRLS weight ψ(z) = ρ'(z) / 2z. */
export function lossWeight(l: Loss, z: number): number {
	switch (l.kind) {
		case "l2":
			return 1;
		case "huber": {
			const a = Math.abs(z);
			return a <= l.c ? 1 : l.c / a;
		}
		case "cauchy":
			return 1 / (1 + (z * z) / (l.c * l.c));
		case "student":
			return (l.nu + 1) / (l.nu + z * z);
	}
}

/** Cost charged for a NaN row: ρ at 3× the loss scale (3σ for l2 / student). */
const nanPenalty = (l: Loss) =>
	lossRho(l, 3 * (l.kind === "huber" || l.kind === "cauchy" ? l.c : 1));

export const wrapYaw = (y: number) => ((y % 360) + 360) % 360;

/** Boolean mask of the free parameters of a problem (rotation always free). */
export function freeMask(free: { focal: boolean; eye: boolean }): boolean[] {
	const m = new Array<boolean>(NP).fill(false);
	m[IDX.yaw] = m[IDX.pitch] = m[IDX.roll] = true;
	m[IDX.logf] = free.focal;
	m[IDX.E] = m[IDX.N] = m[IDX.U] = free.eye;
	return m;
}

/** Number of finite rows. */
export function validRows(r: ArrayLike<number>): number {
	let n = 0;
	for (let i = 0; i < r.length; i++) if (Number.isFinite(r[i])) n++;
	return n;
}

/** Thinning factor a = min(1, nEff / validRows) of a factor at residual r. */
export function thinning(f: Factor, r: ArrayLike<number>): number {
	if (f.nEff === undefined) return 1;
	const n = validRows(r);
	return n ? Math.min(1, f.nEff / n) : 1;
}

/**
 * dim×7 Jacobian (row-major) of a factor's whitened residual. Analytic when the factor provides it;
 * otherwise central differences over the `mask` columns (other columns 0). Rows where either side is
 * NaN get 0.
 */
export function factorJacobian(
	f: Factor,
	x: GeoState,
	mask: readonly boolean[],
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
		const h = FD_STEPS[k];
		xp[k] = x[k] + h;
		const rp = f.residual(xp);
		xp[k] = x[k] - h;
		const rm = f.residual(xp);
		xp[k] = x[k];
		for (let i = 0; i < f.dim; i++) {
			const d = (rp[i] - rm[i]) / (2 * h);
			J[i * NP + k] = Number.isFinite(d) ? d : 0;
		}
	}
	return J;
}

export type Linearised = {
	/** Per factor: residual, Jacobian, thinning a and IRLS weights at x. */
	r: Float64Array[];
	J: Float64Array[];
	a: number[];
	w: Float64Array[];
};

/** Residuals, Jacobians and robust weights of every factor at x (a given ⇒ held fixed). */
export function linearise(
	factors: Factor[],
	x: GeoState,
	mask: readonly boolean[],
	a?: number[],
): Linearised {
	const r: Float64Array[] = [];
	const J: Float64Array[] = [];
	const aa: number[] = [];
	const w: Float64Array[] = [];
	factors.forEach((f, i) => {
		const ri = f.residual(x);
		r.push(ri);
		J.push(factorJacobian(f, x, mask));
		const ai = a ? a[i] : thinning(f, ri);
		aa.push(ai);
		const wi = new Float64Array(f.dim);
		for (let k = 0; k < f.dim; k++)
			wi[k] = Number.isFinite(ri[k]) ? ai * lossWeight(f.loss, ri[k]) : 0;
		w.push(wi);
	});
	return { r, J, a: aa, w };
}

/** Accumulate Σ w·JᵀJ (7×7) and Σ w·Jᵀr (7) over a subset of factors. */
export function normalEquations(
	L: Linearised,
	which: (i: number) => boolean = () => true,
): { A: Float64Array; g: Float64Array } {
	const A = new Float64Array(NP * NP);
	const g = new Float64Array(NP);
	for (let i = 0; i < L.r.length; i++) {
		if (!which(i)) continue;
		const r = L.r[i];
		const J = L.J[i];
		const w = L.w[i];
		for (let k = 0; k < r.length; k++) {
			const wk = w[k];
			if (!(wk > 0)) continue;
			const o = k * NP;
			for (let p = 0; p < NP; p++) {
				const jp = J[o + p];
				if (jp === 0) continue;
				g[p] += wk * jp * r[k];
				for (let q = 0; q <= p; q++) A[p * NP + q] += wk * jp * J[o + q];
			}
		}
	}
	for (let p = 0; p < NP; p++)
		for (let q = 0; q < p; q++) A[q * NP + p] = A[p * NP + q];
	return { A, g };
}

/** Robust objective Σ a·ρ(z) (NaN rows penalised) with fixed thinning a. */
export function objective(factors: Factor[], x: GeoState, a: number[]): number {
	let s = 0;
	factors.forEach((f, i) => {
		const r = f.residual(x);
		const pen = nanPenalty(f.loss);
		for (let k = 0; k < r.length; k++)
			s += a[i] * (Number.isFinite(r[k]) ? lossRho(f.loss, r[k]) : pen);
	});
	return s;
}

export type LmOpts = {
	maxIter?: number;
	/** Extra quadratic prior (x − centre)/σ on the eye (proximal trust term), or null. */
	trust?: { centre: [number, number, number]; sigmaM: number } | null;
	signal?: AbortSignal;
};

export type LmResult = {
	x: GeoState;
	cost: number;
	iterations: number;
	converged: boolean;
};

/** Trust term as a Factor (quadratic, prior). */
export function trustFactor(
	centre: [number, number, number],
	sigmaM: number,
): Factor {
	return {
		family: "gps",
		name: "trust",
		dim: 3,
		loss: { kind: "l2" },
		prior: true,
		residual: (x) =>
			Float64Array.of(
				(x[IDX.E] - centre[0]) / sigmaM,
				(x[IDX.N] - centre[1]) / sigmaM,
				(x[IDX.U] - centre[2]) / sigmaM,
			),
		jacobian: () => {
			const J = new Float64Array(3 * NP);
			J[IDX.E] = J[NP + IDX.N] = J[2 * NP + IDX.U] = 1 / sigmaM;
			return J;
		},
	};
}

/**
 * Levenberg–Marquardt with per-factor IRLS on the free parameters (Marquardt damping λ·diag(A)).
 * Stops when a step is rejected at λ = 1e10, the step is below 1e-3 of the FD steps, or the relative
 * cost drop is below 1e-10.
 */
export function lmSolve(
	factors0: Factor[],
	x0: GeoState,
	mask: readonly boolean[],
	o: LmOpts = {},
): LmResult {
	const maxIter = o.maxIter ?? 50;
	const factors = o.trust
		? [...factors0, trustFactor(o.trust.centre, o.trust.sigmaM)]
		: factors0;
	const idx: number[] = [];
	for (let k = 0; k < NP; k++) if (mask[k]) idx.push(k);
	const n = idx.length;
	let x: GeoState = Float64Array.from(x0);
	let L = linearise(factors, x, mask);
	const a = L.a; // thinning fixed for this solve
	let cost = objective(factors, x, a);
	let lambda = 1e-3;
	let iterations = 0;
	let converged = false;
	for (let it = 0; it < maxIter; it++) {
		if (o.signal?.aborted) throw new Error("aborted");
		iterations++;
		const { A, g } = normalEquations(L);
		const As = new Float64Array(n * n);
		const gs = new Float64Array(n);
		for (let i = 0; i < n; i++) {
			gs[i] = -g[idx[i]];
			for (let j = 0; j < n; j++) As[i * n + j] = A[idx[i] * NP + idx[j]];
		}
		let accepted = false;
		let small = false;
		while (lambda < 1e10) {
			const M = Float64Array.from(As);
			for (let i = 0; i < n; i++)
				M[i * n + i] = As[i * n + i] * (1 + lambda) + 1e-12;
			const d = choleskySolve(M, gs, n);
			if (!d || !d.every(Number.isFinite)) {
				lambda *= 10;
				continue;
			}
			const xn = Float64Array.from(x);
			for (let i = 0; i < n; i++) xn[idx[i]] += d[i];
			xn[IDX.yaw] = wrapYaw(xn[IDX.yaw]);
			const cn = objective(factors, xn, a);
			if (cn <= cost) {
				small = idx.every((k, i) => Math.abs(d[i]) < FD_STEPS[k] * 1e-3);
				if (cost - cn < 1e-10 * Math.max(1, cost)) small = true;
				x = xn;
				cost = cn;
				lambda = Math.max(lambda / 3, 1e-9);
				accepted = true;
				break;
			}
			lambda *= 4;
		}
		if (!accepted || small) {
			converged = true;
			break;
		}
		L = linearise(factors, x, mask, a);
	}
	return { x, cost, iterations, converged };
}
