/**
 * Automatic pose refinement: aligns the photo's detected skyline with the
 * DEM horizon profile. GPS position is held fixed; we solve yaw, pitch,
 * roll and focal length.
 *
 *   1. Coarse: grid search over yaw (wide, the compass is weak) and pitch
 *      (narrow, gravity is good) with a truncated loss, using the
 *      small-angle shortcut (yaw shifts azimuth, pitch shifts elevation).
 *   2. Fine: Levenberg–Marquardt with Cauchy loss on exact per-column
 *      residuals, from the best few coarse minima, with Gaussian priors
 *      pulling towards the sensor prior.
 *   3. Confidence from inlier fraction, coverage, how distinct the winning
 *      yaw is, and how much the horizon actually varies (a flat horizon
 *      can't fix yaw).
 */

import { clamp01 } from "../math";
import {
	azimuthElevation,
	type Camera,
	cameraFromAngles,
	directionENU,
	project,
	resizeCamera,
	unproject,
} from "./camera";
import type { HorizonProfile } from "./horizon";
import { levenbergMarquardt } from "./lm";

/** Matches SkylineObservation in skyline.ts (kept structural to avoid a hard dependency). */
export interface SkylineRows {
	width: number;
	height: number;
	rows: Float32Array;
	weight: Float32Array;
}

export interface SolveOptions {
	/** Coarse yaw search half-width around the prior, degrees. */
	yawRange?: number;
	pitchRange?: number;
	/** Prior standard deviations (degrees; focal as a fraction). */
	sigma?: { yaw: number; pitch: number; roll: number; focal: number };
	/** Solve focal length in the fine stage. */
	solveFocal?: boolean;
	/** Inlier threshold, px at working resolution. */
	inlierPx?: number;
	/**
	 * Gravity gives pitch/roll to ~1–2°; a solve that tilts further than this
	 * (degrees) has almost certainly fitted the wrong edge and is rejected.
	 */
	tiltGate?: number;
	/** Minimum confidence for `accepted`. */
	acceptConfidence?: number;
	/**
	 * When the local search is rejected, retry over the full 360° with no yaw
	 * prior (the compass can be fooled outright, e.g. by a metal board).
	 * Accepted only at `fullSearchConfidence`, since without a yaw prior a
	 * repetitive ridge can match in the wrong place.
	 */
	fullSearchFallback?: boolean;
	fullSearchConfidence?: number;
	/**
	 * false when the photo has no usable compass heading (e.g. non-iPhone or
	 * stripped EXIF). The solve then goes straight to the full-360° search
	 * with its stricter threshold. A yawRange ≥ 90° is treated the same way.
	 */
	headingKnown?: boolean;
}

export interface SolveResult {
	/** Solved camera at the same resolution as the prior passed in. */
	camera: Camera;
	/** 0..1 overall confidence (0 when the tilt gate trips). */
	confidence: number;
	/** confidence ≥ acceptConfidence: use `camera`; otherwise fall back to the prior / manual mode. */
	accepted: boolean;
	/** Why the solve was rejected, if it was. */
	rejectReason?: "no-skyline" | "tilt" | "low-confidence";
	/** Robust RMS of inlier residuals, px at the prior's resolution. */
	residualPx: number;
	inlierFraction: number;
	/** Fraction of image columns with a usable detected skyline. */
	coverage: number;
	/** 0..1: 1 − (runner-up − best) / (median − best) over the yaw search; lower = more distinct. */
	ambiguity: number;
	/** Std-dev of the DEM skyline across the view, degrees. */
	horizonRelief: number;
	delta: { yaw: number; pitch: number; roll: number; focal: number };
	/** Best coarse-stage offsets from the prior, degrees. */
	coarse: { yaw: number; pitch: number };
	/** Which yaw search produced this result. */
	search: "local" | "full";
	/**
	 * Set by callers that chain solvers (e.g. solvePose → refinePose): every
	 * candidate pose with its own confidence, best first, including rejected
	 * ones. Useful as seeds for a later stage or as an unverified fallback.
	 */
	candidates?: {
		method: string;
		camera: Camera;
		confidence: number;
		accepted: boolean;
	}[];
}

const DEG = Math.PI / 180;

