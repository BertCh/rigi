// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Joint skyline + render-match pose solve with the a-priori HIGH/LOW rule (port of
// tools/matcher/fusion.py and tools/matcher/server/fuse.py; reports/fusion.md). Same model, constants
// and rule; nothing re-tuned:
//   params  yaw, pitch, roll (deg), log f; camera centre fixed at the eye.
//   (a) skyline term: per edge-map column the topmost projected DEM-horizon crossing, associated
//       ICP-style with the best row of the app's skyline score S within ±win rows (WINS shrink per
//       outer iteration); residual = projected row − associated row.
//   (b) match term: reprojection error of matches lifted through the renders' xyz, gated per
//       outer iteration (GATES).
//   Huber IRLS on r/σ, each term divided by sqrt(N_t), weak 5 % focal prior.
// HIGH iff cueAgreeDeg < 1 ∧ skylineMedPx < 4 ∧ matchSupport ≥ 0.3.

import type { Pose } from "#/lib/camera";
import {
	focalPx,
	median,
	plainPose,
	poseToR,
	pyMod,
	rotAngle,
	roundOrNull,
	rToPose,
	vfovFromF,
} from "./geometry";
import { leastSquares } from "./lm";
import { solveRotation } from "./rotation";

export const HUBER_K = 1.345;
export const SIGMA_FLOOR = { sky: 1.0, match: 1.0 };
export const WINS = [24, 12, 6, 6] as const;
export const GATES = [30.0, 15.0, 8.0, 8.0] as const;
export const SKY_MIN = 0.15;
export const FOCAL_SIGMA = 0.05;
export const SUPPORT_PX = 6.0;
export const TRUNC = 3.0;
export const HIGH_CONF = 0.9;
export const LOW_CONF = 0.2;

/** The app's skyline evidence as the fused solve uses it (fusion.skyline_from_arrays). */
export type SkylineCue = {
	w: number;
	h: number;
	/** per-pixel skyline score, the integrand of align.ts scorePose (fine variant) */
	S: Float64Array;
	fg: Float32Array;
	/** DEM horizon directions in azimuth order (N×3) */
	dirs: Float64Array;
	app: SkylineApp | null;
};

export type SkylineApp = {
	prior?: Pose;
	/** the skyline pose after the app's acceptance rule */
	pose: Pose;
	confidence?: number | null;
	accepted?: string;
};

/** Lifted correspondences: photo px (N×2, render resolution W×H) ↔ ENU points (N×3). */
export type Corr = { x2d: Float64Array; X: Float64Array; W: number; H: number };

export function skylineFromArrays(
	w: number,
	h: number,
	fine: ArrayLike<number>,
	fg: ArrayLike<number>,
	sky: ArrayLike<number>,
	dirs: ArrayLike<number>,
	app: SkylineApp | null,
): SkylineCue {
	const band = Math.max(2, Math.round(h * 0.035));
	const gap = Math.max(1, Math.round(h * 0.006));
	// float32 inputs (np.asarray(..., float32)); numpy's cumsum of float32 accumulates in float32
	const cum = new Float64Array((h + 1) * w);
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++)
			cum[(y + 1) * w + x] = Math.fround(
				cum[y * w + x] + Math.fround(sky[y * w + x]),
			);
	const S = new Float64Array(w * h);
	const clip = (v: number) => Math.min(Math.max(v, 0), h);
	for (let y = 0; y < h; y++) {
		const a0 = clip(y - gap - band);
		const a1 = clip(y - gap);
		const b0 = clip(y + gap);
		const b1 = clip(y + gap + band);
		for (let x = 0; x < w; x++) {
			const above =
				a1 > a0
					? (cum[a1 * w + x] - cum[a0 * w + x]) / Math.max(a1 - a0, 1)
					: 0.5;
			const below =
				b1 > b0
					? (cum[b1 * w + x] - cum[b0 * w + x]) / Math.max(b1 - b0, 1)
					: 0.5;
			const i = y * w + x;
			S[i] =
				(0.5 * Math.fround(fine[i]) + (above - below)) *
				(1 - Math.fround(fg[i]));
		}
	}
	return {
		w,
		h,
		S,
		fg: Float32Array.from(fg),
		dirs: Float64Array.from(dirs, (v) => Math.fround(v)),
		app,
	};
}

