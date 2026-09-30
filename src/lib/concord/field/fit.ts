// WP-E: display residual field W (photo uv → render uv offset, render = photo + W).
//
// DISPLAY ONLY. W never feeds pose, confidence, benchmarks or exports; it is refused outright when
// the pose confidence is LOW (displayField / opts.confidence), bounded by
// |W| ≤ min(maxPx @1600, maxMetres at the pixel's range, maxDeg), zero on sky / people / cells with no
// cue within `supportLengths` correlation lengths, and faded by its posterior σ.
//
// Fit: a depth-guided Gaussian process (least-squares collocation) with a zero prior mean and the
// squared-exponential kernel
//   k(a, b) = s² · exp(−|xy_a − xy_b|² / (2ℓ²) − (ln r_a − ln r_b)² / (2λ²))
// over pixel position (px @1600, long side) and log range, so a foreground ridge and the valley
// behind it decorrelate. du and dv are independent GPs with the same kernel; every cue contributes
// one scalar observation per constrained direction a (point: x and y; edge: its normal; level /
// shore: y), cov(a·W(p), b·W(q)) = (a·b)·k(p, q). A regularised thin-plate spline in (x, y) is the
// baseline (method "tps"; its σ is the GP's).
//
// Residual convention: cue (u, v) is the OBSERVED photo position; residualPx = predicted − observed
// (render − photo) in px @1600 (long side = 1600), the scripts/concord/eval.ts sign. For a point
// cue it is [dx, dy]; for an edge the scalar along its normal (nu, nv) (a pixel-space direction,
// normalised here); for level / shore the scalar dy.

import { DEG } from "../../geodesy";
import { smoothstep } from "../../math";
import {
	type CameraX,
	type Cue,
	type ResidualField,
	ZERO_FIELD,
} from "../core";

/**
 * The renderer's geometry for the photo, resampled to a photo-uv grid (cell-centred, row 0 = top).
 * rangeM: slant range (m) of the rendered surface; ≤ 0 or non-finite = sky / no terrain.
 * people: optional foreground mask (> 127 or > 0.5 = people / protected), same grid.
 */
export type GeomBuffer = {
	w: number;
	h: number;
	rangeM: Float32Array;
	people?: Uint8Array | Float32Array;
};

export type FieldCue = Cue & {
	/** px @1600, predicted − observed. [dx, dy] for points; the scalar along the constrained direction otherwise. */
	residualPx: number | readonly [number, number];
	/** 0..1 weight; the cue's noise is sigmaPx / √conf. */
	conf: number;
};

/** Pose confidence as the app knows it: solve.ts (accepted, 0..1 confidence) or a tier. */
export type PoseConfidence = {
	accepted?: boolean;
	confidence?: number;
	level?: "high" | "medium" | "low";
};

/** Below this solve confidence the pose is LOW (solve.ts acceptConfidence default). */
export const WARP_MIN_CONFIDENCE = 0.5;

/** LOW unless the pose is explicitly accepted with confidence ≥ WARP_MIN_CONFIDENCE (fail closed). */
export function isLowConfidence(c: PoseConfidence | null | undefined): boolean {
	if (!c) return true;
	if (c.level === "low") return true;
	if (c.accepted === false) return true;
	if (c.level === "high" || c.level === "medium")
		return !(c.confidence === undefined || c.confidence >= WARP_MIN_CONFIDENCE);
	return !(
		typeof c.confidence === "number" && c.confidence >= WARP_MIN_CONFIDENCE
	);
}

export type FitOptions = {
	/** Field grid (w, h), default [96, 72] (landscape) / [72, 96] (portrait). */
	grid?: [number, number];
	/** Correlation length ℓ in px @1600. */
	lengthPx?: number;
	/** Log-range correlation length λ (natural log units). */
	logRangeScale?: number;
	/** Hard bounds: |W| ≤ min(maxPx, maxMetres at range, maxDeg). */
	maxPx?: number;
	maxMetres?: number;
	maxDeg?: number;
	/** "gp" (default) or the "tps" baseline. */
	method?: "gp" | "tps";
	/** GP prior amplitude s (px); default clamp(RMS of residuals, 1.5, maxPx). */
	priorPx?: number;
	/** σ fade: W·(1 − smoothstep(lo·s, hi·s, σ)); default [0.6, 0.95]. */
	fade?: [number, number];
	/** W = 0 beyond this many correlation lengths from the nearest cue (tapered from 0.75 of it). */
	supportLengths?: number;
	/**
	 * Sky cells within this many px (@1600, vertically) of terrain take that terrain's range, so W
	 * stays continuous across the skyline (a hard zero there would draw the rendered skyline twice
	 * or not at all); sky beyond it is W = 0. Default 1.5·maxPx.
	 */
	skyMarginPx?: number;
	/** TPS smoothing (px²-scale regulariser relative to ℓ); default 0.1. */
	tpsLambda?: number;
	/** Cap on scalar observations (deterministic subsample by conf); default 1000. */
	maxObs?: number;
	/** Compute provenance.looGainPx by refitting without each cue (≤ 60 cues); default true. */
	loo?: boolean;
	/** When given and LOW, nothing is fitted: a zero field with provenance "refused:low-confidence". */
	confidence?: PoseConfidence;
};

