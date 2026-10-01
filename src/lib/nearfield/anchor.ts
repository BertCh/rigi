// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// DEM anchoring: calibrate the model's depth against the DEM range on terrain pixels (reports/step-inside-design.md,
// "DEM anchoring"). The model predicts z-depth; the DEM gives ray length (Renderer.sampleAt().range), so
// every model sample is converted to ray length with the photo's intrinsics before comparing.
//
// Default ("curve"): a monotone RANGE-DEPENDENT map f(model ray) → metres. The P0 spike
// (tools/nearfield/spike/SUMMARY.txt) found MoGe-2 compresses range (DEM/model ≈ 1 at 15-30 m, ≈ 3 at 100-300 m,
// ≈ 6.6 at 300-1000 m), so one scale cannot place near objects AND match the far terrain. f is piecewise linear
// in log-log over weighted-quantile knots, fitted by dynamic programming on a y grid to the globally optimal
// truncated-L1 loss Σ w·min(|log D − log f(m)|, band) with every segment slope in [slopeMin, slopeMax] (monotone,
// and no flat branch: objects standing in front of far terrain are one-sided outliers that a flat branch would
// otherwise fit). Every octave of DEM range weighs the same, so the few near-terrain pixels matter as much as the far
// ranges that fill most of a landscape. A tiny slope-1 prior breaks ties. Beyond the end knots f is proportional.
// Offline validation (tools/nearfield/spike/place.py): terrain residual at DEM 15-500 m, median over 23 dev photos,
// 0.13 (curve) vs 0.34 (one scale, R3000) / 0.39 (mode scale).
//
// "scale" / "affine" (legacy): the densest window of width 2·band in sorted log ratios seeds a scale, refined as the
// median over the inlier band; affine refines dem ≈ a·model + b by relative-error weighted least squares.
import {
	type DemRangeAt,
	type IntrinsicsNorm,
	type MaskLike,
	maskSampler,
	median,
	modelDepth,
	rayFactor,
} from "./geom";
import type { AnchorFit, NearFieldDepth } from "./types";

/** What anchoredRange needs: a scale-only / affine fit, or a curve (AnchorFit.curve) that takes precedence. */
export type AnchorLike = Pick<AnchorFit, "scale" | "shift"> & {
	curve?: AnchorFit["curve"];
};

export type AnchorOpts = {
	/**
	 * "curve" (default): dem = f(model), monotone log-log piecewise linear (AnchorFit.curve).
	 * "scale": dem = s·model. "affine": dem = s·model + shift.
	 */
	mode?: "curve" | "scale" | "affine";
	/**
	 * DEM range limits (m) for candidate pixels. Default 15..3000 (spike: below 15 m the DEM range is dominated by
	 * eye-height and DEM-resolution error at grazing angles; beyond 3 km the model carries no depth signal).
	 */
	minRange?: number;
	maxRange?: number;
	/** Inlier half-width in |log ratio|. Default ln 1.25 (±25 %, the spike's band). */
	band?: number;
	/** Curve-fit tuning (mode "curve"). */
	curve?: Partial<CurveOpts>;
	/** Grid stride for candidates; default picks a stride giving ≤ ~40k candidates. */
	stride?: number;
	skyMask?: MaskLike | null;
	peopleMask?: MaskLike | null;
	/** Fewer candidates than this → no fit: quality 0, scale 1. Default ANCHOR_QUALITY_CONSTS.nMin. */
	minSamples?: number;
};