// ---------- projection ----------

export const xFromPose = (pose: Pose, H: number) =>
	Float64Array.of(
		pose.yaw,
		pose.pitch,
		pose.roll,
		Math.log(focalPx(pose.vfov, H)),
	);

export const poseFromX = (x: ArrayLike<number>, H: number): Pose => ({
	yaw: pyMod(x[0], 360),
	pitch: x[1],
	roll: x[2],
	vfov: vfovFromF(Math.exp(x[3]), H),
});

/** project_dirs: (u, v, z) of unit directions D (N×3) under params x at W×H. */
export function projectDirs(
	x: ArrayLike<number>,
	D: Float64Array,
	W: number,
	H: number,
) {
	const R = poseToR({ yaw: x[0], pitch: x[1], roll: x[2] });
	const f = Math.exp(x[3]);
	const n = D.length / 3;
	const u = new Float64Array(n);
	const v = new Float64Array(n);
	const z = new Float64Array(n);
	for (let i = 0; i < n; i++) {
		const a = D[i * 3];
		const b = D[i * 3 + 1];
		const c = D[i * 3 + 2];
		const c0 = R[0] * a + R[1] * b + R[2] * c;
		const c1 = R[3] * a + R[4] * b + R[5] * c;
		const c2 = R[6] * a + R[7] * b + R[8] * c;
		const zs = c2 > 1e-6 ? c2 : 1e-6;
		u[i] = W / 2 + (f * c0) / zs;
		v[i] = H / 2 + (f * c1) / zs;
		z[i] = c2;
	}
	return { u, v, z };
}

/** np.interp for increasing xp. */
function interp(x: number, xp: number[], fp: number[]) {
	let lo = 0;
	let hi = xp.length - 1;
	if (x <= xp[0]) return fp[0];
	if (x >= xp[hi]) return fp[hi];
	while (hi - lo > 1) {
		const mid = (lo + hi) >> 1;
		if (xp[mid] <= x) lo = mid;
		else hi = mid;
	}
	const t = (x - xp[lo]) / (xp[hi] - xp[lo]);
	return fp[lo] + t * (fp[hi] - fp[lo]);
}

/**
 * sky_curve: rendered skyline row (render px) at columns `cu` (render px), the topmost crossing of the
 * projected DEM-horizon polyline; Infinity where none.
 */
export function skyCurve(
	x: ArrayLike<number>,
	sk: SkylineCue,
	W: number,
	H: number,
	cu: ArrayLike<number>,
): Float64Array {
	const { u, v, z } = projectDirs(x, sk.dirs, W, H);
	const ns = u.length - 1;
	const idx: number[] = [];
	for (let i = 0; i < ns; i++) {
		const u0 = u[i];
		const u1 = u[i + 1];
		if (
			z[i] > 0.1 &&
			z[i + 1] > 0.1 &&
			Math.abs(u1 - u0) < 0.05 * W &&
			Math.max(u0, u1) > -0.05 * W &&
			Math.min(u0, u1) < 1.05 * W
		)
			idx.push(i);
	}
	const out = new Float64Array(cu.length).fill(Number.POSITIVE_INFINITY);
	// fast path (identical result): one contiguous chain with u strictly increasing
	if (idx.length >= 2) {
		let chain = true;
		for (let k = 1; k < idx.length; k++)
			if (idx[k] - idx[k - 1] !== 1) {
				chain = false;
				break;
			}
		if (chain) {
			const uu = idx.map((i) => u[i]);
			const vv = idx.map((i) => v[i]);
			uu.push(u[idx[idx.length - 1] + 1]);
			vv.push(v[idx[idx.length - 1] + 1]);
			let inc = true;
			for (let k = 1; k < uu.length; k++)
				if (!(uu[k] - uu[k - 1] > 0)) {
					inc = false;
					break;
				}
			if (inc) {
				for (let j = 0; j < cu.length; j++) {
					const c = cu[j];
					out[j] =
						c < uu[0] || c >= uu[uu.length - 1]
							? Number.POSITIVE_INFINITY
							: interp(c, uu, vv);
				}
				return out;
			}
		}
	}
	for (const i of idx) {
		const u0 = u[i];
		const u1 = u[i + 1];
		const v0 = v[i];
		const v1 = v[i + 1];
		const lo = Math.min(u0, u1);
		const hi = Math.max(u0, u1);
		const den = u1 - u0 === 0 ? 1e-9 : u1 - u0;
		for (let j = 0; j < cu.length; j++) {
			const c = cu[j];
			if (lo <= c && c < hi) {
				const vv = v0 + ((c - u0) / den) * (v1 - v0);
				if (vv < out[j]) out[j] = vv;
			}
		}
	}
	return out;
}

