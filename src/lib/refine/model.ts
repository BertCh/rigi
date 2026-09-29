/**
 * Forward model for skyline-based pose refinement, with analytic Jacobians.
 *
 * State vector p (Float64Array(6)):
 *   [yaw, pitch, roll]  radians (same conventions as geo/camera.ts)
 *   logf                f = f0·exp(logf), f0 = prior focal length (work px)
 *   k                   refraction coefficient (the horizon was traced at REFRACTION_K)
 *   dEye                eye-height offset, metres (+ = camera higher)
 *
 * The camera matrix of geo/camera.ts factorises as c = A(roll)·B(pitch)·L(yaw)·d
 * (derived from cameraFromAngles/cameraFromGravity and checked numerically in
 * scripts/refine-test.ts), so a pixel back-projects in closed form:
 *
 *   X=(x−cx)/f, Y=(y−cy)/f
 *   q = Aᵀ[X,Y,1] = [cρX − sρY, sρX + cρY, 1]
 *   l = Bᵀq       = [q0, cp·q1 − sp, sp·q1 + cp]
 *   azimuth = yaw + atan2(l0, l2),   elevation = atan2(−l1, hypot(l0, l2))
 *
 * Residual per skyline column (px at the working resolution, with a FIXED
 * px-per-radian f0 so that shrinking f can't "win"):
 *
 *   r = f0·(el_photo − H_model(az)),
 *   H_model = H(az) + (k − REFRACTION_K)·d/(2R) − dEye·cos²H/d
 *
 * i.e. r > 0 means the photo skyline is ABOVE the DEM skyline (an occluder).
 */
import { type Camera, cameraFromAngles } from "../geo/camera";
import type { HorizonProfile } from "../geo/horizon";
import { EARTH_R, REFRACTION_K, wrap360 } from "../geodesy";

export const YAW = 0;
export const PITCH = 1;
export const ROLL = 2;
export const LOGF = 3;
export const KREF = 4;
export const DEYE = 5;
export const NPARAM = 6;
export const PARAM_NAMES = [
	"yaw",
	"pitch",
	"roll",
	"logf",
	"k",
	"dEye",
] as const;

export const DEG = Math.PI / 180;

/** Working image geometry: principal point and the fixed px-per-radian f0. */
export interface Geometry {
	width: number;
	height: number;
	cx: number;
	cy: number;
	f0: number;
}

/** One observed skyline column: pixel centre x, sub-pixel row y, weight 0..1. */
export interface Column {
	x: number;
	y: number;
	w: number;
}

/** Horizon profile resampled to Float64 (optionally smoothed) for fast lookups. */
export interface HorizonTable {
	n: number;
	/** Azimuth step, degrees. */
	step: number;
	/** Elevation, radians. */
	el: Float64Array;
	/** Distance to the skyline point, metres. */
	dist: Float64Array;
}

/**
 * Builds a lookup table from a HorizonProfile. `smoothDeg` > 0 applies a
 * circular triangular filter of that half-width (coarse levels only: it
 * widens the convergence basin at the cost of bias on sharp summits).
 */
export function horizonTable(h: HorizonProfile, smoothDeg = 0): HorizonTable {
	const n = h.elevation.length;
	let el = new Float64Array(n);
	for (let i = 0; i < n; i++) el[i] = h.elevation[i] * DEG;
	const r = Math.round(smoothDeg / h.step / 2);
	if (r > 0) {
		for (let pass = 0; pass < 2; pass++) {
			const out = new Float64Array(n);
			let acc = 0;
			for (let j = -r; j <= r; j++) acc += el[(j + n) % n];
			for (let i = 0; i < n; i++) {
				out[i] = acc / (2 * r + 1);
				acc += el[(i + r + 1) % n] - el[(i - r + n) % n];
			}
			el = out;
		}
	}
	return { n, step: h.step, el, dist: Float64Array.from(h.distance) };
}