export type CurveOpts = {
	/** Max knots (weighted quantiles 2 %..98 % of log model ray). Default 6. */
	knots: number;
	/** Min knot spacing in log units. Default 0.2. */
	minSpacing: number;
	/** Segment slope bounds in log-log (d log D / d log m). Default 0.75..6. */
	slopeMin: number;
	slopeMax: number;
	/** y grid step (log units). Default 0.02. */
	step: number;
	/** t-slices per segment for the pairwise cost. Default 16. */
	slices: number;
	/** Equal total weight per octave of DEM range. Default true. */
	octaveWeights: boolean;
	/** Slope-1 tie-break weight per sample and log unit. Default 0.002. */
	slopePrior: number;
	/** Truncation of the L1 loss (log units). Default = the fit band. */
	band: number;
};
export const CURVE_DEFAULTS: CurveOpts = {
	knots: 6,
	minSpacing: 0.2,
	slopeMin: 0.75,
	slopeMax: 6,
	step: 0.02,
	slices: 16,
	octaveWeights: true,
	slopePrior: 0.002,
	band: Math.log(1.25),
};

/**
 * Quality, calibrated by the P0 spike (tools/nearfield/spike/SUMMARY.txt "PROPOSED VALUES"):
 *   quality = inlierFrac · exp(−(err / 0.2)²), err = median |log residual| over ALL candidates (not inliers:
 *   with a ±25 % band the inlier median is always ≈ 0.07 and says nothing).
 * The spike's pass rates at q ≥ 0.15: 50 % of correct-pose photos, 29 % of object-rich ones; at 0.35 the
 * feature would vanish on most object-rich photos, so ANCHOR_MIN_QUALITY = 0.15 hides it and
 * ANCHOR_LOW_TRUST = 0.35 only labels / fades it. Neither is a pose check (design decision 3).
 */
export const ANCHOR_QUALITY_CONSTS = {
	/** residual scale (log units) of the Gaussian falloff */
	residualScale: 0.2,
	/** below this many candidates there is no fit (quality 0). The spike's grid (512 px wide, all cells) used
	 * 2000; the fit here thins to ≤ 40k candidates, which keeps the same order of density. */
	nMin: 200,
};
/** Below this quality Step Inside is shown with a "low trust" label / fade (hidden below ANCHOR_MIN_QUALITY). */
export const ANCHOR_LOW_TRUST = 0.35;

/** The single quality formula: inlierFrac · exp(−(err/k)²), err = residualLogAll (else residualLog); 0 when n < nMin. */
export function anchorQuality(
	fit: Pick<AnchorFit, "residualLog" | "inlierFrac" | "n"> & {
		residualLogAll?: number;
	},
	c: typeof ANCHOR_QUALITY_CONSTS = ANCHOR_QUALITY_CONSTS,
): number {
	const err = fit.residualLogAll ?? fit.residualLog;
	if (!(fit.n >= c.nMin) || !Number.isFinite(err)) return 0;
	const q = fit.inlierFrac * Math.exp(-((err / c.residualScale) ** 2));
	return Math.max(0, Math.min(1, q));
}

/** Apply a fit to a model ray length (m): the curve when the fit has one, else scale·m + shift. */
export const anchoredRange = (fit: AnchorLike, modelRay: number) =>
	fit.curve
		? curveRange(fit.curve, modelRay)
		: fit.scale * modelRay + fit.shift;

/**
 * Below this model ray (m) MoGe-2's metric depth is taken at face value when the curve has no knot there
 * (spike: DEM/MoGe ratio ~1 at 15-30 m). See curveRange.
 */
export const CURVE_METRIC_NEAR = 15;

/**
 * Evaluate a log-log curve at model ray length m (m): linear interpolation of log metres over the log knots,
 * slope 1 (constant ratio) beyond the far knot. Below the near knot: constant ratio when that knot is within
 * CURVE_METRIC_NEAR, else the log ratio falls linearly (in log m) from the knot's to 1 at CURVE_METRIC_NEAR and
 * stays 1 below. A photo whose nearest DEM-calibrated terrain is kilometres away (ratio ~8) would otherwise
 * push a person 2 m from the lens to ~20 m, behind the ground at their feet. NaN for m ≤ 0.
 */