/** sky_associate: (column centres in render px, target rows, columns in view). */
export function skyAssociate(
	x: ArrayLike<number>,
	sk: SkylineCue,
	W: number,
	H: number,
	win: number,
): { cu: Float64Array; tgt: Float64Array; ncol: number } {
	const { w, h } = sk;
	const cuAll = Float64Array.from({ length: w }, (_, c) => ((c + 0.5) / w) * W);
	const rows = skyCurve(x, sk, W, H, cuAll);
	const keep: number[] = [];
	const tgt: number[] = [];
	let ncol = 0;
	for (let cx = 0; cx < w; cx++) {
		const r = rows[cx];
		if (!(Number.isFinite(r) && r > 0.01 * H && r < 0.99 * H)) continue;
		ncol++;
		const y0 = Math.trunc((r / H) * h);
		if (sk.fg[Math.min(Math.max(y0, 0), h - 1) * w + cx] > 0.3) continue;
		const lo = Math.max(0, y0 - win);
		const hi = Math.min(h - 1, y0 + win);
		let k = 0;
		let best = Number.NEGATIVE_INFINITY;
		for (let y = lo; y <= hi; y++) {
			const s = sk.S[y * w + cx];
			if (s > best) {
				best = s;
				k = y - lo;
			}
		}
		if (best < SKY_MIN) continue;
		const len = hi - lo + 1;
		let off = 0;
		if (k > 0 && k < len - 1) {
			const sm = sk.S[(lo + k - 1) * w + cx];
			const s0 = sk.S[(lo + k) * w + cx];
			const sp = sk.S[(lo + k + 1) * w + cx];
			const den = sm - 2 * s0 + sp;
			if (den < 0) off = (0.5 * (sm - sp)) / den;
		}
		keep.push(cuAll[cx]);
		tgt.push(((lo + k + off + 0.5) / h) * H);
	}
	return { cu: Float64Array.from(keep), tgt: Float64Array.from(tgt), ncol };
}

export function skyResid(
	x: ArrayLike<number>,
	sk: SkylineCue,
	W: number,
	H: number,
	cu: Float64Array,
	tgt: Float64Array,
): Float64Array {
	const c = skyCurve(x, sk, W, H, cu);
	for (let i = 0; i < c.length; i++) {
		const r = c[i] - tgt[i];
		c[i] = Number.isFinite(r) ? r : 50.0;
	}
	return c;
}

/** match_resid: N×2 reprojection residuals (1e4 behind the camera). `idx` selects rows. */
export function matchResid(
	x: ArrayLike<number>,
	c: Corr,
	eye: ArrayLike<number>,
	idx?: ArrayLike<number>,
): Float64Array {
	const n = idx ? idx.length : c.x2d.length / 2;
	const D = new Float64Array(n * 3);
	for (let k = 0; k < n; k++) {
		const i = idx ? idx[k] : k;
		const a = c.X[i * 3] - eye[0];
		const b = c.X[i * 3 + 1] - eye[1];
		const d = c.X[i * 3 + 2] - eye[2];
		const l = Math.hypot(a, b, d);
		D[k * 3] = a / l;
		D[k * 3 + 1] = b / l;
		D[k * 3 + 2] = d / l;
	}
	const { u, v, z } = projectDirs(x, D, c.W, c.H);
	const r = new Float64Array(n * 2);
	for (let k = 0; k < n; k++) {
		const i = idx ? idx[k] : k;
		if (z[k] <= 0) {
			r[k * 2] = 1e4;
			r[k * 2 + 1] = 1e4;
		} else {
			r[k * 2] = u[k] - c.x2d[i * 2];
			r[k * 2 + 1] = v[k] - c.x2d[i * 2 + 1];
		}
	}
	return r;
}

