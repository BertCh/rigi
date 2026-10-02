// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Small dense Levenberg–Marquardt for the matcher's 3–4 parameter solves: the role of
// scipy.optimize.least_squares in tools/matcher (method "lm" with x_scale in fusion.solve; "trf" with
// loss "soft_l1" in match.solve_rotation). Forward-difference Jacobian, Marquardt damping on the fixed
// scale D = 1/x_scale (MINPACK mode 2), soft_l1 by iteratively reweighted residuals (the same
// stationary points as scipy's loss scaling). Not bit-identical to scipy; converges to the same minimum.

import { solveLinear } from "#/lib/linalg";

export type LeastSquaresOptions = {
	/** characteristic scale per parameter (scipy x_scale); default 1 */
	xScale?: ArrayLike<number>;
	maxNfev?: number;
	ftol?: number;
	xtol?: number;
	gtol?: number;
	loss?: "linear" | "soft_l1";
	/** soft_l1 f_scale */
	fScale?: number;
};

export type LeastSquaresResult = {
	x: Float64Array;
	/** 0.5 Σ ρ(r²) at x (scipy's `cost`) */
	cost: number;
	nfev: number;
};

const SQRT_EPS = 1.4901161193847656e-8;

function costOf(r: Float64Array, loss: "linear" | "soft_l1", fs: number) {
	let c = 0;
	if (loss === "linear") {
		for (let i = 0; i < r.length; i++) c += r[i] * r[i];
		return 0.5 * c;
	}
	const f2 = fs * fs;
	for (let i = 0; i < r.length; i++) {
		const z = (r[i] * r[i]) / f2;
		c += 2 * (Math.sqrt(1 + z) - 1);
	}
	return 0.5 * f2 * c;
}

export function leastSquares(
	fun: (x: Float64Array) => Float64Array,
	x0: ArrayLike<number>,
	opts: LeastSquaresOptions = {},
): LeastSquaresResult {
	const n = x0.length;
	const loss = opts.loss ?? "linear";
	const fs = opts.fScale ?? 1;
	const ftol = opts.ftol ?? 1e-8;
	const xtol = opts.xtol ?? 1e-8;
	const gtol = opts.gtol ?? 1e-8;
	const maxNfev = opts.maxNfev ?? 100 * (n + 1);
	const scale = Float64Array.from({ length: n }, (_, j) =>
		Math.abs(opts.xScale?.[j] ?? 1),
	);
	const D2 = scale.map((s) => 1 / (s * s));
	let x: Float64Array = Float64Array.from(x0);
	let r = fun(x);
	let nfev = 1;
	let cost = costOf(r, loss, fs);
	let lambda = -1;
	const m = r.length;
	const J = new Float64Array(m * n);
	while (nfev < maxNfev) {
		// Jacobian (forward differences, step scaled to the parameter's magnitude / x_scale)
		for (let j = 0; j < n; j++) {
			const h = SQRT_EPS * Math.max(Math.abs(x[j]), scale[j]);
			const xh = Float64Array.from(x);
			xh[j] += h;
			const rh = fun(xh);
			nfev++;
			for (let i = 0; i < m; i++) J[i * n + j] = (rh[i] - r[i]) / h;
		}
		// IRLS weights for soft_l1: sqrt(ρ'(z)), z = (r / f_scale)²
		const sw = new Float64Array(m).fill(1);
		if (loss === "soft_l1")
			for (let i = 0; i < m; i++)
				sw[i] = (1 + (r[i] * r[i]) / (fs * fs)) ** -0.25;
		const A: number[][] = Array.from({ length: n }, () =>
			new Array<number>(n).fill(0),
		);
		const g = new Array<number>(n).fill(0);
		for (let i = 0; i < m; i++) {
			const w2 = sw[i] * sw[i];
			const ri = r[i];
			for (let a = 0; a < n; a++) {
				const ja = J[i * n + a];
				if (ja === 0) continue;
				g[a] += w2 * ja * ri;
				for (let b = a; b < n; b++) A[a][b] += w2 * ja * J[i * n + b];
			}
		}
		for (let a = 0; a < n; a++) for (let b = 0; b < a; b++) A[a][b] = A[b][a];
		let gmax = 0;
		for (let a = 0; a < n; a++)
			gmax = Math.max(gmax, Math.abs(g[a]) * scale[a]);
		if (gmax < gtol * Math.max(1, cost)) break;
		if (lambda < 0) {
			let dmax = 0;
			for (let a = 0; a < n; a++) dmax = Math.max(dmax, A[a][a] / D2[a]);
			lambda = 1e-3 * (dmax || 1);
		}
		let accepted = false;
		let stop = false;
		for (let tries = 0; tries < 30 && nfev < maxNfev; tries++) {
			const M = A.map((row, a) =>
				row.map((v, b) => (a === b ? v + lambda * D2[a] : v)),
			);
			const step = solveLinear(
				M,
				g.map((v) => -v),
			);
			if (!step) {
				lambda *= 10;
				continue;
			}
			const xn = Float64Array.from(x, (v, a) => v + step[a]);
			const rn = fun(xn);
			nfev++;
			const cn = costOf(rn, loss, fs);
			let dx = 0;
			let xs = 0;
			for (let a = 0; a < n; a++) {
				dx += (step[a] / scale[a]) ** 2;
				xs += (x[a] / scale[a]) ** 2;
			}
			dx = Math.sqrt(dx);
			xs = Math.sqrt(xs);
			if (Number.isFinite(cn) && cn < cost) {
				const rel = (cost - cn) / Math.max(cost, 1e-300);
				x = xn;
				r = rn;
				cost = cn;
				lambda = Math.max(lambda / 3, 1e-12);
				accepted = true;
				if (rel < ftol || dx < xtol * (xs + xtol)) stop = true;
				break;
			}
			if (dx < xtol * (xs + xtol)) {
				stop = true;
				break;
			}
			lambda *= 4;
		}
		if (stop || !accepted) break;
	}
	return { x, cost, nfev };
}
