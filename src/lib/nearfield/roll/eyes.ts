// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Relative EYE refinement for a roll spot (Step Inside P2). Pure TS (no DOM); offline twin + study:
// tools/nearfield/eyes/refine_eyes.py, results tools/nearfield/eyes/REPORT.txt.
//
// Rigi rotations come from the far skyline and are good to ~1-2°, but GPS eyes are off by metres to tens of
// metres, so the near fields of the photos of a spot misregister. Per overlapping pair (matches from a
// feature matcher, e.g. ALIKED+LightGlue offline), pairTranslation() estimates the metric eye difference
// t = eyeB − eyeA with the rotations kept at Rigi's poses: each match is lifted with the LARGER of the two
// photos' DEM-anchored depths (a broken near-end anchor can only shrink depth, so this never invents parallax)
// and reprojected into the other photo; a relative rotation correction of B and focal scales of A and B are
// fitted as NUISANCE parameters only (far matches pin them; without them Rigi's ~2° relative rotation error
// and an ultrawide's ~5 % focal error are read as translation). solveEyeOffsets() then combines the pairs:
// whitened pair residuals, a weak prior |offset_xy| ~ 15 m, the component's mean xy kept at the GPS mean,
// and eye z = DEM(x, y) + 1.6 m ± 2 m.
//
// Evidence is thin (one usable pair, IMG_7059/IMG_7063): see REPORT.txt. Default off (REFINE_EYES_DEFAULT).
import type { Vec3 } from "#/lib/ontology/core/geometry";
import type { Pose } from "../../camera";
import {
	rodrigues as linalgRodrigues,
	solveLinear as linalgSolve,
	mul3,
	transpose3,
} from "../../linalg";
import { camToEnuMatrix } from "../lift";

export type { Vec3 };

/** Off by default: one usable pair of evidence, near-field coverage still tiny after refinement. */
export const REFINE_EYES_DEFAULT = false;

/** One photo as the solver sees it: pose + eye in the shared ENU frame, pixel grid of its matches. */
export type EyeCam = {
	id: string;
	pose: Pose;
	eye: Vec3;
	/** Pixel grid the match coordinates live on. */
	width: number;
	height: number;
};

/**
 * Matches of a pair: flat [x0, y0, x1, y1, ...] continuous pixel coordinates (pixel (i, j) centre at
 * (i + 0.5, j + 0.5)), plus each match's DEM-anchored ray length (m) in A and in B (NaN / ≤ 0 = none).
 * People and other movers must already be removed.
 */
export type PairMatches = {
	ka: ArrayLike<number>;
	kb: ArrayLike<number>;
	depthA: ArrayLike<number>;
	depthB: ArrayLike<number>;
};

export type PairCalib = "none" | "rot" | "rot+f";

export type EyePairOpts = {
	/** Nuisance parameters fitted with t. Default "rot+f". */
	calib?: PairCalib;
	/** Match noise (px) for the information matrix. Default 1.5. */
	sigmaPx?: number;
	/** soft-L1 scale (px). Default 2. */
	lossPx?: number;
	/** Prior sigma of the focal scales. Default 0.03. */
	focalPrior?: number;
	/** "Near" inlier: lifted depth below this (m). Default 60. */
	nearM?: number;
};

export type EyePair = {
	a: string;
	b: string;
	ok: boolean;
	/** eyeB − eyeA (m, ENU). */
	t: Vec3;
	/** Information matrix of t (3×3 row-major, 1/m²), nuisances marginalised. */
	info: number[];
	baselineM: number;
	used: number;
	inliers: number;
	/** Inliers lifted from < nearM: the ones that carry translation. */
	nearInliers: number;
	medPx: number;
	relRotCorrDeg: number;
	focalScale: [number, number];
	gpsDist: number;
	/** Set by eyePairGate / dropInconsistent. */
	gate?: boolean;
	why?: string;
};

// ---- small linear algebra ----
const mat3mul = (a: number[], b: number[]): number[] => mul3(a, b);
const tr3 = (a: number[]): number[] => transpose3(a);

