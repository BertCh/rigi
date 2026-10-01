// Eye (camera position) refinement from a detected photo skyline.
//
// For near-field cliff-edge photos the GPS fix (±20–40 m) and the DEM height at that fix are
// the dominant error: a 37 m shift moves a 2 km ridge by ~1°. This module fits the eye offset
// (dE, dN, dU) against the photo skyline by recomputing the DEM horizon at each candidate eye
// (caller-supplied callback, e.g. src/lib/horizon-fast) and re-solving the rotation there
// (variable projection: the cost of an eye is the best cost over yaw/pitch/roll at that eye).
//
// Pure TS, no DOM; the horizon is injected, so this file only depends on pose6dof itself.
import type { Vec3 } from "#/lib/ontology/core/geometry";
import { focalFromVfov, type Pose } from "../camera";
import { wrap180 } from "../geodesy";
import { gaussJordan } from "../linalg";
import { azElFromDir, basis, unproject } from "./project";
import { refinePosition } from "./refine";

export type { Vec3 };

/** A 360° (or sector) DEM skyline: elevation (deg) at azimuth i·step. ≤ −89 = no data. */
export interface EyeHorizon {
	step: number;
	elevation: ArrayLike<number>;
	/** Optional distance (m) per azimuth, used only for diagnostics (near-field fraction). */
	distance?: ArrayLike<number>;
}

/** Observed skyline sample in normalised image coords (u right, v down, 0..1), weight 0..1. */
export interface SkylineSample {
	u: number;
	v: number;
	w?: number;
}

/** Horizon at an absolute eye [E, N, U] (same frame as `eye0`; U in the DEM's vertical datum). */
export type HorizonAtEye = (eye: Vec3) => EyeHorizon | Promise<EyeHorizon>;

/**
 * Batched horizon provider: the horizons at several absolute eyes, in order (e.g. one GPU dispatch,
 * src/lib/gpu/eye). Must return what HorizonAtEye would for each eye.
 */
export type HorizonsAtEyes = (eyes: Vec3[]) => Promise<EyeHorizon[]>;

export interface RotationFitOptions {
	/** Image width / height. */
	aspect: number;
	/** Image height in px: residuals are in px of this height. */
	imageHeight: number;
	/** Cauchy scale, px (default 4). */
	cauchy?: number;
	/** Per-sample noise, px (default 2). */
	sigmaPx?: number;
	/**
	 * Skyline columns are strongly correlated; the data term is scaled so that all samples together
	 * weigh like this many independent `sigmaPx` observations (default 60).
	 */
	effectiveSamples?: number;
	/** Gaussian priors (deg) on yaw / pitch / roll around `priorPose` (default 5 / 3 / 3). */
	rotationSigma?: { yaw?: number; pitch?: number; roll?: number };
	/** Prior mean for the rotation (default: the start pose). */
	priorPose?: Pose;
	/** Inlier threshold for the reported stats, px (default 4). */
	inlierPx?: number;
	maxIterations?: number;
}

export interface SkylineFit {
	pose: Pose;
	/** Normalised robust cost (data + rotation prior), the quantity the eye search minimises. */
	cost: number;
	/** Signed residual per sample, px (observed elevation − DEM skyline, × focal). NaN = no data. */
	residualsPx: number[];
	/** RMS over |r| < inlierPx. */
	rmsInlierPx: number;
	medianAbsPx: number;
	inlierFrac: number;
	/** Weighted mean |r| clipped at 3·cauchy (robust skyline distance), px. */
	meanClippedPx: number;
	iterations: number;
}

const D = Math.PI / 180;

function horizonEl(h: EyeHorizon, az: number) {
	const n = h.elevation.length;
	const t = (((az % 360) + 360) % 360) / h.step;
	const i = Math.floor(t);
	const f = t - i;
	const a = h.elevation[i % n];
	const b = h.elevation[(i + 1) % n];
	if (!(a > -89) || !(b > -89)) return Number.NaN;
	return a * (1 - f) + b * f;
}