export function robustSigma(r: ArrayLike<number>, floor: number): number {
	if (!r.length) return floor;
	const m = median(r);
	const dev = Float64Array.from(r, (v) => Math.abs(v - m));
	return Math.max(floor, 1.4826 * median(dev));
}

export function huberSqrtW(rn: ArrayLike<number>): Float64Array {
	return Float64Array.from(rn, (v) => {
		const a = Math.abs(v);
		return Math.sqrt(a <= HUBER_K ? 1 : HUBER_K / Math.max(a, 1e-12));
	});
}

export type Sigma = { sky?: number; match?: number };
export type SolveInfo = {
	sky?: { n: number; cols: number; sigma: number };
	match?: { n: number; sigma: number };
	cost?: number;
};

/** fusion.solve: outer loop re-associates / re-gates, inner LM. null when no term has evidence. */
export function solveFusion(
	x0: ArrayLike<number>,
	W: number,
	H: number,
	f0: number,
	o: {
		sk?: SkylineCue | null;
		c?: Corr | null;
		eye?: ArrayLike<number>;
		lam?: number;
		useSky?: boolean;
		useMatch?: boolean;
		iters?: number;
		sigma?: Sigma;
	},
): [Float64Array, SolveInfo] | null {
	const sigma: Sigma = { ...(o.sigma ?? {}) };
	const lam = o.lam ?? 1.0;
	const useSky = o.useSky ?? true;
	const useMatch = o.useMatch ?? true;
	const iters = o.iters ?? WINS.length;
	const { sk, c } = o;
	const eye = o.eye ?? [0, 0, 0];
	let x: Float64Array = Float64Array.from(x0);
	const info: SolveInfo = {};
	for (let it = 0; it < iters; it++) {
		type Part =
			| {
					name: "sky";
					cu: Float64Array;
					tgt: Float64Array;
					s: number;
					w: Float64Array;
			  }
			| { name: "match"; idx: number[]; s: number; w: Float64Array };
		const parts: Part[] = [];
		if (useSky && sk) {
			const { cu, tgt, ncol } = skyAssociate(x, sk, W, H, WINS[it]);
			if (cu.length >= 10) {
				const r = skyResid(x, sk, W, H, cu, tgt);
				const s = sigma.sky || robustSigma(r, SIGMA_FLOOR.sky);
				parts.push({
					name: "sky",
					cu,
					tgt,
					s,
					w: huberSqrtW(r.map((v) => v / s)),
				});
				info.sky = { n: cu.length, cols: ncol, sigma: s };
			}
		}
		if (useMatch && c && c.x2d.length) {
			const r = matchResid(x, c, eye);
			const n = r.length / 2;
			const idx: number[] = [];
			for (let i = 0; i < n; i++)
				if (Math.hypot(r[i * 2], r[i * 2 + 1]) < GATES[it]) idx.push(i);
			if (idx.length >= 6) {
				const rg = new Float64Array(idx.length * 2);
				idx.forEach((i, k) => {
					rg[k * 2] = r[i * 2];
					rg[k * 2 + 1] = r[i * 2 + 1];
				});
				const s = sigma.match || robustSigma(rg, SIGMA_FLOOR.match);
				parts.push({
					name: "match",
					idx,
					s,
					w: huberSqrtW(rg.map((v) => v / s)),
				});
				info.match = { n: idx.length, sigma: s };
			}
		}
		if (!parts.length) return null;
		const logF0 = Math.log(f0);
		const F = (xx: Float64Array) => {
			const out: number[] = [];
			for (const p of parts) {
				if (p.name === "sky") {
					const rr = skyResid(xx, sk as SkylineCue, W, H, p.cu, p.tgt);
					const k = 1 / p.s / Math.sqrt(rr.length);
					for (let i = 0; i < rr.length; i++) out.push(p.w[i] * rr[i] * k);
				} else {
					const rr = matchResid(xx, c as Corr, eye, p.idx);
					const k = Math.sqrt(lam) / p.s / Math.sqrt(rr.length / 2);
					for (let i = 0; i < rr.length; i++) out.push(p.w[i] * rr[i] * k);
				}
			}
			out.push((xx[3] - logF0) / FOCAL_SIGMA);
			return Float64Array.from(out);
		};
		const sol = leastSquares(F, x, {
			xScale: [0.1, 0.1, 0.1, 0.01],
			maxNfev: 400,
		});
		x = sol.x;
		info.cost = sol.cost;
	}
	return [x, info];
}

