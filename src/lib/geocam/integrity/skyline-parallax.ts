// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * Skyline parallax: a wrong-EYE test (tools/research/geo/skypar/PROTOCOL.txt). Pure CPU, not wired, no flag.
 *
 * A far skyline cannot see the eye only when every skyline point is at about the same depth. When the skyline
 * mixes depths, an eye error leaves a residual proportional to 1/d per column that rotation cannot absorb.
 * The photo's skyline row per column is compared with the DEM horizon projected with the hypothesis' pose;
 * a Huber fit of  r = p0 + p1 (x - cx) + p2 s + g . t  (pitch, roll, yaw nuisances; t = true eye minus
 * hypothesis eye, ENU metres) gives chi2 of the three eye terms and the implied displacement.
 */
import { focalFromVfov, type Pose, poseBasis } from "../../camera";
import { DEG } from "../../geodesy";
import type { Vec3 } from "../../linalg";

/** Constants frozen in the protocol; do not tune. */
export const SKYPAR = {
	huberK: 1.345,
	madFloorPx: 0.5,
	iterations: 40,
	minColumns: 60,
	/** P90 - P10 of 1/d (1/m) below which the skyline has no depth diversity: 1/8 km - 1/40 km. */
	minInvDepthSpread: 1 / 8000 - 1 / 40000,
	minDisplacementM: 50,
	/** chi2_3 at 0.999. */
	chi2Reject: 16.2662,
	slopeHalfWindow: 2,
} as const;

export interface HorizonSamples {
	/** Azimuth step (deg); sample i is at azimuth i * step. */
	step: number;
	/** Apparent elevation (deg) per azimuth, <= -89 where there is no terrain. */
	elevation: ArrayLike<number>;
	/** Distance (m) of the skyline point per azimuth. */
	distance: ArrayLike<number>;
}

export interface PredictedSkyline {
	width: number;
	height: number;
	/** Predicted skyline row per column, NaN where the horizon does not cross the column. */
	row: Float64Array;
	/** d row / d column (central difference), NaN where undefined. */
	slope: Float64Array;
	/** 1/d (1/m) of the skyline point per column. */
	invDistance: Float64Array;
	/** Azimuth (deg) and apparent elevation (deg) of the skyline point per column. */
	azimuth: Float64Array;
	elevation: Float64Array;
}

interface PixelCamera {
	f: number;
	cx: number;
	cy: number;
	forward: Vec3;
	right: Vec3;
	up: Vec3;
}