/** Rotation matrix of a rotation vector (Rodrigues), row-major. */
export const rodrigues = (w: ArrayLike<number>): number[] => linalgRodrigues(w);

/** Solve A x = b (A n×n row-major, symmetric positive definite-ish) by Gaussian elimination with pivoting. */
export function solveLinear(
	A: number[],
	b: number[],
	n: number,
): number[] | null {
	const rows = Array.from({ length: n }, (_, r) => A.slice(r * n, r * n + n));
	return linalgSolve(rows, b);
}

/** Inverse of a small square matrix (null when singular). */
export function invert(A: number[], n: number): number[] | null {
	const cols: number[][] = [];
	for (let j = 0; j < n; j++) {
		const e = new Array(n).fill(0);
		e[j] = 1;
		const c = solveLinear(A, e, n);
		if (!c) return null;
		cols.push(c);
	}
	return Array.from(
		{ length: n * n },
		(_, k) => cols[k % n][Math.floor(k / n)],
	);
}

/** Lower Cholesky factor of a symmetric positive definite 3×3 (row-major), null if not SPD. */
function chol3(A: number[]): number[] | null {
	const L = new Array(9).fill(0);
	for (let i = 0; i < 3; i++)
		for (let j = 0; j <= i; j++) {
			let s = A[3 * i + j];
			for (let k = 0; k < j; k++) s -= L[3 * i + k] * L[3 * j + k];
			if (i === j) {
				if (!(s > 0)) return null;
				L[3 * i + i] = Math.sqrt(s);
			} else L[3 * i + j] = s / L[3 * j + j];
		}
	return L;
}

/**
 * Robust (soft-L1, per residual element, as scipy least_squares) Levenberg–Marquardt with a forward-difference
 * Jacobian; fScale = Infinity is plain least squares. Returns the solution, the final residuals and JᵀWJ
 * (W = the loss's IRLS weights).
 */
export function robustLM(
	fn: (p: number[]) => number[],
	p0: number[],
	fScale: number,
	iters = 60,
): { p: number[]; r: number[]; JtWJ: number[]; cost: number } {
	const n = p0.length;
	let p = p0.slice();
	let r = fn(p);
	const robust = Number.isFinite(fScale);
	const costOf = (rr: number[]) => {
		let c = 0;
		for (const v of rr) {
			if (!robust) {
				c += 0.5 * v * v;
				continue;
			}
			const z = (v / fScale) ** 2;
			c += fScale * fScale * (Math.sqrt(1 + z) - 1);
		}
		return c;
	};
	let cost = costOf(r);
	let lambda = 1e-3;
	let JtWJ = new Array(n * n).fill(0);
	for (let it = 0; it < iters; it++) {
		const m = r.length;
		const J: number[][] = [];
		for (let k = 0; k < n; k++) {
			const h = 1e-6 * Math.max(1, Math.abs(p[k]));
			const q = p.slice();
			q[k] += h;
			const rq = fn(q);
			J.push(rq.map((v, i) => (v - r[i]) / h));
		}
		const w = r.map((v) => (robust ? 1 / Math.sqrt(1 + (v / fScale) ** 2) : 1));
		JtWJ = new Array(n * n).fill(0);
		const g = new Array(n).fill(0);
		for (let a = 0; a < n; a++) {
			for (let i = 0; i < m; i++) g[a] += J[a][i] * w[i] * r[i];
			for (let b = a; b < n; b++) {
				let s = 0;
				for (let i = 0; i < m; i++) s += J[a][i] * w[i] * J[b][i];
				JtWJ[a * n + b] = s;
				JtWJ[b * n + a] = s;
			}
		}
		let improved = false;
		for (let tries = 0; tries < 10; tries++) {
			const A = JtWJ.slice();
			for (let a = 0; a < n; a++)
				A[a * n + a] += lambda * (JtWJ[a * n + a] + 1e-9);
			const d = solveLinear(
				A,
				g.map((v) => -v),
				n,
			);
			if (!d) {
				lambda *= 10;
				continue;
			}
			const q = p.map((v, k) => v + d[k]);
			const rq = fn(q);
			const cq = costOf(rq);
			if (cq < cost) {
				const rel = (cost - cq) / Math.max(cost, 1e-12);
				p = q;
				r = rq;
				cost = cq;
				lambda = Math.max(lambda / 3, 1e-9);
				improved = rel > 1e-10;
				break;
			}
			lambda *= 10;
		}
		if (!improved) break;
	}
	return { p, r, JtWJ, cost };
}