export const FIELD_DEFAULTS = {
	lengthPx: 200,
	logRangeScale: 1,
	maxPx: 12,
	maxMetres: 15,
	maxDeg: 1,
	fade: [0.6, 0.95] as [number, number],
	supportLengths: 2,
	tpsLambda: 0.1,
	maxObs: 1000,
};

/** Counts actual fits (tests assert LOW confidence never reaches the fit). */
export const fitStats = { fits: 0 };

/** Long-side-1600 pixel basis for an aspect (W/H). */
export const basisPx = (aspect: number) =>
	aspect >= 1 ? { W: 1600, H: 1600 / aspect } : { W: 1600 * aspect, H: 1600 };

/** Focal length in px @1600 (per radian near the centre). */
export const focalPx = (cam: CameraX) =>
	(basisPx(cam.aspect).H / 2 / Math.tan((cam.pose.vfov * DEG) / 2)) *
	cam.intr.fScale;

type Obs = {
	x: number;
	y: number;
	lr: number;
	ax: number;
	ay: number;
	val: number;
	noise: number;
	cue: number;
};

/** Cues → scalar observations (px @1600 positions, log range). */
function toObs(cues: FieldCue[], W: number, H: number): Obs[] {
	const out: Obs[] = [];
	cues.forEach((c, i) => {
		const conf = Math.max(1e-3, Math.min(1, c.conf ?? 1));
		const sig = Math.max(0.05, c.sigmaPx);
		const noise = (sig * sig) / conf;
		const depth = c.depthM > 0 ? c.depthM : Number.NaN;
		if (!Number.isFinite(depth)) return;
		const base = { x: c.u * W, y: c.v * H, lr: Math.log(depth), noise, cue: i };
		const r = c.residualPx;
		if (c.kind === "point") {
			if (typeof r === "number") return; // a point needs [dx, dy]
			if (!Number.isFinite(r[0]) || !Number.isFinite(r[1])) return;
			out.push({ ...base, ax: 1, ay: 0, val: r[0] });
			out.push({ ...base, ax: 0, ay: 1, val: r[1] });
		} else {
			const val = typeof r === "number" ? r : r[1];
			if (!Number.isFinite(val)) return;
			let ax = 0;
			let ay = 1;
			if (c.kind === "edge") {
				const n = Math.hypot(c.nu, c.nv);
				if (!(n > 0)) return;
				ax = c.nu / n;
				ay = c.nv / n;
			}
			out.push({ ...base, ax, ay, val });
		}
	});
	return out;
}

/** Deterministic subsample: keep the most confident (lowest noise) first, ties by index. */
function capObs(obs: Obs[], max: number): Obs[] {
	if (obs.length <= max) return obs;
	return obs
		.map((o, i) => ({ o, i }))
		.sort((a, b) => a.o.noise - b.o.noise || a.i - b.i)
		.slice(0, max)
		.sort((a, b) => a.i - b.i)
		.map((x) => x.o);
}

function cholesky(A: Float64Array, n: number): Float64Array {
	const L = new Float64Array(n * n);
	for (let i = 0; i < n; i++) {
		for (let j = 0; j <= i; j++) {
			let s = A[i * n + j];
			for (let k = 0; k < j; k++) s -= L[i * n + k] * L[j * n + k];
			if (i === j) L[i * n + i] = Math.sqrt(Math.max(s, 1e-12));
			else L[i * n + j] = s / L[j * n + j];
		}
	}
	return L;
}
/** Solve L z = b (forward). */
function forward(L: Float64Array, n: number, b: Float64Array): Float64Array {
	const z = new Float64Array(n);
	for (let i = 0; i < n; i++) {
		let s = b[i];
		for (let k = 0; k < i; k++) s -= L[i * n + k] * z[k];
		z[i] = s / L[i * n + i];
	}
	return z;
}
/** Solve Lᵀ x = z (backward). */
function backward(L: Float64Array, n: number, z: Float64Array): Float64Array {
	const x = new Float64Array(n);
	for (let i = n - 1; i >= 0; i--) {
		let s = z[i];
		for (let k = i + 1; k < n; k++) s -= L[k * n + i] * x[k];
		x[i] = s / L[i * n + i];
	}
	return x;
}

