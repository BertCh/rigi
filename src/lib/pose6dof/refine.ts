// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { wrap360 } from "#/lib/geodesy";
// Generic LM refinement of the eye position (and optionally rotation / vfov) against a
// caller-supplied residual callback — e.g. skyline residuals from re-rendering the horizon at a
// shifted eye (near-field cliff-edge photos). Numeric forward/central-difference Jacobian, Huber IRLS,
// Gaussian priors. Works with sync or async residual functions.
import type { Pose } from "../camera";
import { wrap180 } from "../geodesy";
import { invSym, solveLinear } from "../linalg";
import { PARAM_NAMES, type ParamName } from "./project";
import { paramsPose, toParams } from "./solve";

export type ResidualFn = (
	pose: Pose,
	eye: [number, number, number],
) => number[] | Promise<number[]>;

export type RefineOptions = {
	/** Parameters to refine (default dx, dy, dz). */
	params?: ParamName[];
	/**
	 * Gaussian priors (σ undefined / Infinity = none, σ 0 = hold that parameter even if listed in
	 * `params`). Position prior defaults to the start eye with σH 15 m, σV 20 m.
	 */
	priors?: {
		position?: {
			value?: [number, number, number];
			sigmaH?: number;
			sigmaV?: number;
		};
		yaw?: { value?: number; sigma?: number };
		pitch?: { value?: number; sigma?: number };
		roll?: { value?: number; sigma?: number };
		vfov?: { value?: number; sigma?: number };
	};
	/** Finite-difference steps (default 1 m for position, 0.01° for angles/vfov). */
	steps?: Partial<Record<ParamName, number>>;
	/** Central instead of forward differences (2× the residual evaluations, much better on kinked residuals). */
	central?: boolean;
	/** Huber threshold in residual units (default Infinity = least squares). */
	huber?: number;
	/** Cost charged per residual that is NaN (no data) — default min(huber², 9). */
	nanPenalty?: number;
	maxIterations?: number;
	/**
	 * Coarse horizontal grid search before LM (near-field silhouettes have a narrow basin: 30 m at
	 * 150 m is ~11°). Evaluates (2·radius/step + 1)² offsets around the start eye (plus `dz` values
	 * if given) and starts LM from the cheapest. Costs one residual evaluation per cell. Only axes
	 * being refined move: dx / dy need to be in `params` (else the grid is skipped), and `dz`
	 * values are ignored unless dz is refined. Grid cells are charged the position prior.
	 */
	grid?: { radius: number; step: number; dz?: number[] };
	/** Called after every accepted step. */
	onIteration?: (
		it: number,
		pose: Pose,
		eye: [number, number, number],
		cost: number,
	) => void;
};

export type RefineResult = {
	pose: Pose;
	eye: [number, number, number];
	cost: number;
	initialCost: number;
	iterations: number;
	evaluations: number;
	converged: boolean;
	/** 1σ per refined parameter (from (JᵀJ)⁻¹ scaled by the residual variance). */
	sigma: Partial<Record<ParamName, number>>;
};