/** Skyline elevation (deg) at an azimuth, linearly interpolated with wrap. */
export function horizonAt(h: HorizonProfile, azimuth: number) {
	const n = h.elevation.length;
	const t = (((azimuth % 360) + 360) % 360) / h.step;
	const i = Math.floor(t);
	const f = t - i;
	return h.elevation[i % n] * (1 - f) + h.elevation[(i + 1) % n] * f;
}

/**
 * Rows (px) where the DEM skyline crosses each image column under `cam`;
 * NaN where it's out of view. Uses the topmost crossing per column.
 */
export function projectSkylineRows(
	cam: Camera,
	h: HorizonProfile,
	width = Math.round(cam.width),
): Float32Array {
	const c = width === cam.width ? cam : resizeCamera(cam, width);
	const rows = new Float32Array(width).fill(Number.NaN);
	const halfFov = Math.atan(Math.hypot(c.width, c.height) / 2 / c.f) / DEG;
	const n = h.elevation.length;
	let prev: [number, number] | null = null;
	for (let k = 0; k <= n; k++) {
		const i = k % n;
		const az = i * h.step;
		const dAz = Math.abs(((az - c.yaw + 540) % 360) - 180);
		if (dAz > halfFov + 5) {
			prev = null;
			continue;
		}
		const p = project(c, directionENU(az, h.elevation[i]));
		if (p && prev) {
			const [x0, y0] = prev;
			const [x1, y1] = p;
			// Column x covers [x, x+1); sample at its centre, as observations do.
			const lo = Math.max(0, Math.ceil(Math.min(x0, x1) - 0.5));
			const hi = Math.min(width - 1, Math.floor(Math.max(x0, x1) - 0.5));
			for (let x = lo; x <= hi; x++) {
				const t = x1 === x0 ? 0 : (x + 0.5 - x0) / (x1 - x0);
				const y = y0 + t * (y1 - y0);
				if (!(rows[x] <= y)) rows[x] = y;
			}
		}
		prev = p;
	}
	return rows;
}

interface Obs {
	x: number;
	y: number;
	w: number;
}

function observations(sky: SkylineRows, stride: number): Obs[] {
	const out: Obs[] = [];
	for (let x = 0; x < sky.width; x += stride) {
		const y = sky.rows[x];
		const w = sky.weight[x];
		if (Number.isFinite(y) && w > 0.05) out.push({ x: x + 0.5, y, w });
	}
	return out;
}

/**
 * Per-observation residual in px: (observed elevation − DEM skyline) × f.
 * `pxPerRad` must stay fixed while solving f, or shrinking f "wins".
 */
function residualsPx(
	cam: Camera,
	obs: Obs[],
	h: HorizonProfile,
	pxPerRad: number,
) {
	return obs.map((o) => {
		const [az, el] = azimuthElevation(unproject(cam, o.x, o.y));
		return (el - horizonAt(h, az)) * DEG * pxPerRad;
	});
}

export function solvePose(
	prior: Camera,
	horizon: HorizonProfile,
	sky: SkylineRows,
	opts: SolveOptions = {},
): SolveResult {
	const sigma = opts.sigma ?? DEFAULT_SIGMA;
	const fullOpts = (o: SolveOptions): SolveOptions => ({
		...o,
		yawRange: 180,
		sigma: { ...sigma, yaw: 1e6 },
		// A full-circle search finds false matches on repetitive ridges far
		// more easily, so it always gets the stricter bar unless the caller
		// sets one explicitly. (A 360° first pass at the local 0.5 bar
		// accepted IMG_7053 at −123.7° in the wild benchmark.)
		acceptConfidence:
			o.acceptConfidence ?? o.fullSearchConfidence ?? FULL_SEARCH_CONFIDENCE,
	});
	if (opts.headingKnown === false || (opts.yawRange ?? 25) >= 90)
		return solveOnce(prior, horizon, sky, fullOpts(opts), "full");

	const local = solveOnce(prior, horizon, sky, opts, "local");
	if (
		local.accepted ||
		local.rejectReason === "no-skyline" ||
		opts.fullSearchFallback === false
	)
		return local;
	const full = solveOnce(
		prior,
		horizon,
		sky,
		// The local threshold must not leak into the fallback.
		fullOpts({ ...opts, acceptConfidence: undefined }),
		"full",
	);
	return full.accepted || full.confidence > local.confidence ? full : local;
}