/** Posterior at a point: mean (px) and covariance [cxx, cyy, cxy] (px²; NaN when not requested). */
type Post = [mx: number, my: number, cxx: number, cyy: number, cxy: number];
type Model = {
	/** Posterior mean and covariance of W at a pixel-space point with log range lr. */
	predict(x: number, y: number, lr: number, wantSigma: boolean): Post;
};

function gpModel(obs: Obs[], s: number, ell: number, lam: number): Model {
	const n = obs.length;
	const s2 = s * s;
	const kern = (
		x: number,
		y: number,
		lr: number,
		o: { x: number; y: number; lr: number },
	) => {
		const dx = x - o.x;
		const dy = y - o.y;
		const dl = lr - o.lr;
		return (
			s2 *
			Math.exp(
				-(dx * dx + dy * dy) / (2 * ell * ell) - (dl * dl) / (2 * lam * lam),
			)
		);
	};
	const K = new Float64Array(n * n);
	for (let i = 0; i < n; i++)
		for (let j = 0; j <= i; j++) {
			const a = obs[i];
			const b = obs[j];
			const dot = a.ax * b.ax + a.ay * b.ay;
			const v = dot === 0 ? 0 : dot * kern(a.x, a.y, a.lr, b);
			K[i * n + j] = K[j * n + i] = v + (i === j ? a.noise + 1e-9 * s2 : 0);
		}
	const L = cholesky(K, n);
	const alpha = backward(
		L,
		n,
		forward(
			L,
			n,
			Float64Array.from(obs, (o) => o.val),
		),
	);
	const kx = new Float64Array(n);
	const ky = new Float64Array(n);
	return {
		predict(x, y, lr, wantSigma) {
			let mx = 0;
			let my = 0;
			for (let i = 0; i < n; i++) {
				const o = obs[i];
				const k = kern(x, y, lr, o);
				kx[i] = o.ax * k;
				ky[i] = o.ay * k;
				mx += kx[i] * alpha[i];
				my += ky[i] * alpha[i];
			}
			if (!wantSigma) return [mx, my, Number.NaN, Number.NaN, Number.NaN];
			const vx = forward(L, n, kx);
			const vy = forward(L, n, ky);
			let qx = 0;
			let qy = 0;
			let qxy = 0;
			for (let i = 0; i < n; i++) {
				qx += vx[i] * vx[i];
				qy += vy[i] * vy[i];
				qxy += vx[i] * vy[i];
			}
			return [mx, my, s2 - qx, s2 - qy, -qxy];
		},
	};
}

/** Dense solve (Gaussian elimination, partial pivoting). */
function solveDense(A: Float64Array, b: Float64Array, n: number): Float64Array {
	const M = Float64Array.from(A);
	const x = Float64Array.from(b);
	for (let c = 0; c < n; c++) {
		let p = c;
		for (let r = c + 1; r < n; r++)
			if (Math.abs(M[r * n + c]) > Math.abs(M[p * n + c])) p = r;
		if (p !== c) {
			for (let k = 0; k < n; k++) {
				const t = M[c * n + k];
				M[c * n + k] = M[p * n + k];
				M[p * n + k] = t;
			}
			const t = x[c];
			x[c] = x[p];
			x[p] = t;
		}
		const d = M[c * n + c] || 1e-12;
		for (let r = c + 1; r < n; r++) {
			const f = M[r * n + c] / d;
			if (f === 0) continue;
			for (let k = c; k < n; k++) M[r * n + k] -= f * M[c * n + k];
			x[r] -= f * x[c];
		}
	}
	for (let r = n - 1; r >= 0; r--) {
		let s = x[r];
		for (let k = r + 1; k < n; k++) s -= M[r * n + k] * x[k];
		x[r] = s / (M[r * n + r] || 1e-12);
	}
	return x;
}