/** selection_cost: truncated quadratic with fixed σ over every candidate item. */
export function selectionCost(
	x: ArrayLike<number>,
	sk: SkylineCue | null,
	c: Corr | null,
	eye: ArrayLike<number>,
	W: number,
	H: number,
	sigma: Sigma,
	lam = 1.0,
): number {
	let tot = 0;
	const T2 = TRUNC * TRUNC;
	if (sk) {
		const { cu, tgt, ncol } = skyAssociate(x, sk, W, H, WINS[0]);
		if (ncol) {
			const r = cu.length
				? skyResid(x, sk, W, H, cu, tgt)
				: new Float64Array(0);
			let q = 0;
			const s = sigma.sky as number;
			for (const v of r) q += Math.min((v / s) ** 2, T2);
			tot += (q + (ncol - cu.length) * T2) / ncol;
		} else tot += T2;
	}
	if (c?.x2d.length && sigma.match) {
		const r = matchResid(x, c, eye);
		const n = r.length / 2;
		let q = 0;
		for (let i = 0; i < n; i++)
			q += Math.min(
				(Math.hypot(r[i * 2], r[i * 2 + 1]) / sigma.match) ** 2,
				T2,
			);
		tot += (lam * q) / n;
	}
	return tot;
}

export type Diagnostics = {
	sky_med?: number | null;
	sky_cols_with_evidence?: number;
	sky_cols?: number;
	sky_cover?: number;
	match_support?: number;
	match_med?: number | null;
	match_n?: number;
};

export function diagnostics(
	x: ArrayLike<number>,
	sk: SkylineCue | null,
	c: Corr | null,
	eye: ArrayLike<number>,
	W: number,
	H: number,
): Diagnostics {
	const out: Diagnostics = {};
	if (sk) {
		const { cu, tgt, ncol } = skyAssociate(x, sk, W, H, WINS[WINS.length - 1]);
		const r = cu.length ? skyResid(x, sk, W, H, cu, tgt) : new Float64Array(0);
		out.sky_med = r.length ? median(r.map(Math.abs)) : null;
		out.sky_cols_with_evidence = cu.length;
		out.sky_cols = ncol;
		let cover = 0;
		for (const v of r) if (Math.abs(v) < 4.0) cover++;
		out.sky_cover = ncol ? cover / ncol : 0;
	}
	if (c?.x2d.length) {
		const r = matchResid(x, c, eye);
		const n = r.length / 2;
		const inl: number[] = [];
		for (let i = 0; i < n; i++) {
			const e = Math.hypot(r[i * 2], r[i * 2 + 1]);
			if (e < SUPPORT_PX) inl.push(e);
		}
		out.match_support = inl.length / n;
		out.match_med = inl.length ? median(inl) : null;
		out.match_n = n;
	}
	return out;
}

export type FuseChecks = {
	cueAgreeDeg: number | null;
	skylineMedPx: number | null;
	matchSupport: number | null;
};

export type FuseCues = {
	skyline: {
		pose: Pose;
		residualPx: number | null;
		appConfidence?: number | null;
		accepted?: string;
	} | null;
	match: { pose: Pose; inliers: number; residualPx: number | null } | null;
};

export type FuseResult = {
	fusedPose: Pose | null;
	start: "skyline" | "match" | null;
	level: "high" | "low";
	checks: FuseChecks;
	fusionScore: number;
	cues: FuseCues;
	diag: Diagnostics;
	sigma: Record<string, number | null>;
	fusionMs: number;
};