const DEFAULT_SIGMA = { yaw: 15, pitch: 1.5, roll: 1.5, focal: 0.06 };
const FULL_SEARCH_CONFIDENCE = 0.75;

function solveOnce(
	prior: Camera,
	horizon: HorizonProfile,
	sky: SkylineRows,
	opts: SolveOptions,
	search: "local" | "full",
): SolveResult {
	const yawRange = opts.yawRange ?? 25;
	const pitchRange = opts.pitchRange ?? 3;
	const sigma = opts.sigma ?? DEFAULT_SIGMA;
	const tiltGate = opts.tiltGate ?? 3;
	const acceptConfidence = opts.acceptConfidence ?? 0.5;
	const inlierPx = opts.inlierPx ?? 4;
	const solveFocal = opts.solveFocal ?? true;

	const cam0 = resizeCamera(prior, sky.width);
	const obs = observations(sky, 1);
	const coverage = obs.length / sky.width;
	const empty: SolveResult = {
		camera: prior,
		confidence: 0,
		accepted: false,
		rejectReason: "no-skyline",
		residualPx: Number.NaN,
		inlierFraction: 0,
		coverage,
		ambiguity: 1,
		horizonRelief: 0,
		delta: { yaw: 0, pitch: 0, roll: 0, focal: 1 },
		coarse: { yaw: 0, pitch: 0 },
		search,
	};
	if (obs.length < sky.width * 0.1) return empty;

	// --- Coarse: small-angle grid over (dYaw, dPitch). ---
	const coarse = obs.filter((_, i) => i % 2 === 0);
	const ae = coarse.map((o) => azimuthElevation(unproject(cam0, o.x, o.y)));
	const degPerPx = 1 / (cam0.f * DEG);
	const trunc = 12 * degPerPx; // truncated-L1 cutoff: ~12 px
	const yawStep = Math.max(0.1, 1.5 * degPerPx);
	const pitchStep = Math.max(0.1, 1.5 * degPerPx);
	const wSum = coarse.reduce((s, o) => s + o.w, 0);
	const coarseCost = (dy: number, dp: number) => {
		let c = 0;
		for (let i = 0; i < ae.length; i++) {
			const r = Math.abs(ae[i][1] + dp - horizonAt(horizon, ae[i][0] + dy));
			c += coarse[i].w * Math.min(r, trunc);
		}
		return (
			c / wSum +
			0.02 * trunc * ((dy / sigma.yaw) ** 2 + (dp / sigma.pitch) ** 2)
		);
	};
	const yawCosts: { dy: number; dp: number; c: number }[] = [];
	for (let dy = -yawRange; dy <= yawRange + 1e-9; dy += yawStep) {
		let best = { dy, dp: 0, c: Number.POSITIVE_INFINITY };
		for (let dp = -pitchRange; dp <= pitchRange + 1e-9; dp += pitchStep) {
			const c = coarseCost(dy, dp);
			if (c < best.c) best = { dy, dp, c };
		}
		yawCosts.push(best);
	}
	// Local minima in yaw, best first.
	const minima = yawCosts
		.filter(
			(v, i) =>
				(i === 0 || v.c <= yawCosts[i - 1].c) &&
				(i === yawCosts.length - 1 || v.c <= yawCosts[i + 1].c),
		)
		.sort((a, b) => a.c - b.c);
	const seeds: typeof minima = [];
	for (const m of minima) {
		if (seeds.every((s) => Math.abs(s.dy - m.dy) > 1.5)) seeds.push(m);
		if (seeds.length === 3) break;
	}
	// Distinctness of the winning yaw: how far the runner-up minimum (≥2°
	// away) rises above the best, relative to the typical cost level.
	// Foreground columns add a constant truncated cost everywhere, so a plain
	// best/runner-up ratio would sit near 1 even for a sharp match.
	const runnerUp = minima.find((m) => Math.abs(m.dy - minima[0].dy) > 2);
	const sortedCosts = yawCosts.map((v) => v.c).sort((a, b) => a - b);
	const medianCost = sortedCosts[Math.floor(sortedCosts.length / 2)];
	const spread = medianCost - minima[0].c;
	const ambiguity =
		runnerUp && spread > 0
			? Math.max(0, Math.min(1, 1 - (runnerUp.c - minima[0].c) / spread))
			: 0;

	// --- Fine: LM over [yaw, pitch, roll, log f] from each seed. ---
	const fineObs = obs.filter((_, i) => i % 2 === 0);
	const sqrtW = fineObs.map((o) => Math.sqrt(o.w));
	const makeCam = (p: number[]) =>
		cameraFromAngles({
			width: cam0.width,
			height: cam0.height,
			// Clamp: zooming in collapses all columns onto one azimuth (degenerate).
			f: cam0.f * Math.exp(Math.max(-0.08, Math.min(0.08, p[3]))),
			yaw: p[0],
			pitch: p[1],
			roll: p[2],
		});
	const residualFn = (p: number[]) =>
		residualsPx(makeCam(p), fineObs, horizon, cam0.f).map(
			(r, i) => r * sqrtW[i],
		);
	// A one-sigma prior deviation costs as much as every observation being
	// off by 1 px, so the prior holds against many weak data terms.
	const priorScale = Math.sqrt(sqrtW.reduce((s, v) => s + v * v, 0));
	let best: { p: number[]; cost: number } | null = null;
	for (const s of seeds) {
		const start = [cam0.yaw + s.dy, cam0.pitch + s.dp, cam0.roll, 0];
		const res = levenbergMarquardt(residualFn, start, {
			cauchy: inlierPx,
			steps: [1e-3, 1e-3, 1e-3, 1e-4],
			maxIterations: 25,
			prior: {
				mean: [cam0.yaw, cam0.pitch, cam0.roll, 0],
				sigma: [
					sigma.yaw / priorScale,
					sigma.pitch / priorScale,
					sigma.roll / priorScale,
					solveFocal ? sigma.focal / priorScale : 1e-6,
				],
			},
		});
		if (!best || res.cost < best.cost) best = { p: res.params, cost: res.cost };
	}
	if (!best) return empty;

	const cam = makeCam(best.p);
	const r = residualsPx(cam, obs, horizon, cam0.f);
	const inliers = r.filter((v) => Math.abs(v) < inlierPx);
	const inlierFraction = inliers.length / r.length;
	const rms = Math.sqrt(
		inliers.reduce((s, v) => s + v * v, 0) / Math.max(1, inliers.length),
	);

	// Horizon relief over the view: can the skyline shape constrain yaw at all?
	const halfH = Math.atan(cam.width / 2 / cam.f) / DEG;
	const els: number[] = [];
	for (let a = -halfH; a <= halfH; a += 0.25)
		els.push(horizonAt(horizon, cam.yaw + a));
	const mean = els.reduce((s, v) => s + v, 0) / els.length;
	const relief = Math.sqrt(
		els.reduce((s, v) => s + (v - mean) ** 2, 0) / els.length,
	);

	const dPitch = best.p[1] - cam0.pitch;
	const dRoll = best.p[2] - cam0.roll;
	const tilted = Math.abs(dPitch) > tiltGate || Math.abs(dRoll) > tiltGate;
	const confidence =
		(tilted ? 0 : 1) *
		clamp01((inlierFraction - 0.3) / 0.5) *
		clamp01(coverage / 0.4) *
		clamp01((1 - ambiguity) / 0.4 + 0.1) *
		clamp01(relief / 0.5);

	const scaleBack = prior.width / cam.width;
	return {
		camera: resizeCamera(cam, prior.width),
		confidence,
		accepted: confidence >= acceptConfidence,
		rejectReason: tilted
			? "tilt"
			: confidence < acceptConfidence
				? "low-confidence"
				: undefined,
		residualPx: rms * scaleBack,
		inlierFraction,
		coverage,
		ambiguity,
		horizonRelief: relief,
		delta: {
			yaw: ((best.p[0] - cam0.yaw + 540) % 360) - 180,
			pitch: dPitch,
			roll: dRoll,
			focal: Math.exp(best.p[3]),
		},
		coarse: { yaw: minima[0].dy, pitch: minima[0].dp },
		search,
	};
}
