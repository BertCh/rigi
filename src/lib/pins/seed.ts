// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * Seeded pin solve (opt-in, `?pinSolve=seeded`): a closed-form start for `align.ts solvePins`, so a tap
 * solves even when the shown pose is far off, plus a lens bound.
 *
 * `solvePins` starts Levenberg–Marquardt from the shown pose. Past ~90° of yaw the summits project
 * behind that camera, the residual is a flat [10, 10] plateau and the prior comes back unchanged;
 * with ≥ 3 pins and vfov free, starts 50–70° off run vfov away (negative or > 300° seen in a
 * synthetic sweep, reports/archive/steps-2026-10-02/tap-a-peak.md). Here:
 *
 * - vfov (≥ 3 pins, vfov solved): from the widest pair, the lens at which the two tap rays are as far
 *   apart as the two summits (rotation-free), the root nearest the prior's vfov.
 * - 1 pin: yaw + pitch so the tap ray hits the summit (roll and vfov kept, as `solvePins` keeps them).
 * - ≥ 2 pins: the full rotation from the two pins farthest apart on screen (TRIAD, Black 1964).
 *
 * Then `solvePins` runs from the seed, and the result is kept only when it is sane (finite, vfov in
 * [VFOV_MIN, VFOV_MAX]) and fits the taps at least as well as `solvePins` from the prior. `align.ts` is
 * not changed, so the eval GT (`scripts/eval-app.mjs` solves GT with `solvePins`) is bit-identical.
 */
import { type Pin, solvePins } from "#/lib/align";
import {
	anglesFromAxes,
	type Pose,
	poseBasis,
	unprojectDir,
} from "#/lib/camera";
import { getFlag } from "#/lib/flags";
import { DEG as D } from "#/lib/geodesy";
import { pinResidualsPx } from "./diagnostics";

export const VFOV_MIN = 5;
export const VFOV_MAX = 120;

type V3 = [number, number, number];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [
	a[1] * b[2] - a[2] * b[1],
	a[2] * b[0] - a[0] * b[2],
	a[0] * b[1] - a[1] * b[0],
];
const norm = (a: V3): V3 => {
	const s = 1 / (Math.hypot(a[0], a[1], a[2]) || 1);
	return [a[0] * s, a[1] * s, a[2] * s];
};
const angDeg = (a: V3, b: V3) =>
	Math.acos(Math.max(-1, Math.min(1, dot(a, b)))) / D;

const worldDir = (eye: ArrayLike<number>, w: ArrayLike<number>): V3 =>
	norm([w[0] - eye[0], w[1] - eye[1], w[2] - eye[2]]);

/**
 * Tap ray in the right-handed camera frame (right, forward, up) for tan(vfov/2) = t: the same
 * pixel model as `camera unprojectDir`, with forward second so that a rotation maps it to ENU.
 */
function camRay(u: number, v: number, t: number, aspect: number): V3 {
	return norm([(u * 2 - 1) * t * aspect, 1, (1 - v * 2) * t]);
}

/**
 * The vfov (deg) at which the two tap rays of a pin pair are as far apart as their summits, the root
 * nearest `near`; null when no lens in [VFOV_MIN, VFOV_MAX] fits (then the pair is inconsistent).
 */
export function vfovFromPair(
	a: Pin,
	b: Pin,
	eye: ArrayLike<number>,
	aspect: number,
	near: number,
): number | null {
	const target = angDeg(worldDir(eye, a.world), worldDir(eye, b.world));
	const f = (vf: number) => {
		const t = Math.tan((vf * D) / 2);
		return (
			angDeg(camRay(a.u, a.v, t, aspect), camRay(b.u, b.v, t, aspect)) - target
		);
	};
	let best: number | null = null;
	const step = 0.5;
	let x0 = VFOV_MIN;
	let f0 = f(x0);
	for (let x1 = VFOV_MIN + step; x1 <= VFOV_MAX + 1e-9; x1 += step) {
		const f1 = f(x1);
		if (f0 === 0 || f0 * f1 < 0) {
			// bisect the bracket
			let lo = x0;
			let hi = x1;
			let flo = f0;
			for (let k = 0; k < 40 && f0 !== 0; k++) {
				const mid = (lo + hi) / 2;
				const fm = f(mid);
				if (flo * fm <= 0) hi = mid;
				else {
					lo = mid;
					flo = fm;
				}
			}
			const root = f0 === 0 ? x0 : (lo + hi) / 2;
			if (best === null || Math.abs(root - near) < Math.abs(best - near))
				best = root;
		}
		x0 = x1;
		f0 = f1;
	}
	// a root exactly at the top of the range
	if (best === null && f0 === 0) best = x0;
	return best;
}