/** server/fuse.fuse: one scenario of fusion.solve_photo on in-memory inputs. */
export async function fuse(
	prior: Pose,
	eye: ArrayLike<number>,
	W: number,
	H: number,
	sk: SkylineCue | null,
	corr: Corr | null,
	opts: { lam?: number } = {},
): Promise<FuseResult> {
	const t0 = performance.now();
	const lam = opts.lam ?? 1.0;
	const f0 = focalPx(prior.vfov, H);
	const c = corr?.x2d.length ? corr : null;
	const skyPose = sk?.app?.pose ?? null;
	const sigma: Sigma = {};
	let skyResidAtOwn: number | null | undefined = null;
	if (sk && skyPose) {
		const s = solveFusion(xFromPose(skyPose, H), W, H, f0, {
			sk,
			useMatch: false,
		});
		sigma.sky = s?.[1].sky ? s[1].sky.sigma : 2.0;
		skyResidAtOwn = diagnostics(
			xFromPose(skyPose, H),
			sk,
			null,
			eye,
			W,
			H,
		).sky_med;
	}
	let mo: {
		ransacPose: Pose;
		inliers: number;
		rmse: number | null;
		pose: Pose;
	} | null = null;
	if (c && c.x2d.length / 2 >= 6) {
		const rs = await solveRotation(c.x2d, c.X, eye, W, H, f0, false, {});
		if (rs) {
			const rp = rToPose(rs.R, prior.vfov);
			const m = solveFusion(xFromPose(rp, H), W, H, f0, {
				c,
				eye,
				useSky: false,
			});
			let ni = 0;
			for (const v of rs.inliers) ni += v;
			mo = {
				ransacPose: rp,
				inliers: ni,
				rmse: rs.rmse,
				pose: m ? poseFromX(m[0], H) : rp,
			};
			sigma.match = m?.[1].match ? m[1].match.sigma : 2.0;
		}
	}
	if (sigma.sky == null) sigma.sky = 2.0;
	let best: [Float64Array, number, "skyline" | "match"] | null = null;
	const starts: ["skyline" | "match", Pose | null][] = [
		["skyline", skyPose],
		["match", mo ? mo.pose : null],
	];
	for (const [name, start] of starts) {
		if (!start) continue;
		const s = solveFusion(xFromPose(start, H), W, H, f0, {
			sk,
			c,
			eye,
			lam,
			sigma,
		});
		if (s) {
			const sel = selectionCost(s[0], sk, c, eye, W, H, sigma, lam);
			if (!best || sel < best[1]) best = [s[0], sel, name];
		}
	}
	let fused: Pose | null = null;
	let diag: Diagnostics | null = null;
	if (best) {
		fused = poseFromX(best[0], H);
		diag = diagnostics(best[0], sk, c, eye, W, H);
	}
	const dAgree = mo && skyPose ? rotAngle(skyPose, mo.pose) : null;
	const dz = diag ?? {};
	const high =
		dAgree != null &&
		dAgree < 1.0 &&
		dz.sky_med != null &&
		dz.sky_med < 4.0 &&
		(dz.match_support ?? 0) >= 0.3;
	const scoreC =
		dAgree != null
			? Math.exp(-dAgree) *
				Math.exp(-(dz.sky_med || 99) / 4.0) *
				Math.min(1.0, (dz.match_support || 0) / 0.3)
			: 0.0;
	return {
		fusedPose: fused ? plainPose(fused) : null,
		start: best ? best[2] : null,
		level: high ? "high" : "low",
		checks: {
			cueAgreeDeg: roundOrNull(dAgree),
			skylineMedPx: roundOrNull(dz.sky_med),
			matchSupport: roundOrNull(dz.match_support),
		},
		fusionScore: Math.round(scoreC * 1000) / 1000,
		cues: {
			skyline:
				sk && skyPose
					? {
							pose: plainPose(skyPose),
							residualPx: roundOrNull(skyResidAtOwn),
							appConfidence: roundOrNull(sk.app?.confidence),
							accepted: sk.app?.accepted,
						}
					: null,
			match: mo
				? {
						pose: plainPose(mo.pose),
						inliers: mo.inliers,
						residualPx: roundOrNull(mo.rmse),
					}
				: null,
		},
		diag: dz,
		sigma: Object.fromEntries(
			Object.entries(sigma).map(([k, v]) => [k, roundOrNull(v)]),
		),
		fusionMs: Math.round(performance.now() - t0),
	};
}