/**
 * Metric eye difference t = eyeB − eyeA of one photo pair from matches + anchored depths, rotations kept at
 * the poses (see the file header). ok = false when fewer than 20 matches have a depth.
 */
export function pairTranslation(
	A: EyeCam,
	B: EyeCam,
	m: PairMatches,
	opts: EyePairOpts = {},
): EyePair {
	const calib = opts.calib ?? "rot+f";
	const sigma = opts.sigmaPx ?? 1.5;
	const fScale = opts.lossPx ?? 2;
	const fPrior = opts.focalPrior ?? 0.03;
	const nearM = opts.nearM ?? 60;
	const gps: Vec3 = [0, 1, 2].map((k) => B.eye[k] - A.eye[k]) as Vec3;
	const empty: EyePair = {
		a: A.id,
		b: B.id,
		ok: false,
		t: [0, 0, 0],
		info: new Array(9).fill(0),
		baselineM: 0,
		used: 0,
		inliers: 0,
		nearInliers: 0,
		medPx: Number.NaN,
		relRotCorrDeg: 0,
		focalScale: [1, 1],
		gpsDist: Math.hypot(...gps),
	};
	// usable matches: a depth in A or B; lift from the larger one
	const idx: number[] = [];
	const fromA: boolean[] = [];
	const dep: number[] = [];
	const N = Math.min(m.ka.length, m.kb.length) >> 1;
	for (let i = 0; i < N; i++) {
		const a = m.depthA[i] > 0 ? m.depthA[i] : -1;
		const b = m.depthB[i] > 0 ? m.depthB[i] : -1;
		if (a <= 0 && b <= 0) continue;
		idx.push(i);
		fromA.push(a >= b);
		dep.push(Math.max(a, b));
	}
	empty.used = idx.length;
	if (idx.length < 20) return empty;
	const MA = camToEnuMatrix(A.pose); // cam -> ENU (= Rᵀ, R = world -> cam)
	const MB = camToEnuMatrix(B.pose);
	const RA = tr3(MA);
	const RB0 = tr3(MB);
	const tanA = Math.tan((A.pose.vfov * Math.PI) / 360);
	const tanB = Math.tan((B.pose.vfov * Math.PI) / 360);
	const fA = A.height / 2 / tanA;
	const fB = B.height / 2 / tanB;
	const nf = calib === "none" ? 0 : calib === "rot" ? 3 : 5;
	const unpack = (p: number[]) => ({
		t: [p[0], p[1], p[2]],
		w: nf >= 3 ? [p[3], p[4], p[5]] : [0, 0, 0],
		sA: nf === 5 ? p[6] : 1,
		sB: nf === 5 ? p[7] : 1,
	});
	const bearing = (x: number, y: number, W: number, H: number, f: number) => {
		const cx = (x - W / 2) / f;
		const cy = (y - H / 2) / f;
		const n = Math.hypot(cx, cy, 1);
		return [cx / n, cy / n, 1 / n];
	};
	const mv = (M: number[], v: number[]) => [
		M[0] * v[0] + M[1] * v[1] + M[2] * v[2],
		M[3] * v[0] + M[4] * v[1] + M[5] * v[2],
		M[6] * v[0] + M[7] * v[1] + M[8] * v[2],
	];
	const resid = (p: number[]): number[] => {
		const { t, w, sA, sB } = unpack(p);
		const RB = mat3mul(rodrigues(w), RB0);
		const RBt = tr3(RB);
		const out: number[] = [];
		for (let k = 0; k < idx.length; k++) {
			const i = idx[k];
			const d = dep[k];
			let v: number[];
			let f: number;
			let W: number;
			let H: number;
			let ox: number;
			let oy: number;
			if (fromA[k]) {
				const c = bearing(
					m.ka[2 * i],
					m.ka[2 * i + 1],
					A.width,
					A.height,
					fA * sA,
				);
				const aw = mv(MA, c);
				v = mv(RB, [d * aw[0] - t[0], d * aw[1] - t[1], d * aw[2] - t[2]]);
				f = fB * sB;
				W = B.width;
				H = B.height;
				ox = m.kb[2 * i];
				oy = m.kb[2 * i + 1];
			} else {
				const c = bearing(
					m.kb[2 * i],
					m.kb[2 * i + 1],
					B.width,
					B.height,
					fB * sB,
				);
				const bw = mv(RBt, c);
				v = mv(RA, [t[0] + d * bw[0], t[1] + d * bw[1], t[2] + d * bw[2]]);
				f = fA * sA;
				W = A.width;
				H = A.height;
				ox = m.ka[2 * i];
				oy = m.ka[2 * i + 1];
			}
			if (!(v[2] > 1e-6)) {
				out.push(200, 200);
				continue;
			}
			out.push(W / 2 + (f * v[0]) / v[2] - ox, H / 2 + (f * v[1]) / v[2] - oy);
		}
		if (nf === 5)
			out.push(((sA - 1) / fPrior) * sigma, ((sB - 1) / fPrior) * sigma);
		// a very weak pull of t toward 0 (100 m) keeps an unobservable pair finite
		out.push((t[0] / 100) * sigma, (t[1] / 100) * sigma, (t[2] / 100) * sigma);
		return out;
	};
	const extra = nf === 5 ? [1, 1] : [];
	let best: ReturnType<typeof robustLM> | null = null;
	for (const t0 of [[0, 0, 0], gps]) {
		const p0 = [...t0, ...(nf >= 3 ? [0, 0, 0] : []), ...extra];
		const s = robustLM(resid, p0, fScale);
		if (!best || s.cost < best.cost) best = s;
	}
	if (!best) return empty;
	const { t, w, sA, sB } = unpack(best.p);
	const n = 3 + nf;
	const H = best.JtWJ.map((v) => v / (sigma * sigma));
	// information on t: Schur complement over the nuisance block
	let info = [0, 1, 2].flatMap((i) => [0, 1, 2].map((j) => H[i * n + j]));
	if (nf) {
		const Hnn = Array.from(
			{ length: nf * nf },
			(_, k) => H[(3 + Math.floor(k / nf)) * n + 3 + (k % nf)],
		);
		const inv = invert(Hnn, nf);
		if (inv) {
			const Htn = (i: number, a: number) => H[i * n + 3 + a];
			info = info.map((v, k) => {
				const i = Math.floor(k / 3);
				const j = k % 3;
				let s = 0;
				for (let a = 0; a < nf; a++)
					for (let b = 0; b < nf; b++)
						s += Htn(i, a) * inv[a * nf + b] * Htn(j, b);
				return v - s;
			});
		}
	}
	const errs: number[] = [];
	let inliers = 0;
	let nearInliers = 0;
	for (let k = 0; k < idx.length; k++) {
		const e = Math.hypot(best.r[2 * k], best.r[2 * k + 1]);
		if (e < 3 * fScale) {
			inliers++;
			errs.push(e);
			if (dep[k] < nearM) nearInliers++;
		}
	}
	errs.sort((x, y) => x - y);
	return {
		...empty,
		ok: true,
		t: t as Vec3,
		info,
		baselineM: Math.hypot(t[0], t[1], t[2]),
		inliers,
		nearInliers,
		medPx: errs.length ? errs[errs.length >> 1] : Number.NaN,
		relRotCorrDeg: (Math.hypot(w[0], w[1], w[2]) * 180) / Math.PI,
		focalScale: [sA, sB],
	};
}