export function curveRange(
	curve: NonNullable<AnchorFit["curve"]>,
	m: number,
): number {
	if (!(m > 0)) return Number.NaN;
	const { x, y } = curve;
	const n = x.length;
	const lx = Math.log(m);
	if (n === 1 || lx <= x[0]) {
		const ln = Math.log(CURVE_METRIC_NEAR);
		const lr0 = y[0] - x[0]; // log ratio at the near knot
		if (x[0] <= ln || lr0 <= 0) return Math.exp(y[0] + lx - x[0]);
		const w = Math.max(0, (lx - ln) / (x[0] - ln));
		return Math.exp(lx + w * lr0);
	}
	if (lx >= x[n - 1]) return Math.exp(y[n - 1] + lx - x[n - 1]);
	let k = 0;
	while (k < n - 2 && lx > x[k + 1]) k++;
	const t = (lx - x[k]) / (x[k + 1] - x[k]);
	return Math.exp(y[k] + t * (y[k + 1] - y[k]));
}

/**
 * Fit model depth to the DEM range. `demRangeAt(u, v)` is the terrain ray length in metres at normalised
 * coords (Renderer.sampleAt(u, v)?.range; grid it with geom.sampleDemGrid for speed). `K` = the photo's
 * normalised intrinsics (geom.intrinsicsFromPose), NOT the model's own.
 */
export function fitAnchor(
	depth: NearFieldDepth,
	demRangeAt: DemRangeAt,
	K: IntrinsicsNorm,
	opts: AnchorOpts = {},
): AnchorFit {
	const minRange = opts.minRange ?? 15;
	const maxRange = opts.maxRange ?? 3000;
	const band = opts.band ?? Math.log(1.25);
	const mode = opts.mode ?? "curve";
	const minSamples = opts.minSamples ?? ANCHOR_QUALITY_CONSTS.nMin;
	const { width: W, height: H } = depth;
	const stride =
		opts.stride ?? Math.max(1, Math.ceil(Math.sqrt((W * H) / 40_000)));
	const sky = maskSampler(opts.skyMask);
	const people = maskSampler(opts.peopleMask);

	const mr: number[] = []; // model ray length
	const dr: number[] = []; // dem range
	for (let j = stride >> 1; j < H; j += stride)
		for (let i = stride >> 1; i < W; i += stride) {
			const z = modelDepth(depth, j * W + i);
			if (Number.isNaN(z)) continue;
			const u = (i + 0.5) / W;
			const v = (j + 0.5) / H;
			if (sky?.(u, v) || people?.(u, v)) continue;
			const d = demRangeAt(u, v);
			if (d == null || !(d >= minRange && d <= maxRange)) continue;
			mr.push(z * rayFactor(K, u, v));
			dr.push(d);
		}
	const n = mr.length;
	const failed: AnchorFit = {
		scale: 1,
		shift: 0,
		residualLog: Number.NaN,
		inlierFrac: 0,
		n,
		quality: 0,
		maxRange,
	};
	if (n < minSamples) return failed;

	if (mode === "curve") {
		const curve = fitCurve(mr, dr, { band, ...opts.curve });
		const mMed = median(mr);
		const res: AnchorFit = {
			...residualStats(mr, dr, (m) => curveRange(curve, m), band),
			scale: curveRange(curve, mMed) / mMed,
			shift: 0,
			n,
			quality: 0,
			maxRange,
			curve,
		};
		res.quality = anchorQuality(res);
		return res;
	}

	const r = new Float64Array(n);
	for (let k = 0; k < n; k++) r[k] = Math.log(dr[k] / mr[k]);

	const s = logMode(r, band);
	const scaleOnly = summarize(mr, dr, Math.exp(s), 0, band);
	let fit = scaleOnly;
	if (opts.mode === "affine") {
		let a = Math.exp(s);
		let b = 0;
		for (let it = 0; it < 5; it++) {
			// weighted LS on relative error: minimise Σ ((a m + b − d)/d)² over the current inliers
			let sw = 0;
			let sm = 0;
			let smm = 0;
			let sd = 0;
			let smd = 0;
			for (let k = 0; k < n; k++) {
				const p = a * mr[k] + b;
				if (!(p > 0) || Math.abs(Math.log(dr[k] / p)) > band) continue;
				const w = 1 / (dr[k] * dr[k]);
				sw += w;
				sm += w * mr[k];
				smm += w * mr[k] * mr[k];
				sd += w * dr[k];
				smd += w * mr[k] * dr[k];
			}
			const det = sw * smm - sm * sm;
			if (!(det > 0)) break;
			const a2 = (sw * smd - sm * sd) / det;
			const b2 = (smm * sd - sm * smd) / det;
			if (!(a2 > 0)) break;
			a = a2;
			b = b2;
		}
		const aff = summarize(mr, dr, a, b, band);
		if (aff.inliers >= scaleOnly.inliers && a > 0) fit = aff;
	}
	const res: AnchorFit = {
		...residualStats(mr, dr, (m) => fit.scale * m + fit.shift, band),
		scale: fit.scale,
		shift: fit.shift,
		n,
		quality: 0,
		maxRange,
	};
	res.quality = anchorQuality(res);
	return res;
}