/** Scratch output of `sampleHorizon`. */
export interface HorizonSample {
	/** Elevation, rad. */
	h: number;
	/** dH/daz, rad/rad (piecewise-linear interpolation slope). */
	slope: number;
	/** Distance, m (linearly interpolated). */
	d: number;
	/** dd/daz, m/rad. */
	dSlope: number;
}

export function sampleHorizon(
	t: HorizonTable,
	azDeg: number,
	out: HorizonSample,
) {
	const u = (((azDeg % 360) + 360) % 360) / t.step;
	const i = Math.floor(u) % t.n;
	const j = (i + 1) % t.n;
	const f = u - Math.floor(u);
	out.h = t.el[i] * (1 - f) + t.el[j] * f;
	out.slope = (t.el[j] - t.el[i]) / (t.step * DEG);
	out.d = t.dist[i] * (1 - f) + t.dist[j] * f;
	out.dSlope = (t.dist[j] - t.dist[i]) / (t.step * DEG);
	return out;
}

/** Per-column evaluation result (scratch object, reused). */
export interface ColumnEval {
	/** Residual, px (f0 units). > 0: photo skyline above the DEM. */
	r: number;
	/** Azimuth, degrees 0..360. */
	az: number;
	/** Photo elevation of the column's skyline pixel, rad. */
	el: number;
	/** Model DEM elevation at az, rad. */
	H: number;
	/** Slope of the DEM skyline at az, rad/rad. */
	slope: number;
	/** Distance to the DEM skyline point, m. */
	d: number;
}

export const newEval = (): ColumnEval => ({
	r: 0,
	az: 0,
	el: 0,
	H: 0,
	slope: 0,
	d: 0,
});

const hs: HorizonSample = { h: 0, slope: 0, d: 0, dSlope: 0 };
/** Minimum distance used in 1/d terms, m (guards the foreground). */
const MIN_D = 30;

/**
 * Residual of one column and (optionally) its analytic Jacobian row
 * ∂r/∂p (length NPARAM, written into `J`).
 */
export function evalColumn(
	p: ArrayLike<number>,
	g: Geometry,
	t: HorizonTable,
	c: Column,
	out: ColumnEval,
	J?: Float64Array,
): ColumnEval {
	const f = g.f0 * Math.exp(p[LOGF]);
	const X = (c.x - g.cx) / f;
	const Y = (c.y - g.cy) / f;
	const cr = Math.cos(p[ROLL]);
	const sr = Math.sin(p[ROLL]);
	const cp = Math.cos(p[PITCH]);
	const sp = Math.sin(p[PITCH]);
	const q0 = cr * X - sr * Y;
	const q1 = sr * X + cr * Y;
	const l0 = q0;
	const l1 = cp * q1 - sp;
	const l2 = sp * q1 + cp;
	const hh2 = l0 * l0 + l2 * l2;
	const hh = Math.sqrt(hh2);
	const azRel = Math.atan2(l0, l2);
	const el = Math.atan2(-l1, hh);
	const azDeg = (p[YAW] + azRel) / DEG;
	sampleHorizon(t, azDeg, hs);
	const d = Math.max(MIN_D, hs.d);
	const dd = hs.d > MIN_D ? hs.dSlope : 0;
	const cos2 = Math.cos(hs.h) ** 2;
	const dk = p[KREF] - REFRACTION_K;
	const H = hs.h + (dk * d) / (2 * EARTH_R) - (p[DEYE] * cos2) / d;
	// dH_model/daz by the chain rule through H, cos²H and d.
	const Hs =
		hs.slope * (1 + (p[DEYE] * 2 * Math.cos(hs.h) * Math.sin(hs.h)) / d) +
		(dk * dd) / (2 * EARTH_R) +
		(p[DEYE] * cos2 * dd) / (d * d);
	out.r = g.f0 * (el - H);
	out.az = ((azDeg % 360) + 360) % 360;
	out.el = el;
	out.H = H;
	out.slope = hs.slope;
	out.d = d;
	if (J) {
		// For a perturbation (a0, a1, a2) of l:
		//   d(azRel) = (l2·a0 − l0·a2)/h²
		//   d(el)    = (−h·a1 + l1·(l0·a0 + l2·a2)/h)/(h² + l1²)
		// and ∂r = f0·(d(el) − H_model'·d(azRel)). Inlined (hot path).
		const den = hh2 + l1 * l1;
		const k1 = g.f0 / den;
		const k2 = (g.f0 * Hs) / hh2;
		const lh = l1 / hh;
		// pitch: a = (0, −l2, l1)
		J[PITCH] = k1 * (hh * l2 + lh * (l2 * l1)) - k2 * (-l0 * l1);
		// roll: a = (−q1, cp·q0, sp·q0)
		let a0 = -q1;
		let a1 = cp * q0;
		let a2 = sp * q0;
		J[ROLL] =
			k1 * (-hh * a1 + lh * (l0 * a0 + l2 * a2)) - k2 * (l2 * a0 - l0 * a2);
		// log f: a = (−q0, −cp·q1, −sp·q1)
		a0 = -q0;
		a1 = -cp * q1;
		a2 = -sp * q1;
		J[LOGF] =
			k1 * (-hh * a1 + lh * (l0 * a0 + l2 * a2)) - k2 * (l2 * a0 - l0 * a2);
		J[YAW] = -g.f0 * Hs;
		J[KREF] = (-g.f0 * d) / (2 * EARTH_R);
		J[DEYE] = (g.f0 * cos2) / d;
	}
	return out;
}