function pixelCamera(pose: Pose, width: number, height: number): PixelCamera {
	return {
		f: focalFromVfov(pose.vfov, height),
		cx: width / 2,
		cy: height / 2,
		...poseBasis(pose),
	};
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function directionEnu(azimuthDeg: number, elevationDeg: number): Vec3 {
	const a = azimuthDeg * DEG;
	const e = elevationDeg * DEG;
	return [Math.sin(a) * Math.cos(e), Math.cos(a) * Math.cos(e), Math.sin(e)];
}

/** Pixel of the vector `v` (ENU, from the eye), or null when behind the camera. */
function projectVector(cam: PixelCamera, v: Vec3): [number, number] | null {
	const z = dot(v, cam.forward);
	if (z <= 1e-9) return null;
	return [
		cam.cx + (cam.f * dot(v, cam.right)) / z,
		cam.cy - (cam.f * dot(v, cam.up)) / z,
	];
}

/**
 * Pixel Jacobian of a fixed world point with respect to the eye: (dx, dy) per metre of eye motion along E, N, U
 * (exact pinhole derivative; v = X - eye, so dv = -dEye). Unit-tested against finite differences.
 */
export function eyePixelJacobian(
	pose: Pose,
	width: number,
	height: number,
	v: Vec3,
): { dx: Vec3; dy: Vec3 } | null {
	const cam = pixelCamera(pose, width, height);
	const z = dot(v, cam.forward);
	if (z <= 1e-9) return null;
	const a = dot(v, cam.right);
	const b = dot(v, cam.up);
	const dx: Vec3 = [0, 0, 0];
	const dy: Vec3 = [0, 0, 0];
	for (let k = 0; k < 3; k++) {
		// moving the eye by +1 m along axis k: dv = -e_k
		const da = -cam.right[k];
		const db = -cam.up[k];
		const dz = -cam.forward[k];
		dx[k] = cam.f * (da / z - (a * dz) / (z * z));
		dy[k] = -cam.f * (db / z - (b * dz) / (z * z));
	}
	return { dx, dy };
}

/** Row change at a fixed column per metre of eye motion: dy - s dx, for a skyline of local slope `slope`. */
export function eyeRowJacobian(
	pose: Pose,
	width: number,
	height: number,
	v: Vec3,
	slope: number,
): Vec3 | null {
	const j = eyePixelJacobian(pose, width, height, v);
	if (!j) return null;
	return [
		j.dy[0] - slope * j.dx[0],
		j.dy[1] - slope * j.dx[1],
		j.dy[2] - slope * j.dx[2],
	];
}

/** Projects a DEM horizon (elevation + distance per azimuth) with `pose` into one predicted row per column. */
export function predictSkylineColumns(
	horizon: HorizonSamples,
	pose: Pose,
	width: number,
	height: number,
	azimuthRange?: [number, number],
): PredictedSkyline {
	const cam = pixelCamera(pose, width, height);
	const n = Math.round(360 / horizon.step);
	const row = new Float64Array(width).fill(Number.NaN);
	const invDistance = new Float64Array(width).fill(Number.NaN);
	const azimuth = new Float64Array(width).fill(Number.NaN);
	const elevation = new Float64Array(width).fill(Number.NaN);
	const pts: ([number, number] | null)[] = new Array(n);
	const project = (k: number) => {
		if (pts[k] !== undefined) return pts[k];
		pts[k] =
			horizon.elevation[k] > -89 && horizon.distance[k] > 0
				? projectVector(
						cam,
						directionEnu(k * horizon.step, horizon.elevation[k]).map(
							(c) => c * horizon.distance[k],
						) as Vec3,
					)
				: null;
		return pts[k];
	};
	let i0 = 0;
	let i1 = n;
	if (azimuthRange) {
		// restrict to the sector in front of the camera (the caller knows the FOV)
		i0 = Math.floor(azimuthRange[0] / horizon.step);
		i1 = Math.ceil(azimuthRange[1] / horizon.step);
	}
	for (let i = i0; i < i1; i++) {
		const ii = ((i % n) + n) % n;
		const p = project(ii);
		const next = (ii + 1) % n;
		const q = project(next);
		if (!p || !q) continue;
		const x0 = p[0];
		const x1 = q[0];
		if (Math.abs(x1 - x0) < 1e-9) continue;
		const lo = Math.max(0, Math.ceil(Math.min(x0, x1)));
		const hi = Math.min(width - 1, Math.floor(Math.max(x0, x1)));
		const d0 = 1 / horizon.distance[ii];
		const d1 = 1 / horizon.distance[next];
		for (let x = lo; x <= hi; x++) {
			const t = (x - x0) / (x1 - x0);
			const y = p[1] + t * (q[1] - p[1]);
			if (!(Number.isNaN(row[x]) || y < row[x])) continue;
			row[x] = y;
			invDistance[x] = d0 + t * (d1 - d0);
			let azDeg = (ii + t) * horizon.step;
			if (azDeg >= 360) azDeg -= 360;
			azimuth[x] = azDeg;
			elevation[x] =
				horizon.elevation[ii] +
				t * (horizon.elevation[next] - horizon.elevation[ii]);
		}
	}
	const slope = new Float64Array(width).fill(Number.NaN);
	const h = SKYPAR.slopeHalfWindow;
	for (let x = 0; x < width; x++) {
		if (Number.isNaN(row[x])) continue;
		const a = x - h >= 0 && !Number.isNaN(row[x - h]) ? x - h : x;
		const b = x + h < width && !Number.isNaN(row[x + h]) ? x + h : x;
		if (a !== b) slope[x] = (row[b] - row[a]) / (b - a);
	}
	return { width, height, row, slope, invDistance, azimuth, elevation };
}

export type SkyparAbstain =
	| "too-few-columns"
	| "no-depth-diversity"
	| "singular";

export interface SkyparResult {
	abstain: SkyparAbstain | null;
	reject: boolean;
	nValid: number;
	/** P90(1/d) - P10(1/d) over valid columns, 1/m. */
	invDepthSpread: number;
	/** chi2 of the three eye terms (NaN when abstained). */
	chi2Eye: number;
	/** delta-hat = hypothesis eye - fitted true eye, ENU metres. */
	deltaM: Vec3;
	deltaNormM: number;
	/** Robust residual scale (px). */
	scalePx: number;
	/** Nuisance fit [p0 (px), p1 (px/px), p2 (px/slope)]. */
	nuisance: Vec3;
	/** Median |residual| (px) after the fit over valid columns. */
	medianAbsResidualPx: number;
}

function quantileSorted(a: number[], q: number) {
	const i = (a.length - 1) * q;
	const lo = Math.floor(i);
	return a[lo] + (a[Math.min(a.length - 1, lo + 1)] - a[lo]) * (i - lo);
}

const median = (a: number[]) =>
	quantileSorted(
		[...a].sort((x, y) => x - y),
		0.5,
	);

/** Solves the symmetric positive-definite system A x = b (n small) by Gaussian elimination; null if singular. */
function solveLinear(a: number[][], b: number[]): number[] | null {
	const n = b.length;
	const m = a.map((r, i) => [...r, b[i]]);
	for (let c = 0; c < n; c++) {
		let p = c;
		for (let r = c + 1; r < n; r++)
			if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
		if (Math.abs(m[p][c]) < 1e-14) return null;
		[m[c], m[p]] = [m[p], m[c]];
		for (let r = 0; r < n; r++) {
			if (r === c) continue;
			const k = m[r][c] / m[c][c];
			for (let j = c; j <= n; j++) m[r][j] -= k * m[c][j];
		}
	}
	return m.map((r, i) => r[n] / r[i]);
}

function invert(a: number[][]): number[][] | null {
	const n = a.length;
	const cols: number[][] = [];
	for (let j = 0; j < n; j++) {
		const e = new Array(n).fill(0);
		e[j] = 1;
		const x = solveLinear(a, e);
		if (!x) return null;
		cols.push(x);
	}
	return a.map((_, i) => cols.map((c) => c[i]));
}

/** chi2 of a 3-vector under covariance `c` (3x3), or NaN. */
function quadForm3(v: Vec3, c: number[][]): number {
	const ci = invert(c);
	if (!ci) return Number.NaN;
	let s = 0;
	for (let i = 0; i < 3; i++)
		for (let j = 0; j < 3; j++) s += v[i] * ci[i][j] * v[j];
	return s;
}

/**
 * The skyline-parallax test. `photoRow` is the photo's skyline row per column (NaN where absent), on the same
 * W x H pixel grid as `predicted`.
 */
export function skylineParallax(
	photoRow: ArrayLike<number>,
	predicted: PredictedSkyline,
	pose: Pose,
): SkyparResult {
	const { width, height } = predicted;
	const cam = pixelCamera(pose, width, height);
	type Col = { r: number; a: number[]; inv: number };
	const cols: Col[] = [];
	for (let x = 0; x < width; x++) {
		const y = photoRow[x];
		const s = predicted.slope[x];
		const inv = predicted.invDistance[x];
		if (!Number.isFinite(y) || !Number.isFinite(s) || !Number.isFinite(inv))
			continue;
		const d = 1 / inv;
		const v = directionEnu(predicted.azimuth[x], predicted.elevation[x]).map(
			(c) => c * d,
		) as Vec3;
		const g = eyeRowJacobian(pose, width, height, v, s);
		if (!g) continue;
		cols.push({
			r: y - predicted.row[x],
			a: [1, x - cam.cx, s, g[0], g[1], g[2]],
			inv,
		});
	}
	const empty: SkyparResult = {
		abstain: null,
		reject: false,
		nValid: cols.length,
		invDepthSpread: Number.NaN,
		chi2Eye: Number.NaN,
		deltaM: [Number.NaN, Number.NaN, Number.NaN],
		deltaNormM: Number.NaN,
		scalePx: Number.NaN,
		nuisance: [Number.NaN, Number.NaN, Number.NaN],
		medianAbsResidualPx: Number.NaN,
	};
	if (cols.length < SKYPAR.minColumns)
		return { ...empty, abstain: "too-few-columns" };
	const invs = cols.map((c) => c.inv).sort((p, q) => p - q);
	const spread = quantileSorted(invs, 0.9) - quantileSorted(invs, 0.1);
	if (spread < SKYPAR.minInvDepthSpread)
		return { ...empty, invDepthSpread: spread, abstain: "no-depth-diversity" };

	const P = 6;
	let weights = cols.map(() => 1);
	let theta: number[] = new Array(P).fill(0);
	let scale = 1;
	let info: number[][] = [];
	for (let it = 0; it < SKYPAR.iterations; it++) {
		const ata = Array.from({ length: P }, () => new Array(P).fill(0));
		const atb = new Array(P).fill(0);
		cols.forEach((c, k) => {
			const w = weights[k];
			for (let i = 0; i < P; i++) {
				atb[i] += w * c.a[i] * c.r;
				for (let j = 0; j < P; j++) ata[i][j] += w * c.a[i] * c.a[j];
			}
		});
		const sol = solveLinear(ata, atb);
		if (!sol) return { ...empty, invDepthSpread: spread, abstain: "singular" };
		theta = sol;
		info = ata;
		const res = cols.map(
			(c) => c.r - c.a.reduce((s, ai, i) => s + ai * theta[i], 0),
		);
		scale = Math.max(
			SKYPAR.madFloorPx,
			1.4826 * median(res.map((r) => Math.abs(r))),
		);
		weights = res.map((r) => {
			const u = Math.abs(r) / scale;
			return u <= SKYPAR.huberK ? 1 : SKYPAR.huberK / u;
		});
	}
	const cov = invert(info);
	if (!cov) return { ...empty, invDepthSpread: spread, abstain: "singular" };
	const covEye = [3, 4, 5].map((i) =>
		[3, 4, 5].map((j) => cov[i][j] * scale * scale),
	);
	const t: Vec3 = [theta[3], theta[4], theta[5]];
	const chi2Eye = quadForm3(t, covEye);
	const deltaM: Vec3 = [-t[0], -t[1], -t[2]];
	const deltaNormM = Math.hypot(...deltaM);
	const finalRes = cols.map((c) =>
		Math.abs(c.r - c.a.reduce((s, ai, i) => s + ai * theta[i], 0)),
	);
	return {
		abstain: null,
		reject: chi2Eye > SKYPAR.chi2Reject && deltaNormM > SKYPAR.minDisplacementM,
		nValid: cols.length,
		invDepthSpread: spread,
		chi2Eye,
		deltaM,
		deltaNormM,
		scalePx: scale,
		nuisance: [theta[0], theta[1], theta[2]],
		medianAbsResidualPx: median(finalRes),
	};
}
