// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Robust Levenberg–Marquardt over a pinhole pose (OpenCV axes: x right, y down, z forward):
//   p = R X + t,  (u, v) = (fx p.x / p.z, fy p.y / p.z)  against observed offsets from the principal point.
// Rotation is updated on the left (R ← exp(δ) R), so the minimiser equals scipy's rotvec
// parametrisation; translation and log-focal are optional. Robust loss by IRLS:
//   soft_l1 (scipy least_squares, f_scale), cauchy / huber / truncated (poselib-style), linear.
import { solveLinear } from "../../linalg";
import { expSO3, type Mat3F64, mul3 } from "./rot3";

export type Loss = "linear" | "soft_l1" | "cauchy" | "huber" | "truncated";

export type PoseLmOptions = {
	/** Refine t (else held). */
	translation: boolean;
	/** Refine a common focal scale log(s) (fx, fy multiplied by s). */
	focal: boolean;
	/** Gaussian prior on log(focal scale): residual (log s − log s0) / sigma, as match.solve_rotation. */
	focalPrior?: { logScale: number; sigma: number };
	loss: Loss;
	/** Loss scale in px (scipy f_scale; poselib loss_scale). */
	scale: number;
	maxIterations?: number;
};

export type PoseState = { R: Mat3F64; t: Float64Array; fx: number; fy: number };

/** Weight ρ'(r²) for IRLS and the robust cost ρ(r²), with c = scale. */
function lossOf(loss: Loss, c: number) {
	const c2 = c * c;
	switch (loss) {
		case "soft_l1":
			return {
				w: (s: number) => 1 / Math.sqrt(1 + s / c2),
				rho: (s: number) => 2 * c2 * (Math.sqrt(1 + s / c2) - 1),
			};
		case "cauchy":
			return {
				w: (s: number) => 1 / (1 + s / c2),
				rho: (s: number) => c2 * Math.log1p(s / c2),
			};
		case "huber":
			return {
				w: (s: number) => (s <= c2 ? 1 : c / Math.sqrt(s)),
				rho: (s: number) => (s <= c2 ? s : 2 * c * Math.sqrt(s) - c2),
			};
		case "truncated":
			return {
				w: (s: number) => (s <= c2 ? 1 : 0),
				rho: (s: number) => Math.min(s, c2),
			};
		default:
			return { w: () => 1, rho: (s: number) => s };
	}
}

/**
 * Refine `state` in place on the correspondences `idx` (all when omitted). X: N×3, obs: N×2 offsets
 * from the principal point (px). Returns the final robust cost.
 */