/**
 * Regularised thin-plate spline per component over axis-aligned observations (edges are ignored).
 * < 3 observations of a component: their noise-weighted mean (a constant). σ comes from `sigma`.
 */
function tpsModel(
	obs: Obs[],
	ell: number,
	lambda: number,
	sigma: Model,
): Model {
	const comp = (pick: (o: Obs) => boolean) => {
		const o = obs.filter(pick);
		const n = o.length;
		if (n === 0) return () => 0;
		if (n < 3) {
			let sw = 0;
			let sv = 0;
			for (const q of o) {
				sw += 1 / q.noise;
				sv += q.val / q.noise;
			}
			const m = sv / sw;
			return () => m;
		}
		const phi = (r2: number) => (r2 > 0 ? 0.5 * r2 * Math.log(r2) : 0);
		const N = n + 3;
		const A = new Float64Array(N * N);
		const b = new Float64Array(N);
		const X = o.map((q) => q.x / ell);
		const Y = o.map((q) => q.y / ell);
		for (let i = 0; i < n; i++) {
			for (let j = 0; j < n; j++) {
				const dx = X[i] - X[j];
				const dy = Y[i] - Y[j];
				A[i * N + j] = phi(dx * dx + dy * dy);
			}
			A[i * N + i] += lambda * o[i].noise;
			A[i * N + n] = A[n * N + i] = 1;
			A[i * N + n + 1] = A[(n + 1) * N + i] = X[i];
			A[i * N + n + 2] = A[(n + 2) * N + i] = Y[i];
			b[i] = o[i].val;
		}
		const c = solveDense(A, b, N);
		return (x: number, y: number) => {
			const xs = x / ell;
			const ys = y / ell;
			let s = c[n] + c[n + 1] * xs + c[n + 2] * ys;
			for (let i = 0; i < n; i++) {
				const dx = xs - X[i];
				const dy = ys - Y[i];
				s += c[i] * phi(dx * dx + dy * dy);
			}
			return s;
		};
	};
	const fx = comp((o) => o.ax === 1 && o.ay === 0);
	const fy = comp((o) => o.ax === 0 && o.ay === 1);
	return {
		predict(x, y, lr, wantSigma) {
			const p = sigma.predict(x, y, lr, wantSigma);
			return [fx(x, y), fy(x, y), p[2], p[3], p[4]];
		},
	};
}

type Resolved = Required<
	Omit<
		FitOptions,
		"grid" | "priorPx" | "confidence" | "method" | "loo" | "skyMarginPx"
	>
> & { method: "gp" | "tps"; s: number; ell: number; lam: number };

function buildModel(obs: Obs[], o: Resolved): Model {
	const gp = gpModel(obs, o.s, o.ell, o.lam);
	return o.method === "tps" ? tpsModel(obs, o.ell, o.tpsLambda, gp) : gp;
}

/** Bound (px) at a range: min(maxPx, f·maxMetres/range, f·maxDeg). */
export function boundPx(
	rangeM: number,
	fPx: number,
	o: { maxPx: number; maxMetres: number; maxDeg: number },
): number {
	return Math.min(o.maxPx, (fPx * o.maxMetres) / rangeM, fPx * o.maxDeg * DEG);
}

/**
 * Mean → displayed W at one point: support taper, σ fade and the hard bound. Returns [x, y] px and
 * the posterior σ; zero outside support.
 */