/** `yaw` moved by whole turns to lie within 180° of `ref` (solvePins keeps yaw unwrapped near its start). */
const unwrapNear = (yaw: number, ref: number) =>
	ref + ((((yaw - ref) % 360) + 540) % 360) - 180;

/** Index pair of the two pins farthest apart on screen. */
function widestPair(pins: Pin[], aspect: number): [number, number] {
	let best: [number, number] = [0, 1];
	let d = -1;
	for (let i = 0; i < pins.length; i++)
		for (let j = i + 1; j < pins.length; j++) {
			const dd = Math.hypot(
				(pins[i].u - pins[j].u) * aspect,
				pins[i].v - pins[j].v,
			);
			if (dd > d) {
				d = dd;
				best = [i, j];
			}
		}
	return best;
}

/**
 * Yaw / pitch turned by the minimal rotation that takes the pin's tap ray (under `from`) onto its
 * summit; roll and vfov stay `from`'s. Exact when roll is 0 and the tap is central, so it is iterated.
 */
function turnToward(
	from: Pose,
	aspect: number,
	eye: ArrayLike<number>,
	p: Pin,
): Pose {
	const ray = unprojectDir(from, aspect, p.u, p.v) as V3;
	const w = worldDir(eye, p.world);
	const { forward } = poseBasis(from);
	const axis = cross(ray, w);
	const s = Math.hypot(axis[0], axis[1], axis[2]);
	const c = dot(ray, w);
	let f2: V3 = forward;
	if (s > 1e-12) {
		const k = norm(axis);
		const ang = Math.atan2(s, c);
		// Rodrigues
		const kxf = cross(k, forward);
		const kdf = dot(k, forward);
		const ca = Math.cos(ang);
		const sa = Math.sin(ang);
		f2 = [0, 1, 2].map(
			(n) => forward[n] * ca + kxf[n] * sa + k[n] * kdf * (1 - ca),
		) as V3;
	} else if (c < 0) {
		// summit exactly behind the tap ray: turn around
		f2 = [-forward[0], -forward[1], forward[2]];
	}
	const yaw = Math.atan2(f2[0], f2[1]) / D;
	const pitch = Math.asin(Math.max(-1, Math.min(1, f2[2]))) / D;
	return { ...from, yaw, pitch };
}

/** Closed-form start pose for `solvePins` (see the file header). */
export function seedPinPose(
	prior: Pose,
	aspect: number,
	eye: ArrayLike<number>,
	pins: Pin[],
	solveFov = true,
): Pose {
	if (!pins.length) return prior;
	let vfov = prior.vfov;
	if (pins.length >= 3 && solveFov) {
		const [i, j] = widestPair(pins, aspect);
		vfov =
			vfovFromPair(pins[i], pins[j], eye, aspect, prior.vfov) ?? prior.vfov;
	}
	const t = Math.tan((vfov * D) / 2);
	if (pins.length === 1) {
		// roll and vfov stay the prior's, as in solvePins; a few turns converge on an off-centre tap
		let p: Pose = { ...prior, vfov };
		// each turn shrinks the miss by about sin(roll) × the tap's offset; stop once it no longer moves
		for (let k = 0; k < 20; k++) {
			const q = turnToward(p, aspect, eye, pins[0]);
			const moved = Math.abs(q.yaw - p.yaw) + Math.abs(q.pitch - p.pitch);
			p = q;
			if (moved < 1e-9) break;
		}
		return { ...p, yaw: unwrapNear(p.yaw, prior.yaw) };
	}
	// TRIAD on the two pins farthest apart on screen
	const [i, j] = widestPair(pins, aspect);
	const c1 = camRay(pins[i].u, pins[i].v, t, aspect);
	const c2 = camRay(pins[j].u, pins[j].v, t, aspect);
	const w1 = worldDir(eye, pins[i].world);
	const w2 = worldDir(eye, pins[j].world);
	const cx = cross(c1, c2);
	const wx = cross(w1, w2);
	if (Math.hypot(...cx) < 1e-9 || Math.hypot(...wx) < 1e-9) {
		// degenerate pair (same pixel or same summit): fall back to the one-pin seed
		return seedPinPose(prior, aspect, eye, [pins[i]], false);
	}
	const ct2 = norm(cx);
	const wt2 = norm(wx);
	const ct3 = cross(c1, ct2);
	const wt3 = cross(w1, wt2);
	// R = Mw · Mcᵀ maps camera (right, forward, up) coordinates to ENU
	const R = [0, 1, 2].map((r) =>
		[0, 1, 2].map(
			(col) => w1[r] * c1[col] + wt2[r] * ct2[col] + wt3[r] * ct3[col],
		),
	);
	const axis = (col: number): V3 => [R[0][col], R[1][col], R[2][col]];
	const { yaw, pitch, roll } = anglesFromAxes(axis(1), axis(0));
	return { yaw: unwrapNear(yaw, prior.yaw), pitch, roll, vfov };
}