/** residualLog (inlier median), residualLogAll (median over all candidates) and inlierFrac of a map. */
function residualStats(
	mr: ArrayLike<number>,
	dr: ArrayLike<number>,
	f: (m: number) => number,
	band: number,
) {
	const all = new Float64Array(mr.length);
	const inl: number[] = [];
	for (let k = 0; k < mr.length; k++) {
		const p = f(mr[k]);
		const e = p > 0 ? Math.abs(Math.log(dr[k] / p)) : Number.POSITIVE_INFINITY;
		all[k] = e;
		if (e <= band) inl.push(e);
	}
	return {
		residualLog: median(inl),
		residualLogAll: median(all),
		inlierFrac: mr.length ? inl.length / mr.length : 0,
	};
}

/**
 * Fit the monotone log-log curve log D = f(log m) to candidate pairs (model ray m, DEM range D), both > 0.
 * Knots at weighted quantiles (2..98 %) of log m, ≥ minSpacing apart; knot values on a grid of step `step`; the
 * dynamic programme over knots minimises the truncated-L1 loss with slope bounds (see the header). Returns
 * { x: log knots, y: log metres }; one knot = a constant ratio (its mode).
 */
export function fitCurve(
	mr: ArrayLike<number>,
	dr: ArrayLike<number>,
	opts: Partial<CurveOpts> = {},
): { x: number[]; y: number[] } {
	const o = { ...CURVE_DEFAULTS, ...opts };
	const n = mr.length;
	const x = new Float64Array(n);
	const y = new Float64Array(n);
	for (let k = 0; k < n; k++) {
		x[k] = Math.log(mr[k]);
		y[k] = Math.log(dr[k]);
	}
	// weights: equal total per octave of DEM range, normalised to mean 1
	const w = new Float64Array(n).fill(1);
	if (o.octaveWeights) {
		const cnt = new Map<number, number>();
		const oct = new Int32Array(n);
		for (let k = 0; k < n; k++) {
			oct[k] = Math.floor(y[k] / Math.LN2);
			cnt.set(oct[k], (cnt.get(oct[k]) ?? 0) + 1);
		}
		for (let k = 0; k < n; k++) w[k] = 1 / (cnt.get(oct[k]) ?? 1);
	}
	let sw = 0;
	for (let k = 0; k < n; k++) sw += w[k];
	for (let k = 0; k < n; k++) w[k] *= n / sw;

	// knots: weighted quantiles of x
	const order = Array.from({ length: n }, (_, k) => k).sort(
		(a, b) => x[a] - x[b],
	);
	const cw = new Float64Array(n);
	let acc = 0;
	for (let k = 0; k < n; k++) {
		acc += w[order[k]];
		cw[k] = acc / n;
	}
	const cand: number[] = [];
	for (let q = 0; q < o.knots; q++) {
		const qq = o.knots > 1 ? 0.02 + (0.96 * q) / (o.knots - 1) : 0.5;
		let lo = 0;
		let hi = n - 1;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (cw[mid] < qq) lo = mid + 1;
			else hi = mid;
		}
		cand.push(x[order[lo]]);
	}
	const kx = [cand[0]];
	for (const c of cand.slice(1))
		if (c - kx[kx.length - 1] >= o.minSpacing) kx.push(c);
	const last = cand[cand.length - 1];
	if (
		kx.length >= 2 &&
		last !== kx[kx.length - 1] &&
		last - kx[kx.length - 2] >= o.minSpacing
	)
		kx[kx.length - 1] = last;

	const ys = Float64Array.from(y).sort();
	const band = o.band;
	const step = o.step;
	const g0 = ys[Math.floor(0.01 * (n - 1))] - 2;
	const g1 = ys[Math.floor(0.99 * (n - 1))] + 1;
	const G = Math.ceil((g1 - g0) / step) + 1;
	const kmax = Math.ceil(band / step); // kernel half-width in cells (beyond it the cost is flat = band)
	// Σ w·min(|v − ŷ|, band) over the grid ŷ = g0 + a·step, for samples v (histogrammed onto the grid)
	const costOf = (idx: number[], val: (k: number) => number): Float64Array => {
		const h = new Float64Array(G);
		let tot = 0;
		for (const k of idx) {
			const a = Math.min(G - 1, Math.max(0, Math.round((val(k) - g0) / step)));
			h[a] += w[k];
			tot += w[k];
		}
		const c = new Float64Array(G).fill(tot * band);
		if (!tot) return c;
		for (let b = 0; b < G; b++) {
			const hb = h[b];
			if (!hb) continue;
			const a0 = Math.max(0, b - kmax);
			const a1 = Math.min(G - 1, b + kmax);
			for (let a = a0; a <= a1; a++) {
				const d = Math.abs(a - b) * step;
				if (d < band) c[a] -= hb * (band - d);
			}
		}
		return c;
	};

	const K = kx.length;
	const all = Array.from({ length: n }, (_, k) => k);
	if (K === 1) {
		// constant ratio: mode of log(D/m) under the same loss (grid relative to the knot)
		const c = costOf(all, (k) => y[k] - x[k] + kx[0]);
		let best = 0;
		for (let a = 1; a < G; a++) if (c[a] < c[best]) best = a;
		return { x: kx, y: [g0 + best * step] };
	}
	// unary costs at the ends (slope-1 extrapolation), pairwise per segment
	const left: number[] = [];
	const right: number[] = [];
	const seg: number[][] = Array.from({ length: K - 1 }, () => []);
	for (let k = 0; k < n; k++) {
		if (x[k] < kx[0]) left.push(k);
		else if (x[k] >= kx[K - 1]) right.push(k);
		else {
			let s = 0;
			while (s < K - 2 && x[k] >= kx[s + 1]) s++;
			seg[s].push(k);
		}
	}
	const U0 = costOf(left, (k) => y[k] - (x[k] - kx[0]));
	const UK = costOf(right, (k) => y[k] - (x[k] - kx[K - 1]));
	let V = U0;
	const back: Int32Array[] = [];
	const T = o.slices;
	for (let s = 0; s < K - 1; s++) {
		const dx = kx[s + 1] - kx[s];
		const slices: number[][] = Array.from({ length: T }, () => []);
		for (const k of seg[s])
			slices[Math.min(T - 1, Math.floor(((x[k] - kx[s]) / dx) * T))].push(k);
		// each slice is evaluated at its centre; a sample off-centre is moved along slope 1 to the centre, so the
		// discretisation error is (t − t_c)·(Δy − Δx) instead of (t − t_c)·Δy
		const C = slices.map((idx, i) => {
			const xc = kx[s] + ((i + 0.5) / T) * dx;
			return costOf(idx, (k) => y[k] - (x[k] - xc));
		});
		const dmin = Math.ceil((o.slopeMin * dx) / step);
		const dmax = Math.floor((o.slopeMax * dx) / step);
		const Vn = new Float64Array(G).fill(Number.POSITIVE_INFINITY);
		const Bn = new Int32Array(G);
		for (let d = dmin; d <= dmax; d++) {
			const prior = o.slopePrior * n * Math.abs(d * step - dx);
			for (let a = 0; a + d < G; a++) {
				const va = V[a];
				if (!Number.isFinite(va)) continue;
				let pc = va + prior;
				for (let i = 0; i < T; i++) {
					const idx = Math.min(G - 1, Math.round(a + ((i + 0.5) / T) * d));
					pc += C[i][idx];
				}
				const b = a + d;
				if (pc < Vn[b]) {
					Vn[b] = pc;
					Bn[b] = a;
				}
			}
		}
		if (s === K - 2) for (let b = 0; b < G; b++) Vn[b] += UK[b];
		V = Vn;
		back.push(Bn);
	}
	let bi = 0;
	for (let b = 1; b < G; b++) if (V[b] < V[bi]) bi = b;
	const yi = [bi];
	for (let s = back.length - 1; s >= 0; s--)
		yi.push(back[s][yi[yi.length - 1]]);
	yi.reverse();
	const ky = yi.map((a) => g0 + a * step);
	// sub-grid refinement: shift the whole curve by the weighted median inlier residual
	const res: number[] = [];
	const rw: number[] = [];
	const cv = { x: kx, y: ky };
	for (let k = 0; k < n; k++) {
		const e = y[k] - Math.log(curveRange(cv, Math.exp(x[k])));
		if (Math.abs(e) <= band) {
			res.push(e);
			rw.push(w[k]);
		}
	}
	const sh = weightedMedian(res, rw);
	return { x: kx, y: Number.isFinite(sh) ? ky.map((v) => v + sh) : ky };
}