export function refinePoseLm(
	X: ArrayLike<number>,
	obs: ArrayLike<number>,
	state: PoseState,
	o: PoseLmOptions,
	idx?: ArrayLike<number>,
): number {
	const n = idx ? idx.length : X.length / 3;
	const nr = o.translation ? 6 : 3;
	const np = nr + (o.focal ? 1 : 0);
	const L = lossOf(o.loss, o.scale);
	const prior = o.focal ? o.focalPrior : undefined;
	let logS = 0; // focal scale relative to the start
	const fx0 = state.fx;
	const fy0 = state.fy;

	const cost = (R: ArrayLike<number>, t: ArrayLike<number>, ls: number) => {
		const fx = fx0 * Math.exp(ls);
		const fy = fy0 * Math.exp(ls);
		let c = 0;
		for (let j = 0; j < n; j++) {
			const i = idx ? idx[j] : j;
			const x = X[i * 3];
			const y = X[i * 3 + 1];
			const z = X[i * 3 + 2];
			const px = R[0] * x + R[1] * y + R[2] * z + t[0];
			const py = R[3] * x + R[4] * y + R[5] * z + t[1];
			const pz = Math.max(R[6] * x + R[7] * y + R[8] * z + t[2], 1e-9);
			const ru = (fx * px) / pz - obs[i * 2];
			const rv = (fy * py) / pz - obs[i * 2 + 1];
			c += L.rho(ru * ru) + L.rho(rv * rv);
		}
		if (prior) {
			const r = (Math.log(fx / fx0) + 0 - prior.logScale) / prior.sigma;
			c += L.rho(r * r);
		}
		return c;
	};

	const A = Array.from({ length: np }, () => new Array<number>(np).fill(0));
	const g = new Array<number>(np).fill(0);
	const Jrow = new Float64Array(np * 2);
	let cur = cost(state.R, state.t, 0);
	let lambda = 1e-3;
	const Rn = new Float64Array(9);
	const dR = new Float64Array(9);
	const tn = new Float64Array(3);
	const maxIt = o.maxIterations ?? 50;
	for (let it = 0; it < maxIt; it++) {
		for (let a = 0; a < np; a++) {
			g[a] = 0;
			A[a].fill(0);
		}
		const fx = fx0 * Math.exp(logS);
		const fy = fy0 * Math.exp(logS);
		const R = state.R;
		const t = state.t;
		for (let j = 0; j < n; j++) {
			const i = idx ? idx[j] : j;
			const x = X[i * 3];
			const y = X[i * 3 + 1];
			const z = X[i * 3 + 2];
			const qx = R[0] * x + R[1] * y + R[2] * z; // R X
			const qy = R[3] * x + R[4] * y + R[5] * z;
			const qz = R[6] * x + R[7] * y + R[8] * z;
			const px = qx + t[0];
			const py = qy + t[1];
			const pz = Math.max(qz + t[2], 1e-9);
			const iz = 1 / pz;
			const u = fx * px * iz;
			const v = fy * py * iz;
			const ru = u - obs[i * 2];
			const rv = v - obs[i * 2 + 1];
			// d(u,v)/dp
			const du0 = fx * iz;
			const du2 = -u * iz;
			const dv1 = fy * iz;
			const dv2 = -v * iz;
			// dp/dδ = −[q]× : columns for δx, δy, δz
			// −[q]× = [[0, qz, −qy], [−qz, 0, qx], [qy, −qx, 0]]
			Jrow[0] = du0 * 0 + du2 * qy;
			Jrow[1] = du0 * qz + du2 * -qx;
			Jrow[2] = du0 * -qy;
			Jrow[np] = dv1 * -qz + dv2 * qy;
			Jrow[np + 1] = dv2 * -qx;
			Jrow[np + 2] = dv1 * qx;
			if (o.translation) {
				Jrow[3] = du0;
				Jrow[4] = 0;
				Jrow[5] = du2;
				Jrow[np + 3] = 0;
				Jrow[np + 4] = dv1;
				Jrow[np + 5] = dv2;
			}
			if (o.focal) {
				Jrow[nr] = u;
				Jrow[np + nr] = v;
			}
			const wu = L.w(ru * ru);
			const wv = L.w(rv * rv);
			for (let a = 0; a < np; a++) {
				const ja = Jrow[a];
				const jb = Jrow[np + a];
				g[a] += wu * ja * ru + wv * jb * rv;
				for (let b = a; b < np; b++)
					A[a][b] += wu * ja * Jrow[b] + wv * jb * Jrow[np + b];
			}
		}
		if (prior) {
			const r = (Math.log(fx / fx0) - prior.logScale) / prior.sigma;
			const w = L.w(r * r);
			const j = 1 / prior.sigma;
			g[nr] += w * j * r;
			A[nr][nr] += w * j * j;
		}
		for (let a = 0; a < np; a++) for (let b = 0; b < a; b++) A[a][b] = A[b][a];
		let accepted = false;
		let small = false;
		while (lambda < 1e10) {
			const Ad = A.map((row, a) =>
				row.map((x, b) => (a === b ? x + lambda * Math.max(x, 1e-12) : x)),
			);
			const d = solveLinear(
				Ad,
				g.map((x) => -x),
			);
			if (!d) {
				lambda *= 10;
				continue;
			}
			expSO3(d[0], d[1], d[2], dR);
			mul3(dR, R, Rn);
			tn[0] = t[0] + (o.translation ? d[3] : 0);
			tn[1] = t[1] + (o.translation ? d[4] : 0);
			tn[2] = t[2] + (o.translation ? d[5] : 0);
			const ls = logS + (o.focal ? d[nr] : 0);
			const c2 = cost(Rn, tn, ls);
			if (c2 <= cur) {
				const rel = (cur - c2) / Math.max(cur, 1e-300);
				state.R.set(Rn);
				state.t.set(tn);
				logS = ls;
				cur = c2;
				lambda = Math.max(lambda / 10, 1e-12);
				accepted = true;
				let step = 0;
				for (const x of d) step += x * x;
				small = rel < 1e-12 || step < 1e-20;
				break;
			}
			lambda *= 10;
		}
		if (!accepted || small) break;
	}
	state.fx = fx0 * Math.exp(logS);
	state.fy = fy0 * Math.exp(logS);
	return cur;
}