/** Residuals (px) of the samples against a horizon under a pose. */
export function skylineResidualsPx(
	samples: SkylineSample[],
	horizon: EyeHorizon,
	pose: Pose,
	aspect: number,
	imageHeight: number,
): number[] {
	const B = basis(pose.yaw, pose.pitch, pose.roll);
	const f = focalFromVfov(pose.vfov, imageHeight);
	return samples.map((s) => {
		const [az, el] = azElFromDir(unproject(pose, aspect, s.u, s.v, B));
		return (el - horizonEl(horizon, az)) * D * f;
	});
}

/**
 * Solves yaw/pitch/roll (vfov held) that best fit the samples to a fixed horizon: Cauchy IRLS
 * Gauss–Newton with LM damping and Gaussian rotation priors. Deterministic for a given start.
 */
export function fitRotationToHorizon(
	samples: SkylineSample[],
	horizon: EyeHorizon,
	start: Pose,
	opts: RotationFitOptions,
): SkylineFit {
	const c = opts.cauchy ?? 4;
	const sig = opts.sigmaPx ?? 2;
	const nEff = opts.effectiveSamples ?? 60;
	const inlierPx = opts.inlierPx ?? 4;
	const rs = opts.rotationSigma ?? {};
	const sR = [rs.yaw ?? 5, rs.pitch ?? 3, rs.roll ?? 3];
	const mean = opts.priorPose ?? start;
	const m = [mean.yaw, mean.pitch, mean.roll];
	const w = samples.map((s) => s.w ?? 1);
	const wSum = w.reduce((a, b) => a + b, 0) || 1;
	// data cost = k · Σ w ρ(r), ρ(r) = c² log(1 + (r/c)²); k normalises to nEff σ-units
	const k = nEff / wSum / (sig * sig);
	const NAN_RHO = c * c * Math.log(1 + 9); // no-data sample costs like a 3c miss
	const resid = (p: number[]) =>
		skylineResidualsPx(
			samples,
			horizon,
			{ yaw: p[0], pitch: p[1], roll: p[2], vfov: start.vfov },
			opts.aspect,
			opts.imageHeight,
		);
	const costOf = (p: number[], r: number[]) => {
		let s = 0;
		for (let i = 0; i < r.length; i++)
			s +=
				w[i] *
				(Number.isFinite(r[i]) ? c * c * Math.log1p((r[i] / c) ** 2) : NAN_RHO);
		let pr = 0;
		for (let a = 0; a < 3; a++) {
			const d = a === 0 ? wrap180(p[a] - m[a]) : p[a] - m[a];
			pr += (d / sR[a]) ** 2;
		}
		return k * s + pr;
	};
	let p = [start.yaw, start.pitch, start.roll];
	let r = resid(p);
	let cost = costOf(p, r);
	let lambda = 1e-3;
	const h = 1e-3;
	let it = 0;
	const maxIt = opts.maxIterations ?? 30;
	for (; it < maxIt; it++) {
		const J: number[][] = [];
		for (let a = 0; a < 3; a++) {
			const q = p.slice();
			q[a] += h;
			const r2 = resid(q);
			J.push(
				r.map((x, i) =>
					Number.isFinite(x) && Number.isFinite(r2[i]) ? (r2[i] - x) / h : 0,
				),
			);
		}
		const A = [
			[0, 0, 0],
			[0, 0, 0],
			[0, 0, 0],
		];
		const g = [0, 0, 0];
		for (let i = 0; i < r.length; i++) {
			if (!Number.isFinite(r[i])) continue;
			// IRLS weight of the Cauchy loss: ρ'(r)/(2r) = 1 / (1 + (r/c)²)
			const wi = (k * w[i]) / (1 + (r[i] / c) ** 2);
			for (let a = 0; a < 3; a++) {
				g[a] += wi * J[a][i] * r[i];
				for (let b = 0; b < 3; b++) A[a][b] += wi * J[a][i] * J[b][i];
			}
		}
		for (let a = 0; a < 3; a++) {
			const d = a === 0 ? wrap180(p[a] - m[a]) : p[a] - m[a];
			g[a] += d / sR[a] ** 2;
			A[a][a] += 1 / sR[a] ** 2;
		}
		let accepted = false;
		let small = false;
		while (lambda < 1e8) {
			const Ad = A.map((row, a) =>
				row.map((x, b) => (a === b ? x * (1 + lambda) + 1e-12 : x)),
			);
			const d = gaussJordan(
				Ad,
				g.map((x) => -x),
				1e-18,
			);
			if (!d) {
				lambda *= 10;
				continue;
			}
			const q = [p[0] + d[0], p[1] + d[1], p[2] + d[2]];
			const r2 = resid(q);
			const c2 = costOf(q, r2);
			if (c2 <= cost) {
				small = Math.max(Math.abs(d[0]), Math.abs(d[1]), Math.abs(d[2])) < 1e-5;
				p = q;
				r = r2;
				cost = c2;
				lambda = Math.max(lambda / 3, 1e-9);
				accepted = true;
				break;
			}
			lambda *= 4;
		}
		if (!accepted || small) break;
	}
	const pose: Pose = {
		yaw: ((p[0] % 360) + 360) % 360,
		pitch: p[1],
		roll: p[2],
		vfov: start.vfov,
	};
	return {
		pose,
		cost,
		residualsPx: r,
		iterations: it + 1,
		...fitStats(r, w, inlierPx, c),
	};
}