export type SeededPinSolve = {
	pose: Pose;
	/** RMS tap residual, px on the imgW × imgH image */
	rmsPx: number;
	/** true when the seeded solve was kept, false when `solvePins` from the prior was as good */
	seeded: boolean;
};

const rms = (xs: number[]) =>
	Math.sqrt(xs.reduce((s, x) => s + x * x, 0) / Math.max(1, xs.length));

/** Finite, and (when the solve frees the lens) within the lens bound. */
const sane = (p: Pose, freesLens: boolean) =>
	Object.values(p).every(Number.isFinite) &&
	(!freesLens || (p.vfov >= VFOV_MIN && p.vfov <= VFOV_MAX));

/**
 * `solvePins` from the closed-form seed and from the prior; keeps the sane one that fits the taps
 * best (the prior's on a tie, so a start that already converges gives `solvePins`' own answer).
 * When neither is sane, the vfov-fixed solve from the seed (always within the lens bound).
 */
export function solvePinsSeeded(
	prior: Pose,
	aspect: number,
	eye: number[],
	pins: Pin[],
	imgW: number,
	imgH: number,
	solveFov = true,
): SeededPinSolve {
	if (!pins.length) return { pose: prior, rmsPx: 0, seeded: false };
	const tapRms = (p: Pose) =>
		rms(pinResidualsPx(p, aspect, eye, pins, imgW, imgH));
	const plain = solvePins(prior, aspect, eye, pins, imgW, imgH, solveFov);
	const seed = seedPinPose(prior, aspect, eye, pins, solveFov);
	// the seed's roll / vfov become the weak-prior anchors; for one pin they are the prior's anyway
	const fromSeed = solvePins(seed, aspect, eye, pins, imgW, imgH, solveFov);
	const freesLens = solveFov && pins.length >= 3;
	const ePlain = sane(plain, freesLens)
		? tapRms(plain)
		: Number.POSITIVE_INFINITY;
	const eSeed = sane(fromSeed, freesLens)
		? tapRms(fromSeed)
		: Number.POSITIVE_INFINITY;
	// 0.01 px: a seeded answer must be measurably better to replace the plain one
	if (eSeed + 0.01 < ePlain)
		return { pose: fromSeed, rmsPx: eSeed, seeded: true };
	// the lens is kept for 1–2 pins (or solveFov = false), so only a free lens needs the fallback
	if (Number.isFinite(ePlain) || !freesLens)
		return { pose: plain, rmsPx: tapRms(plain), seeded: false };
	const fixed = solvePins(
		{ ...seed, vfov: Math.min(VFOV_MAX, Math.max(VFOV_MIN, seed.vfov)) },
		aspect,
		eye,
		pins,
		imgW,
		imgH,
		false,
	);
	return { pose: fixed, rmsPx: tapRms(fixed), seeded: true };
}

/**
 * The engines' pin solve (`Renderer.solvePins`): `solvePins` unless `?pinSolve=seeded`. Where
 * `solvePins` converges it returns that same pose (a seeded one must fit the taps more than 0.01 px
 * better RMS to replace it), so the eval GT, which solves from the compass prior, only differs where the plain solve failed.
 */
export function solvePinsForApp(
	prior: Pose,
	aspect: number,
	eye: number[],
	pins: Pin[],
	imgW: number,
	imgH: number,
	solveFov = true,
): Pose {
	if (getFlag("pinSolve") !== "seeded")
		return solvePins(prior, aspect, eye, pins, imgW, imgH, solveFov);
	return solvePinsSeeded(prior, aspect, eye, pins, imgW, imgH, solveFov).pose;
}