/** Error-model inputs (all 1σ). */
export interface ErrorModel {
	/** Skyline detection noise, px at the working resolution. */
	sigmaPx: number;
	/** DEM vertical error (plus any unmodelled eye-height error), m. */
	sigmaZ: number;
	/** Refraction coefficient uncertainty. */
	sigmaK: number;
	/** Horizontal camera position error, m. */
	sigmaXY: number;
}

/**
 * σ_u² = σ_px² + (f·σ_z/d)² + (f·σ_k·d/2R)² + (f·σ_xy·|slope|/d)², in px.
 * Near ridges get large σ from DEM and GPS error; far ones from refraction.
 */
export function columnSigma(
	m: ErrorModel,
	f0: number,
	d: number,
	slope: number,
) {
	const dd = Math.max(MIN_D, d);
	const a = (f0 * m.sigmaZ) / dd;
	const b = (f0 * m.sigmaK * dd) / (2 * EARTH_R);
	const c = (f0 * m.sigmaXY * Math.min(5, Math.abs(slope))) / dd;
	return Math.sqrt(m.sigmaPx * m.sigmaPx + a * a + b * b + c * c);
}

/** State vector for a camera; f0 is the reference focal length (same resolution as cam). */
export function paramsFromCamera(cam: Camera, f0 = cam.f): Float64Array {
	const p = new Float64Array(NPARAM);
	p[YAW] = cam.yaw * DEG;
	p[PITCH] = cam.pitch * DEG;
	p[ROLL] = cam.roll * DEG;
	p[LOGF] = Math.log(cam.f / f0);
	p[KREF] = REFRACTION_K;
	p[DEYE] = 0;
	return p;
}

/** Camera at `ref`'s resolution for state p (f = ref.f·exp(logf)). */
export function cameraFromParams(p: ArrayLike<number>, ref: Camera): Camera {
	return cameraFromAngles({
		width: ref.width,
		height: ref.height,
		f: ref.f * Math.exp(p[LOGF]),
		yaw: wrap360(p[YAW] / DEG),
		pitch: p[PITCH] / DEG,
		roll: p[ROLL] / DEG,
	});
}

/** Columns from a skyline observation (NaN / weak columns dropped). */
export function columnsFromSkyline(
	sky: { rows: ArrayLike<number>; weight: ArrayLike<number>; width: number },
	minWeight = 0.05,
): Column[] {
	const out: Column[] = [];
	for (let x = 0; x < sky.width; x++) {
		const y = sky.rows[x];
		const w = sky.weight[x];
		if (Number.isFinite(y) && w > minWeight) out.push({ x: x + 0.5, y, w });
	}
	return out;
}