function finalize(
	model: Model,
	obs: Obs[],
	x: number,
	y: number,
	rangeM: number,
	fPx: number,
	o: Resolved,
): [number, number, number] {
	const lr = Math.log(rangeM);
	let dmin = Number.POSITIVE_INFINITY;
	for (const q of obs) {
		const dx = (x - q.x) / o.ell;
		const dy = (y - q.y) / o.ell;
		const dl = (lr - q.lr) / o.lam;
		dmin = Math.min(dmin, dx * dx + dy * dy + dl * dl);
	}
	dmin = Math.sqrt(dmin);
	const taper = 1 - smoothstep(0.75 * o.supportLengths, o.supportLengths, dmin);
	if (!(taper > 0)) return [0, 0, o.s];
	const [mx, my, cxx, cyy, cxy] = model.predict(x, y, lr, true);
	// σ fade along the posterior covariance's principal axes (a level / edge cue constrains one
	// direction only: that direction is kept, the unconstrained one — mean 0 anyway — fades)
	const tr = (cxx + cyy) / 2;
	const dt = Math.sqrt(((cxx - cyy) / 2) ** 2 + cxy * cxy);
	const l1 = Math.max(0, tr - dt);
	const l2 = Math.max(0, tr + dt);
	let ex = 1;
	let ey = 0;
	if (dt > 1e-12) {
		// eigenvector of the smaller eigenvalue l1
		ex = cxy;
		ey = l1 - cxx;
		if (Math.abs(ex) + Math.abs(ey) < 1e-12) {
			ex = l1 - cyy;
			ey = cxy;
		}
		const nn = Math.hypot(ex, ey);
		ex /= nn;
		ey /= nn;
	}
	const f1 = 1 - smoothstep(o.fade[0] * o.s, o.fade[1] * o.s, Math.sqrt(l1));
	const f2 = 1 - smoothstep(o.fade[0] * o.s, o.fade[1] * o.s, Math.sqrt(l2));
	const p1 = (mx * ex + my * ey) * f1;
	const p2 = (-mx * ey + my * ex) * f2;
	const sg = Math.sqrt(l1);
	let wx = (p1 * ex - p2 * ey) * taper;
	let wy = (p1 * ey + p2 * ex) * taper;
	const b = boundPx(rangeM, fPx, o);
	const m = Math.hypot(wx, wy);
	if (m > b) {
		wx *= b / m;
		wy *= b / m;
	}
	return [wx, wy, sg];
}

function resolve(obs: Obs[], opts: FitOptions): Resolved {
	const maxPx = opts.maxPx ?? FIELD_DEFAULTS.maxPx;
	let s = opts.priorPx;
	if (s === undefined) {
		// RMS of the per-cue residual magnitude (points count both components)
		let ss = 0;
		let n = 0;
		const byCue = new Map<number, number>();
		for (const q of obs)
			byCue.set(q.cue, (byCue.get(q.cue) ?? 0) + q.val * q.val);
		for (const v of byCue.values()) {
			ss += v;
			n++;
		}
		s = Math.min(maxPx, Math.max(1.5, Math.sqrt(ss / Math.max(1, n))));
	}
	const ell = opts.lengthPx ?? FIELD_DEFAULTS.lengthPx;
	const lam = opts.logRangeScale ?? FIELD_DEFAULTS.logRangeScale;
	return {
		lengthPx: ell,
		logRangeScale: lam,
		maxPx,
		maxMetres: opts.maxMetres ?? FIELD_DEFAULTS.maxMetres,
		maxDeg: opts.maxDeg ?? FIELD_DEFAULTS.maxDeg,
		fade: opts.fade ?? FIELD_DEFAULTS.fade,
		supportLengths: opts.supportLengths ?? FIELD_DEFAULTS.supportLengths,
		tpsLambda: opts.tpsLambda ?? FIELD_DEFAULTS.tpsLambda,
		maxObs: opts.maxObs ?? FIELD_DEFAULTS.maxObs,
		method: opts.method ?? "gp",
		s,
		ell,
		lam,
	};
}

/**
 * Range (m) of the geometry at photo uv (nearest cell); for sky, the nearest terrain in the same
 * column within `marginV` (uv units); NaN for sky beyond it.
 */
function geomRange(g: GeomBuffer, u: number, v: number, marginV = 0): number {
	const i = Math.min(g.w - 1, Math.max(0, Math.floor(u * g.w)));
	const j = Math.min(g.h - 1, Math.max(0, Math.floor(v * g.h)));
	const at = (jj: number) => {
		const r = g.rangeM[jj * g.w + i];
		return r > 0 && Number.isFinite(r) ? r : Number.NaN;
	};
	const r = at(j);
	if (Number.isFinite(r) || !(marginV > 0)) return r;
	const m = Math.ceil(marginV * g.h);
	for (let k = 1; k <= m; k++) {
		if (j + k < g.h && Number.isFinite(at(j + k))) return at(j + k);
		if (j - k >= 0 && Number.isFinite(at(j - k))) return at(j - k);
	}
	return Number.NaN;
}
function geomPeople(g: GeomBuffer, u: number, v: number): boolean {
	if (!g.people) return false;
	const i = Math.min(g.w - 1, Math.max(0, Math.floor(u * g.w)));
	const j = Math.min(g.h - 1, Math.max(0, Math.floor(v * g.h)));
	const p = g.people[j * g.w + i];
	return g.people instanceof Uint8Array ? p > 127 : p > 0.5;
}