export async function refinePosition(
	pose: Pose,
	eye: ArrayLike<number>,
	residualFn: ResidualFn,
	opts: RefineOptions = {},
): Promise<RefineResult> {
	const names = opts.params ?? ["dx", "dy", "dz"];
	for (const nm of names)
		if (!PARAM_NAMES.includes(nm))
			throw new RangeError(`refinePosition: unknown param ${nm}`);
	const huber = opts.huber ?? Number.POSITIVE_INFINITY;
	const nanPen = opts.nanPenalty ?? Math.min(huber * huber, 9);
	const pr = opts.priors ?? {};
	const p0 = toParams(pose, eye);
	const pos = pr.position ?? {};
	const pv = pos.value ?? [p0[0], p0[1], p0[2]];
	const mean = [
		pv[0],
		pv[1],
		pv[2],
		pr.yaw?.value ?? p0[3],
		pr.pitch?.value ?? p0[4],
		pr.roll?.value ?? p0[5],
		pr.vfov?.value ?? p0[6],
	];
	const S = (x?: number) => {
		if (x === undefined) return Number.POSITIVE_INFINITY;
		if (Number.isNaN(x) || x < 0)
			throw new RangeError(
				`refinePosition: prior sigma must be >= 0 (got ${x})`,
			);
		return x;
	};
	const sig = [
		S(pos.sigmaH ?? 15),
		S(pos.sigmaH ?? 15),
		S(pos.sigmaV ?? 20),
		S(pr.yaw?.sigma),
		S(pr.pitch?.sigma),
		S(pr.roll?.sigma),
		S(pr.vfov?.sigma),
	];
	// σ 0 = hold: drop from the refined set (value stays at the start / prior value)
	const idx = names
		.map((nm) => PARAM_NAMES.indexOf(nm))
		.filter((k) => sig[k] !== 0);
	const n = idx.length;
	const hasPrior = (k: number) => Number.isFinite(sig[k]) && sig[k] > 0;
	const step = PARAM_NAMES.map((k, i) => opts.steps?.[k] ?? (i < 3 ? 1 : 0.01));
	let evals = 0;
	const call = async (p: number[]) => {
		evals++;
		return await residualFn(paramsPose(p), [p[0], p[1], p[2]]);
	};
	const rho = (r: number) => {
		const a = Math.abs(r);
		return a <= huber ? r * r : 2 * huber * a - huber * huber;
	};
	const costOf = (p: number[], r: number[]) => {
		let c = 0;
		for (const x of r) c += Number.isFinite(x) ? rho(x) : nanPen;
		for (const k of idx)
			if (hasPrior(k))
				c +=
					((k === 3 ? wrap180(p[k] - mean[k]) : p[k] - mean[k]) / sig[k]) ** 2;
		return c;
	};
	let p = p0.slice();
	let r = await call(p);
	let cost = costOf(p, r);
	const initialCost = cost;
	const gridH = idx.includes(0) || idx.includes(1);
	if (opts.grid && opts.grid.step > 0 && gridH) {
		const { radius, step: gs } = opts.grid;
		const m = Math.floor(radius / gs);
		const mx = idx.includes(0) ? m : 0;
		const my = idx.includes(1) ? m : 0;
		const dzs = idx.includes(2) ? (opts.grid.dz ?? [0]) : [0];
		for (const dz of dzs)
			for (let i = -mx; i <= mx; i++)
				for (let j = -my; j <= my; j++) {
					if (i === 0 && j === 0 && dz === 0) continue;
					const q = p0.slice();
					q[0] += i * gs;
					q[1] += j * gs;
					q[2] += dz;
					const rq = await call(q);
					const cq = costOf(q, rq);
					if (cq < cost) {
						p = q;
						r = rq;
						cost = cq;
					}
				}
	}
	let lambda = 1e-3;
	let converged = false;
	let it = 0;
	let lastA: number[][] = [];
	let lastChi = 0;
	let lastM = 0;
	const maxIt = opts.maxIterations ?? 20;
	for (; it < maxIt; it++) {
		// Jacobian (forward differences)
		const J: number[][] = [];
		for (const k of idx) {
			const q = p.slice();
			q[k] += step[k];
			const r2 = await call(q);
			if (opts.central) {
				const qm = p.slice();
				qm[k] -= step[k];
				const r3 = await call(qm);
				J.push(
					r.map((x, m) =>
						Number.isFinite(x) &&
						Number.isFinite(r2[m]) &&
						Number.isFinite(r3[m])
							? (r2[m] - r3[m]) / (2 * step[k])
							: 0,
					),
				);
			} else
				J.push(
					r.map((x, m) =>
						Number.isFinite(x) && Number.isFinite(r2[m])
							? (r2[m] - x) / step[k]
							: 0,
					),
				);
		}
		const A = Array.from({ length: n }, () => new Array<number>(n).fill(0));
		const g = new Array<number>(n).fill(0);
		let chi = 0;
		let m = 0;
		r.forEach((x, j) => {
			if (!Number.isFinite(x)) return;
			const w = Math.abs(x) <= huber ? 1 : huber / Math.abs(x);
			chi += w * x * x;
			m++;
			for (let a = 0; a < n; a++) {
				g[a] += w * J[a][j] * x;
				for (let b = 0; b < n; b++) A[a][b] += w * J[a][j] * J[b][j];
			}
		});
		idx.forEach((k, a) => {
			if (!hasPrior(k)) return;
			const d = k === 3 ? wrap180(p[k] - mean[k]) : p[k] - mean[k];
			g[a] += d / sig[k] ** 2;
			A[a][a] += 1 / sig[k] ** 2;
		});
		lastA = A;
		lastChi = chi;
		lastM = m;
		let accepted = false;
		while (lambda < 1e8) {
			const Ad = A.map((row, a) =>
				row.map((x, b) =>
					a === b ? x + lambda * Math.max(x, 1e-9) + 1e-12 : x,
				),
			);
			const d = solveLinear(
				Ad,
				g.map((x) => -x),
			);
			if (!d) {
				lambda *= 10;
				continue;
			}
			const q = p.slice();
			idx.forEach((k, a) => {
				q[k] += d[a];
			});
			const r2 = await call(q);
			const c2 = costOf(q, r2);
			if (c2 <= cost) {
				const rel = (cost - c2) / Math.max(cost, 1e-12);
				p = q;
				r = r2;
				cost = c2;
				lambda = Math.max(lambda / 3, 1e-9);
				accepted = true;
				opts.onIteration?.(it, paramsPose(p), [p[0], p[1], p[2]], cost);
				if (rel < 1e-6) converged = true;
				break;
			}
			lambda *= 4;
		}
		if (!accepted || converged) {
			converged = true;
			break;
		}
	}
	const sigma: Partial<Record<ParamName, number>> = {};
	if (lastA.length) {
		const cov = invSym(lastA);
		const dof = lastM - n;
		const s2 = dof >= 3 ? lastChi / dof : 1;
		idx.forEach((k, a) => {
			sigma[PARAM_NAMES[k]] = Math.sqrt(Math.max(cov[a][a] * s2, 0));
		});
	}
	return {
		pose: { ...paramsPose(p), yaw: wrap360(p[3]) },
		eye: [p[0], p[1], p[2]],
		cost,
		initialCost,
		iterations: it + 1,
		evaluations: evals,
		converged,
		sigma,
	};
}

/**
 * Helper for skyline-style residuals: given observed skyline samples (u, v) and a predictor that
 * returns the predicted skyline v at column u for a pose/eye (e.g. by rendering or ray-marching the
 * DEM horizon from `eye`), return a ResidualFn in pixels (NaN where the predictor has no data).
 */
export function skylineResidual(
	samples: { u: number; v: number }[],
	predictV: (
		pose: Pose,
		eye: [number, number, number],
		us: number[],
	) => (number | null)[] | Promise<(number | null)[]>,
	imageHeight: number,
): ResidualFn {
	const us = samples.map((s) => s.u);
	return async (pose, eye) => {
		const pv = await predictV(pose, eye, us);
		return samples.map((s, i) => {
			const x = pv[i];
			return x === null || x === undefined || !Number.isFinite(x)
				? Number.NaN
				: (x - s.v) * imageHeight;
		});
	};
}