/** Pair gate (tools/nearfield/eyes: ≥ 30 inliers, median ≤ 2.5 px, ≥ 20 near inliers). */
export function eyePairGate(
	p: EyePair,
	o: { minInliers?: number; maxMedPx?: number; minNear?: number } = {},
): boolean {
	const why = !p.ok
		? "no solve"
		: p.inliers < (o.minInliers ?? 30)
			? "few inliers"
			: !(p.medPx <= (o.maxMedPx ?? 2.5))
				? "residual"
				: p.nearInliers < (o.minNear ?? 20)
					? "no near evidence"
					: undefined;
	p.gate = !why;
	p.why = why;
	return p.gate;
}

/**
 * Triplet closure gate: while a triangle of gated pairs has |t_AB + t_BC − t_AC| > max(tolM, tolRel·perimeter),
 * ungate its pair with the least near evidence.
 */
export function dropInconsistent(
	pairs: EyePair[],
	tolM = 2,
	tolRel = 0.2,
): void {
	for (;;) {
		const g = new Map(
			pairs.filter((p) => p.gate).map((p) => [`${p.a}|${p.b}`, p]),
		);
		const ids = [...new Set(pairs.flatMap((p) => [p.a, p.b]))];
		let bad: EyePair | null = null;
		outer: for (let i = 0; i < ids.length; i++)
			for (let j = i + 1; j < ids.length; j++)
				for (let k = j + 1; k < ids.length; k++) {
					const ab = g.get(`${ids[i]}|${ids[j]}`);
					const bc = g.get(`${ids[j]}|${ids[k]}`);
					const ac = g.get(`${ids[i]}|${ids[k]}`);
					if (!ab || !bc || !ac) continue;
					const r = [0, 1, 2].map((a) => ab.t[a] + bc.t[a] - ac.t[a]);
					const per = ab.baselineM + bc.baselineM + ac.baselineM;
					if (Math.hypot(r[0], r[1], r[2]) > Math.max(tolM, tolRel * per)) {
						bad = [ab, bc, ac].reduce((x, y) =>
							y.nearInliers < x.nearInliers ||
							(y.nearInliers === x.nearInliers && y.inliers < x.inliers)
								? y
								: x,
						);
						break outer;
					}
				}
		if (!bad) return;
		bad.gate = false;
		bad.why = "triplet closure";
	}
}