function fitStats(r: number[], w: number[], inlierPx: number, c: number) {
	const fin = r.filter(Number.isFinite);
	const abs = fin.map(Math.abs).sort((a, b) => a - b);
	const inl = abs.filter((x) => x < inlierPx);
	let sw = 0;
	let s = 0;
	r.forEach((x, i) => {
		sw += w[i];
		s += w[i] * Math.min(Number.isFinite(x) ? Math.abs(x) : 3 * c, 3 * c);
	});
	return {
		rmsInlierPx: inl.length
			? Math.sqrt(inl.reduce((a, b) => a + b * b, 0) / inl.length)
			: Number.NaN,
		medianAbsPx: abs.length ? abs[Math.floor(abs.length / 2)] : Number.NaN,
		inlierFrac: r.length ? inl.length / r.length : 0,
		meanClippedPx: sw > 0 ? s / sw : Number.NaN,
	};
}

export interface RefineEyeOptions extends RotationFitOptions {
	/** Horizontal GPS σ, m (use the photo's hAccuracy; min 5). */
	sigmaH: number;
	/** Vertical σ of the start eye, m (default 50: GPS altitude and DEM height are both poor on cliffs). */
	sigmaV?: number;
	/** DEM height at a horizontal offset from eye0 (same vertical datum as eye0[2]); enables the ground clamp. */
	ground?: (dE: number, dN: number) => number;
	/** Minimum eye height above `ground`, m (default 1.5). */
	clearance?: number;
	/**
	 * Limits on eye height above `ground` (needs `ground`), so the eye cannot float off a cliff
	 * edge over low ground. Soft: an eye more than `max(height, eye0 height above ground)` m above the
	 * DEM costs (excess / sigma)². Hard: the eye is clamped to ≤ `max(max, eye0 height above ground)`
	 * m above the DEM. Default { height: 1.6, sigma: 3, max: 10 }; false = off (floor clamp only).
	 */
	aboveGround?: { height?: number; sigma?: number; max?: number } | false;
	/**
	 * Coarse grid before LM (default radius min(60, 2σH), step 20, dz [−100,−60,−30,0,30,60,100]);
	 * false = LM from the start eye only.
	 */
	grid?: { radius: number; step: number; dz?: number[] } | false;
	/** Finite-difference step for position, m (default 2; DEM cells are 2–10 m). */
	positionStep?: number;
	/** LM iterations (default 12). */
	maxIterations?: number;
	/** Horizon cache key rounding, m (default 0.25). */
	quantum?: number;
	/** Minimum normalised-cost drop to accept a moved eye (default 2 = a 2σ-ish improvement). */
	minGain?: number;
	/**
	 * Optional batched provider (W6). When set, the start eye plus every grid cell is fetched in one
	 * call, and each LM Jacobian's 6 central-difference probes in one call; the search itself (order,
	 * costs, cache keys, horizonCalls / cacheHits) is unchanged, so the result equals the per-eye
	 * path given the same horizons. `horizonAt` may then be null (single eyes use a batch of one).
	 */
	horizonsAtEyes?: HorizonsAtEyes;
}