function weightedMedian(v: number[], w: number[]): number {
	if (!v.length) return Number.NaN;
	const o = v.map((_, i) => i).sort((a, b) => v[a] - v[b]);
	let tot = 0;
	for (const i of o) tot += w[i];
	let acc = 0;
	for (const i of o) {
		acc += w[i];
		if (acc >= tot / 2) return v[i];
	}
	return v[o[o.length - 1]];
}

/**
 * Mode-seeking robust centre of `r` (e.g. log ratios): the densest window of width 2·band seeds it, then it
 * is refined as the median of |r − s| ≤ band. NaN when `r` is empty.
 */
export function logMode(r: ArrayLike<number>, band: number): number {
	const n = r.length;
	if (!n) return Number.NaN;
	const sorted = Float64Array.from(r).sort();
	let best = 0;
	let bi = 0;
	for (let a = 0, b = 0; a < n; a++) {
		while (b < n && sorted[b] - sorted[a] <= 2 * band) b++;
		if (b - a > best) {
			best = b - a;
			bi = a;
		}
	}
	let s = median(sorted.subarray(bi, bi + best));
	const inl: number[] = [];
	for (let it = 0; it < 8; it++) {
		inl.length = 0;
		for (let k = 0; k < n; k++) if (Math.abs(r[k] - s) <= band) inl.push(r[k]);
		const s2 = median(inl);
		if (!Number.isFinite(s2)) break;
		const done = Math.abs(s2 - s) < 1e-6;
		s = s2;
		if (done) break;
	}
	return s;
}

function summarize(
	mr: number[],
	dr: number[],
	scale: number,
	shift: number,
	band: number,
) {
	const e: number[] = [];
	for (let k = 0; k < mr.length; k++) {
		const p = scale * mr[k] + shift;
		if (!(p > 0)) continue;
		const x = Math.abs(Math.log(dr[k] / p));
		if (x <= band) e.push(x);
	}
	return { scale, shift, inliers: e.length, residualLog: median(e) };
}