export type EyeSolveOpts = {
	/** Prior sigma on each eye's horizontal offset (m). Default 15. */
	priorM?: number;
	/** Eye height above the DEM (m). Default 1.6 (the app's eye rule). */
	eyeHeight?: number;
	/** Sigma of eye z − (DEM + eyeHeight) (m). Default 2. */
	zSigmaM?: number;
};

export type EyeSolve = {
	/** Refined eyes per id (every input id; ids without a gated pair keep their xy). */
	eyes: Record<string, Vec3>;
	offsets: Record<string, Vec3>;
	/** Connected components of the gated pair graph (only these share a mean constraint). */
	components: string[][];
	pairsUsed: string[];
};

/**
 * Eye offsets from gated pairs: whitened pair residuals (cov = info⁻¹ + (0.25|t|)² + 0.3² m²), a weak xy
 * prior, each component's mean xy fixed at its GPS mean, and eye z = heightAt(x, y) + eyeHeight ± zSigma.
 * `heightAt` returns the DEM surface z in the SAME frame (null = unknown: that eye's z term is dropped).
 */
export function solveEyeOffsets(
	eyes: Record<string, Vec3>,
	pairs: EyePair[],
	heightAt: (e: number, n: number) => number | null,
	opts: EyeSolveOpts = {},
): EyeSolve {
	const ids = Object.keys(eyes);
	const n = ids.length;
	const at = new Map(ids.map((id, k) => [id, k]));
	const prior = opts.priorM ?? 15;
	const eh = opts.eyeHeight ?? 1.6;
	const zs = opts.zSigmaM ?? 2;
	const good = pairs.filter((p) => p.gate && at.has(p.a) && at.has(p.b));
	const whit: number[][] = [];
	for (const p of good) {
		const cov0 = invert(
			p.info.map((v, k) => v + (k % 4 === 0 ? 1e-9 : 0)),
			3,
		) ?? [1e6, 0, 0, 0, 1e6, 0, 0, 0, 1e6];
		const add = (0.25 * p.baselineM) ** 2 + 0.09;
		const cov = cov0.map((v, k) => v + (k % 4 === 0 ? add : 0));
		const icov = invert(cov, 3);
		const L = icov ? chol3(icov) : null;
		// whitened residual = Lᵀ x
		whit.push(L ? tr3(L) : [1 / 30, 0, 0, 0, 1 / 30, 0, 0, 0, 1 / 30]);
	}
	// components
	const parent = ids.map((_, k) => k);
	const find = (x: number): number => (parent[x] === x ? x : find(parent[x]));
	for (const p of good)
		parent[find(at.get(p.a) as number)] = find(at.get(p.b) as number);
	const comps = new Map<number, number[]>();
	for (let k = 0; k < n; k++) {
		const r = find(k);
		comps.set(r, [...(comps.get(r) ?? []), k]);
	}
	const E0 = ids.map((id) => eyes[id]);
	const resid = (x: number[]): number[] => {
		const r: number[] = [];
		good.forEach((p, q) => {
			const i = at.get(p.a) as number;
			const j = at.get(p.b) as number;
			const v = [0, 1, 2].map(
				(a) => E0[j][a] + x[3 * j + a] - (E0[i][a] + x[3 * i + a]) - p.t[a],
			);
			const L = whit[q];
			r.push(
				L[0] * v[0] + L[1] * v[1] + L[2] * v[2],
				L[3] * v[0] + L[4] * v[1] + L[5] * v[2],
				L[6] * v[0] + L[7] * v[1] + L[8] * v[2],
			);
		});
		for (let k = 0; k < n; k++) {
			r.push(x[3 * k] / prior, x[3 * k + 1] / prior);
			const e = E0[k][0] + x[3 * k];
			const nn = E0[k][1] + x[3 * k + 1];
			const h = heightAt(e, nn);
			r.push(h == null ? 0 : (E0[k][2] + x[3 * k + 2] - (h + eh)) / zs);
		}
		for (const ks of comps.values()) {
			if (ks.length < 2) continue;
			let mx = 0;
			let my = 0;
			for (const k of ks) {
				mx += x[3 * k] / ks.length;
				my += x[3 * k + 1] / ks.length;
			}
			r.push(mx / 0.05, my / 0.05);
		}
		return r;
	};
	// plain least squares (only the DEM term is non-linear)
	const sol = robustLM(
		resid,
		new Array(3 * n).fill(0),
		Number.POSITIVE_INFINITY,
		30,
	);
	const out: Record<string, Vec3> = {};
	const off: Record<string, Vec3> = {};
	ids.forEach((id, k) => {
		off[id] = [sol.p[3 * k], sol.p[3 * k + 1], sol.p[3 * k + 2]];
		out[id] = [0, 1, 2].map((a) => E0[k][a] + sol.p[3 * k + a]) as Vec3;
	});
	return {
		eyes: out,
		offsets: off,
		components: [...comps.values()].map((ks) => ks.map((k) => ids[k])),
		pairsUsed: good.map((p) => `${p.a}-${p.b}`),
	};
}

/**
 * The whole step for a spot: gate the measured pairs, drop triplet-inconsistent ones, solve the offsets.
 * Returns null when no pair survives (nothing to refine: keep the GPS eyes).
 */
export function refineEyes(
	eyes: Record<string, Vec3>,
	pairs: EyePair[],
	heightAt: (e: number, n: number) => number | null,
	opts: EyeSolveOpts & { gate?: Parameters<typeof eyePairGate>[1] } = {},
): (EyeSolve & { pairs: EyePair[] }) | null {
	for (const p of pairs) eyePairGate(p, opts.gate);
	dropInconsistent(pairs);
	if (!pairs.some((p) => p.gate)) return null;
	return { ...solveEyeOffsets(eyes, pairs, heightAt, opts), pairs };
}
