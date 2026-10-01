// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * Small dense Levenberg–Marquardt for a handful of parameters, with a
 * numeric Jacobian and optional Huber/Cauchy weighting (IRLS). Residuals may
 * be NaN to mark "no data" — those are ignored. Prior terms stay quadratic.
 */
import { gaussJordan } from "../linalg";

export interface LMOptions {
	maxIterations?: number;
	/** Huber threshold in residual units; Infinity = plain least squares. */
	huber?: number;
	/**
	 * Cauchy scale in residual units. Redescending, so gross outliers (e.g. a
	 * person in front of the skyline) stop pulling; needs a good start.
	 * Takes precedence over `huber`.
	 */
	cauchy?: number;
	/** Finite-difference step per parameter. */
	steps?: number[];
	/** Gaussian prior: (p - mean) / sigma is appended as a residual. */
	prior?: { mean: number[]; sigma: number[] };
}

export interface LMResult {
	params: number[];
	cost: number;
	iterations: number;
	residuals: number[];
}

type ResidualFn = (p: number[]) => number[];

function withPrior(fn: ResidualFn, prior?: LMOptions["prior"]): ResidualFn {
	if (!prior) return fn;
	return (p) => [
		...fn(p),
		...p.map((v, i) => (v - prior.mean[i]) / prior.sigma[i]),
	];
}

interface Loss {
	weight(r: number): number;
	cost(r: number): number;
}

function makeLoss(opts: LMOptions): Loss {
	if (opts.cauchy !== undefined) {
		const c2 = opts.cauchy ** 2;
		return {
			weight: (r) => 1 / (1 + (r * r) / c2),
			cost: (r) => 0.5 * c2 * Math.log1p((r * r) / c2),
		};
	}
	const k = opts.huber ?? Number.POSITIVE_INFINITY;
	return {
		weight: (r) => (Math.abs(r) <= k ? 1 : k / Math.abs(r)),
		cost: (r) => {
			const a = Math.abs(r);
			return a <= k ? 0.5 * r * r : k * (a - 0.5 * k);
		},
	};
}

/** The last `nPrior` residuals are prior terms and stay quadratic. */
function robustCost(r: number[], loss: Loss, nPrior: number) {
	let c = 0;
	const nData = r.length - nPrior;
	for (let i = 0; i < r.length; i++) {
		const v = r[i];
		if (Number.isNaN(v)) continue;
		c += i < nData ? loss.cost(v) : 0.5 * v * v;
	}
	return c;
}

export function levenbergMarquardt(
	residualFn: ResidualFn,
	initial: number[],
	opts: LMOptions = {},
): LMResult {
	const fn = withPrior(residualFn, opts.prior);
	const loss = makeLoss(opts);
	const nPrior = opts.prior ? initial.length : 0;
	const steps = opts.steps ?? initial.map(() => 1e-4);
	const maxIt = opts.maxIterations ?? 30;
	const n = initial.length;
	let p = [...initial];
	let r = fn(p);
	let cost = robustCost(r, loss, nPrior);
	let lambda = 1e-3;
	let it = 0;

	for (; it < maxIt; it++) {
		const w = r.map((v, i) =>
			Number.isNaN(v) ? 0 : i < r.length - nPrior ? loss.weight(v) : 1,
		);
		const J: number[][] = [];
		for (let j = 0; j < n; j++) {
			const q = [...p];
			q[j] += steps[j];
			const r2 = fn(q);
			J.push(r2.map((v, i) => (v - r[i]) / steps[j]));
		}
		const JtJ = Array.from({ length: n }, () => new Array(n).fill(0));
		const Jtr = new Array(n).fill(0);
		for (let i = 0; i < r.length; i++) {
			if (w[i] === 0) continue;
			let ok = true;
			for (let j = 0; j < n; j++) if (!Number.isFinite(J[j][i])) ok = false;
			if (!ok) continue;
			for (let a = 0; a < n; a++) {
				Jtr[a] += w[i] * J[a][i] * r[i];
				for (let b = a; b < n; b++) JtJ[a][b] += w[i] * J[a][i] * J[b][i];
			}
		}
		for (let a = 0; a < n; a++)
			for (let b = 0; b < a; b++) JtJ[a][b] = JtJ[b][a];

		let improved = false;
		for (let tries = 0; tries < 8; tries++) {
			const A = JtJ.map((row, i) =>
				row.map((v, j) => (i === j ? v * (1 + lambda) + 1e-9 : v)),
			);
			const delta = gaussJordan(
				A,
				Jtr.map((v) => -v),
				1e-12,
			);
			if (!delta) {
				lambda *= 10;
				continue;
			}
			const q = p.map((v, i) => v + delta[i]);
			const rq = fn(q);
			const cq = robustCost(rq, loss, nPrior);
			if (cq < cost) {
				const rel = (cost - cq) / Math.max(cost, 1e-12);
				p = q;
				r = rq;
				cost = cq;
				lambda = Math.max(lambda / 3, 1e-7);
				improved = true;
				if (rel < 1e-7) it = maxIt;
				break;
			}
			lambda *= 10;
		}
		if (!improved) break;
	}
	return { params: p, cost, iterations: it, residuals: r };
}