const refused = (w: number, h: number, why: string): ResidualField => {
	const f = ZERO_FIELD(w, h);
	f.provenance.sources = [`refused:${why}`];
	return f;
};

/**
 * Fit the display field from residual cues. See the file header for conventions. Cues on people are
 * dropped. With opts.confidence LOW nothing is fitted (zero field, provenance "refused:low-confidence").
 */
export function fitField(
	cues: FieldCue[],
	g: GeomBuffer,
	cam: CameraX,
	opts: FitOptions = {},
): ResidualField {
	const [gw, gh] = opts.grid ?? (cam.aspect >= 1 ? [96, 72] : [72, 96]);
	if (opts.confidence !== undefined && isLowConfidence(opts.confidence))
		return refused(gw, gh, "low-confidence");
	const { W, H } = basisPx(cam.aspect);
	const fPx = focalPx(cam);
	const kept = cues.filter((c) => !geomPeople(g, c.u, c.v));
	const obs = capObs(toObs(kept, W, H), opts.maxObs ?? FIELD_DEFAULTS.maxObs);
	if (!obs.length) return refused(gw, gh, "no-cues");
	fitStats.fits++;
	const o = resolve(obs, opts);
	const model = buildModel(obs, o);

	const skyMarginV = (opts.skyMarginPx ?? 1.5 * o.maxPx) / H;
	const n = gw * gh;
	const du = new Float32Array(n);
	const dv = new Float32Array(n);
	const sigmaPx = new Float32Array(n);
	let maxAbs = 0;
	for (let j = 0; j < gh; j++)
		for (let i = 0; i < gw; i++) {
			const u = (i + 0.5) / gw;
			const v = (j + 0.5) / gh;
			const k = j * gw + i;
			const r = geomRange(g, u, v, skyMarginV);
			if (!Number.isFinite(r) || geomPeople(g, u, v)) {
				sigmaPx[k] = o.s;
				continue;
			}
			const [wx, wy, sg] = finalize(model, obs, u * W, v * H, r, fPx, o);
			du[k] = wx / W;
			dv[k] = wy / H;
			sigmaPx[k] = sg;
			maxAbs = Math.max(maxAbs, Math.hypot(wx, wy));
		}

	// provenance: LOO gain over the cues (refit without each cue, same hyper-parameters)
	let looGainPx: number | null = null;
	const cueIds = [...new Set(obs.map((q) => q.cue))];
	if (opts.loo !== false && cueIds.length >= 2 && cueIds.length <= 60) {
		const gains: number[] = [];
		for (const id of cueIds) {
			const train = obs.filter((q) => q.cue !== id);
			const test = obs.filter((q) => q.cue === id);
			const m = buildModel(train, o);
			const t = test[0];
			const [wx, wy] = finalize(m, train, t.x, t.y, Math.exp(t.lr), fPx, o);
			let before = 0;
			let after = 0;
			for (const q of test) {
				const pred = q.ax * wx + q.ay * wy;
				before += q.val * q.val;
				after += (q.val - pred) ** 2;
			}
			gains.push(Math.sqrt(before) - Math.sqrt(after));
		}
		gains.sort((a, b) => a - b);
		const mid = gains.length >> 1;
		looGainPx =
			gains.length % 2 ? gains[mid] : (gains[mid - 1] + gains[mid]) / 2;
	}
	const sources = [
		`method:${o.method}`,
		`l=${o.ell}px,lambda=${o.lam},s=${o.s.toFixed(2)}px`,
		...new Set(kept.map((c) => c.source)),
	];
	return {
		w: gw,
		h: gh,
		du,
		dv,
		sigmaPx,
		maxAbsPx: maxAbs,
		provenance: {
			sources,
			n: cueIds.length,
			looGainPx,
			bound: { px: o.maxPx, metres: o.maxMetres },
		},
	};
}

/**
 * The app entry point: null (no warp at all) unless the pose confidence is above LOW; otherwise
 * fitField. Nothing is computed for a LOW or missing confidence.
 */
export function displayField(
	confidence: PoseConfidence | null | undefined,
	cues: FieldCue[],
	g: GeomBuffer,
	cam: CameraX,
	opts: Omit<FitOptions, "confidence"> = {},
): ResidualField | null {
	if (isLowConfidence(confidence)) return null;
	const f = fitField(cues, g, cam, {
		...opts,
		confidence: confidence ?? undefined,
	});
	return f.maxAbsPx > 0 ? f : null;
}