export interface RefineEyeResult {
	/** Accepted pose/eye: the refined one if it beat the start by `minGain`, else the start fit. */
	pose: Pose;
	eye: Vec3;
	/** eye − eye0, m (E, N, U), after the ground clamp. */
	shift: Vec3;
	moved: boolean;
	/** Rotation fitted at the start eye (the "before", eye-fixed baseline). */
	before: SkylineFit;
	/** Fit at the refined eye (whether or not it was accepted). */
	after: SkylineFit;
	refinedEye: Vec3;
	/** Best coarse-grid cell (shift, cost) if a grid ran. */
	gridBest?: { shift: Vec3; cost: number };
	/** 1σ from the LM (m), if it ran. */
	sigma: { dx?: number; dy?: number; dz?: number };
	/** True if the result eye sits on the ground clamp. */
	clamped: boolean;
	/** Height of the result eye above `ground`, m (NaN without `ground`). */
	aboveGroundM: number;
	/** Height of the refined eye (`refinedEye`) above `ground`, m (NaN without `ground`). */
	refinedAboveGroundM: number;
	horizonCalls: number;
	cacheHits: number;
	ms: number;
}

/**
 * Refines the eye position (and the rotation, re-solved at every candidate eye) so the DEM skyline
 * matches the detected photo skyline.
 *
 * - `samples`: detected skyline (u, v normalised, weight). 80–400 columns is plenty.
 * - `pose0`: a good starting rotation (e.g. solvePose at the GPS eye); vfov is held.
 * - `eye0`: absolute start eye [E, N, U] in the caller's frame; `horizonAt(eye)` must return the
 *   DEM skyline seen from `eye` (d1's horizon-fast over prebuilt mosaics is ~0.05–0.25 s a call).
 *
 * Cost: (grid cells) + ~7 per LM iteration horizon calls, fewer with the cache (clamped cells
 * collapse onto one key).
 */
export async function refineEyeFromSkyline(
	samples: SkylineSample[],
	pose0: Pose,
	eye0: ArrayLike<number>,
	horizonAt: HorizonAtEye | null,
	opts: RefineEyeOptions,
): Promise<RefineEyeResult> {
	const t0 = performance.now();
	const e0: Vec3 = [eye0[0], eye0[1], eye0[2]];
	const clearance = opts.clearance ?? 1.5;
	const q = opts.quantum ?? 0.25;
	const sigmaH = Math.max(opts.sigmaH, 5);
	const sigmaV = opts.sigmaV ?? 50;
	const minGain = opts.minGain ?? 2;
	const batch = opts.horizonsAtEyes;
	const single: HorizonAtEye | null =
		horizonAt ?? (batch ? async (e) => (await batch([e]))[0] : null);
	if (!single)
		throw new TypeError(
			"refineEyeFromSkyline: pass horizonAt or opts.horizonsAtEyes",
		);
	const cache = new Map<string, Promise<EyeHorizon>>();
	/** Keys filled by a batch prefetch and not yet requested (counted as a call when first requested). */
	const prefetched = new Set<string>();
	let calls = 0;
	let hits = 0;
	const keyOf = (e: Vec3) => e.map((x) => Math.round(x / q)).join(",");
	const horizon = (e: Vec3) => {
		const key = keyOf(e);
		const hit = cache.get(key);
		if (hit) {
			if (prefetched.delete(key)) calls++;
			else hits++;
			return hit;
		}
		calls++;
		const p = Promise.resolve(single(e));
		cache.set(key, p);
		return p;
	};
	/** Batched prefetch of the uncached eyes (no-op without `horizonsAtEyes`); fills the same cache keys. */
	const prefetch = async (es: Vec3[]) => {
		if (!batch) return;
		const need = new Map<string, Vec3>();
		for (const e of es) {
			const key = keyOf(e);
			if (!cache.has(key) && !need.has(key)) need.set(key, e);
		}
		if (!need.size) return;
		const all = batch([...need.values()]);
		let i = 0;
		for (const key of need.keys()) {
			const j = i++;
			const p = all.then((h) => h[j]);
			p.catch(() => {}); // surfaced when the key is requested
			cache.set(key, p);
			prefetched.add(key);
		}
		await all;
	};
	const groundAt = (e: ArrayLike<number>) =>
		opts.ground ? opts.ground(e[0] - e0[0], e[1] - e0[1]) : Number.NaN;
	// Height-above-ground (AGL) limits, relative to max(nominal, start AGL) so a start eye that is
	// already high over a biased DEM is not pulled down: a one-sided soft prior plus a hard cap.
	const agl =
		opts.aboveGround === false || !opts.ground
			? null
			: (opts.aboveGround ?? {});
	const g0 = groundAt(e0);
	const agl0 = Number.isFinite(g0) ? e0[2] - g0 : 0;
	const aglRef = agl ? Math.max(agl.height ?? 1.6, agl0) : 0;
	const aglSigma = agl ? (agl.sigma ?? 3) : 1;
	const aglMax = agl ? Math.max(agl.max ?? 10, agl0) : Number.POSITIVE_INFINITY;
	const clampEye = (e: ArrayLike<number>): Vec3 => {
		const out: Vec3 = [e[0], e[1], e[2]];
		const g = groundAt(e);
		if (Number.isFinite(g))
			out[2] = Math.max(Math.min(out[2], g + aglMax), g + clearance);
		return out;
	};
	/** Residual (σ units, ≥ 0) of the AGL prior at an eye (0 inside the allowance). */
	const aglResid = (e: ArrayLike<number>) => {
		if (!agl) return 0;
		const ec = clampEye(e);
		const g = groundAt(ec);
		return Number.isFinite(g) ? Math.max(0, ec[2] - g - aglRef) / aglSigma : 0;
	};
	const fitOpts: RotationFitOptions = {
		...opts,
		priorPose: opts.priorPose ?? pose0,
	};
	const fitAt = async (e: ArrayLike<number>, start: Pose) =>
		fitRotationToHorizon(samples, await horizon(clampEye(e)), start, fitOpts);

	const grid =
		opts.grid === false
			? null
			: (opts.grid ?? {
					radius: Math.min(60, 2 * sigmaH),
					step: 20,
					dz: [-100, -60, -30, 0, 30, 60, 100],
				});
	// Coarse-grid cells (clamped), in search order.
	const cells: Vec3[] = [];
	if (grid && grid.step > 0) {
		const m = Math.floor(grid.radius / grid.step);
		for (const dz of grid.dz ?? [0])
			for (let i = -m; i <= m; i++)
				for (let j = -m; j <= m; j++) {
					if (i * i + j * j > m * m + 1e-9) continue; // disc
					cells.push(
						clampEye([
							e0[0] + i * grid.step,
							e0[1] + j * grid.step,
							e0[2] + dz,
						]),
					);
				}
	}
	await prefetch([clampEye(e0), ...cells]);

	const before = await fitAt(e0, pose0);
	const posPrior = (e: ArrayLike<number>) =>
		((e[0] - e0[0]) / sigmaH) ** 2 +
		((e[1] - e0[1]) / sigmaH) ** 2 +
		((e[2] - e0[2]) / sigmaV) ** 2 +
		aglResid(e) ** 2;

	// Coarse grid (profiled cost + position prior); rotation re-solved from pose0 at each cell.
	let startEye: Vec3 = e0;
	let startPose = before.pose;
	let gridBest: RefineEyeResult["gridBest"];
	if (grid && grid.step > 0) {
		let best = { e: e0, cost: before.cost, pose: before.pose };
		for (const ec of cells) {
			const f = await fitAt(ec, pose0);
			const c = f.cost + posPrior(ec);
			if (c < best.cost) best = { e: ec, cost: c, pose: f.pose };
		}
		gridBest = {
			shift: [best.e[0] - e0[0], best.e[1] - e0[1], best.e[2] - e0[2]],
			cost: best.cost,
		};
		startEye = best.e;
		startPose = best.pose;
	}

	// LM over the eye on the profiled cost. Residuals are transformed so Σ t² = the Cauchy cost.
	const c = opts.cauchy ?? 4;
	const sig = opts.sigmaPx ?? 2;
	const w = samples.map((s) => s.w ?? 1);
	const wSum = w.reduce((a, b) => a + b, 0) || 1;
	const k = (opts.effectiveSamples ?? 60) / wSum / (sig * sig);
	const NAN_T = c * Math.sqrt(Math.log(10));
	const rs = opts.rotationSigma ?? {};
	const sR = [rs.yaw ?? 5, rs.pitch ?? 3, rs.roll ?? 3];
	const pm = fitOpts.priorPose as Pose;
	const hStep = opts.positionStep ?? 2;
	// refinePosition's Jacobian probes a point p as p+s·x̂ first, then p−s·x̂, p±s·ŷ, p±s·ẑ (central).
	// Seeing p+s·x̂ for an already-evaluated p, fetch the whole set in one batch.
	const evaluated: Vec3[] = [];
	const lmProbe = async (e: Vec3) => {
		if (!batch) return;
		const p = evaluated.find(
			(c) => c[0] + hStep === e[0] && c[1] === e[1] && c[2] === e[2],
		);
		evaluated.push(e);
		if (!p) return;
		const probes: Vec3[] = [];
		const axes = sigmaV === 0 ? 2 : 3; // σV 0 holds dz (refinePosition drops it)
		for (let a = 0; a < axes; a++)
			for (const s of [hStep, -hStep]) {
				const x: Vec3 = [p[0], p[1], p[2]];
				x[a] += s;
				probes.push(clampEye(x));
			}
		await prefetch(probes);
	};
	const lm = await refinePosition(
		{ ...startPose },
		startEye,
		async (_pose, e) => {
			await lmProbe(e);
			const f = await fitAt(e, startPose);
			const t = f.residualsPx.map(
				(r, i) =>
					Math.sqrt(k * w[i]) *
					(Number.isFinite(r)
						? Math.sign(r) * c * Math.sqrt(Math.log1p((r / c) ** 2))
						: NAN_T),
			);
			t.push(
				wrap180(f.pose.yaw - pm.yaw) / sR[0],
				(f.pose.pitch - pm.pitch) / sR[1],
				(f.pose.roll - pm.roll) / sR[2],
			);
			return t;
		},
		{
			params: ["dx", "dy", "dz"],
			priors: { position: { value: e0, sigmaH, sigmaV } },
			steps: {
				dx: opts.positionStep ?? 2,
				dy: opts.positionStep ?? 2,
				dz: opts.positionStep ?? 2,
			},
			central: true,
			maxIterations: opts.maxIterations ?? 12,
		},
	);
	// Pick the better of the LM result and its start (the clamp is outside the LM's view).
	let finalEye = clampEye(lm.eye);
	let after = await fitAt(finalEye, startPose);
	let afterCost = after.cost + posPrior(finalEye);
	const startFit = await fitAt(startEye, pose0);
	const startCost = startFit.cost + posPrior(startEye);
	if (startCost < afterCost) {
		finalEye = startEye;
		after = startFit;
		afterCost = startCost;
	}
	const moved = before.cost - afterCost >= minGain;
	const eye = moved ? finalEye : e0;
	const g = groundAt(eye);
	const gRef = groundAt(finalEye);
	return {
		pose: moved ? after.pose : before.pose,
		eye,
		shift: [eye[0] - e0[0], eye[1] - e0[1], eye[2] - e0[2]],
		moved,
		before,
		after,
		refinedEye: finalEye,
		gridBest,
		sigma: { dx: lm.sigma.dx, dy: lm.sigma.dy, dz: lm.sigma.dz },
		clamped: Number.isFinite(g) && eye[2] <= g + clearance + 1e-6,
		aboveGroundM: eye[2] - g,
		refinedAboveGroundM: finalEye[2] - gRef,
		horizonCalls: calls,
		cacheHits: hits,
		ms: performance.now() - t0,
	};
}
