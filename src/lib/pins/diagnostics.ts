// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import type { Pin } from "#/lib/align";
import { type Pose, projectPoint } from "#/lib/camera";
/**
 * Tap-a-peak diagnostics: what a set of pins (tapped pixel + named summit) can and cannot tell,
 * read beside `align.ts solvePins`. Pure maths, read-only: nothing here changes a pose, so the
 * solver, the eval GT (`scripts/eval-app.mjs` solves GT with `solvePins`) and the accept path are
 * untouched. Callers (the picker, the workspace pin tool) can show the numbers.
 *
 * - `pinUnknowns` / `pinRedundancy`: the unlock ladder of `solvePins` (1 pin: yaw + pitch, 2: + roll,
 *   ≥ 3: + vfov) and how many equations are left over to check the taps (2n − unknowns). One pin has
 *   none: its residual is always ~0, whatever peak was named.
 * - `checkPinPairs`: the angle between two summits seen from the eye does not depend on the rotation,
 *   only the lens does, so each pair of pins is checked before any solve: the angle between the two
 *   tap rays over a vfov range must contain the angle between the two summits. A wrong name, a wrong
 *   tap or a wrong eye shows up here, and with three pins the one shared by every failing pair is
 *   the suspect.
 * - `pinSigmaDeg`: 1σ of yaw / pitch / roll / vfov at a solved pose, from JᵀJ with a tap error in px.
 * - `leaveOneOutPx`: with ≥ 3 pins, each pin's miss when the pose is solved from the others.
 */
import { DEG as D } from "#/lib/geodesy";
import { gaussJordan } from "#/lib/linalg";

export type PinKey = "yaw" | "pitch" | "roll" | "vfov";

/** The pose parameters `solvePins` frees for `n` pins (same ladder, same order). */
export function pinUnknowns(n: number, solveFov = true): PinKey[] {
	if (n <= 0) return [];
	if (n === 1) return ["yaw", "pitch"];
	if (n === 2 || !solveFov) return ["yaw", "pitch", "roll"];
	return ["yaw", "pitch", "roll", "vfov"];
}

/** Equations left over to check the taps: 2 per pin minus the freed parameters (0 for one pin). */
export const pinRedundancy = (n: number, solveFov = true) =>
	Math.max(0, 2 * n - pinUnknowns(n, solveFov).length);

/** Unit ray of normalised pixel (u, v) in the camera frame (x right, y up, z forward) for tan(vfov/2) = t. */
function cameraRay(u: number, v: number, t: number, aspect: number) {
	const x = (u * 2 - 1) * t * aspect;
	const y = (1 - v * 2) * t;
	const s = 1 / Math.sqrt(x * x + y * y + 1);
	return [x * s, y * s, s];
}

const angleDeg = (a: number[], b: number[]) =>
	Math.acos(
		Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])),
	) / D;

function worldDir(eye: ArrayLike<number>, w: ArrayLike<number>) {
	const d = [w[0] - eye[0], w[1] - eye[1], w[2] - eye[2]];
	const r = Math.hypot(d[0], d[1], d[2]) || 1;
	return [d[0] / r, d[1] / r, d[2] / r];
}

export type PinPairCheck = {
	i: number;
	j: number;
	/** angle between the two summits seen from the eye (rotation-free) */
	worldDeg: number;
	/** smallest and largest angle between the two tap rays over the vfov range */
	minDeg: number;
	maxDeg: number;
	/** how far `worldDeg` lies outside [minDeg, maxDeg] (0 when inside) */
	missDeg: number;
	ok: boolean;
};

export type PinPairReport = {
	pairs: PinPairCheck[];
	/** index of the one pin every failing pair shares (and no passing pair clears), else null */
	suspect: number | null;
};

/**
 * Rotation-free consistency of every pair of pins. `vfovRangeDeg` is the lens range considered
 * plausible (e.g. the prior's vfov ± 15 %, or a phone's 30–80°); `tolDeg` absorbs tap error
 * (≈ 1.5 × the tap σ in degrees). The ray angle is not monotone in vfov, so the range is sampled.
 */
export function checkPinPairs(
	pins: Pin[],
	eye: ArrayLike<number>,
	aspect: number,
	vfovRangeDeg: [number, number],
	tolDeg = 0.5,
): PinPairReport {
	const steps = 48;
	const ts: number[] = [];
	for (let k = 0; k <= steps; k++) {
		const vf =
			vfovRangeDeg[0] + ((vfovRangeDeg[1] - vfovRangeDeg[0]) * k) / steps;
		ts.push(Math.tan((vf * D) / 2));
	}
	const dirs = pins.map((p) => worldDir(eye, p.world));
	const pairs: PinPairCheck[] = [];
	for (let i = 0; i < pins.length; i++)
		for (let j = i + 1; j < pins.length; j++) {
			let minDeg = Number.POSITIVE_INFINITY;
			let maxDeg = 0;
			for (const t of ts) {
				const a = angleDeg(
					cameraRay(pins[i].u, pins[i].v, t, aspect),
					cameraRay(pins[j].u, pins[j].v, t, aspect),
				);
				minDeg = Math.min(minDeg, a);
				maxDeg = Math.max(maxDeg, a);
			}
			const worldDeg = angleDeg(dirs[i], dirs[j]);
			const missDeg = Math.max(0, minDeg - worldDeg, worldDeg - maxDeg);
			pairs.push({
				i,
				j,
				worldDeg,
				minDeg,
				maxDeg,
				missDeg,
				ok: missDeg <= tolDeg,
			});
		}
	return { pairs, suspect: pairSuspect(pins.length, pairs) };
}

function pairSuspect(n: number, pairs: PinPairCheck[]): number | null {
	const bad = pairs.filter((p) => !p.ok);
	if (n < 3 || !bad.length) return null;
	const cands: number[] = [];
	for (let k = 0; k < n; k++) {
		const inAllBad = bad.every((p) => p.i === k || p.j === k);
		// every pair without k must pass, else more than one pin is off (or the lens range is wrong)
		const restOk = pairs.every((p) => p.i === k || p.j === k || p.ok);
		if (inAllBad && restOk) cands.push(k);
	}
	return cands.length === 1 ? cands[0] : null;
}

/** Pixel miss of each pin under `pose`, on an imgW × imgH image (Infinity behind the camera). */
export function pinResidualsPx(
	pose: Pose,
	aspect: number,
	eye: ArrayLike<number>,
	pins: Pin[],
	imgW: number,
	imgH: number,
): number[] {
	return pins.map((p) => {
		const q = projectPoint(pose, aspect, eye, p.world);
		if (!q) return Number.POSITIVE_INFINITY;
		return Math.hypot((q.u - p.u) * imgW, (q.v - p.v) * imgH);
	});
}

/** Relative pivot tolerance for JᵀJ (entries scale with the image size squared). */
const pivotTol = (A: number[][]) =>
	1e-9 * Math.max(1e-300, ...A.map((row, i) => Math.abs(row[i])));

/** A σ above this (deg) means the taps do not determine that parameter: reported as null. */
export const PIN_SIGMA_MAX_DEG = 45;

export type PinSigma = Partial<Record<PinKey, number>>;

/**
 * 1σ (degrees) of each freed parameter at `pose` for a tap error of `tapSigmaPx` per axis
 * (independent, isotropic): σ² = diag((JᵀJ)⁻¹) · tapSigmaPx². Null when JᵀJ is (near-)singular
 * or any σ exceeds PIN_SIGMA_MAX_DEG (e.g. two pins on, or within a hair of, the same pixel). The parameters `solvePins` keeps fixed are absent.
 */
export function pinSigmaDeg(
	pose: Pose,
	aspect: number,
	eye: ArrayLike<number>,
	pins: Pin[],
	imgW: number,
	imgH: number,
	tapSigmaPx: number,
	solveFov = true,
): PinSigma | null {
	const keys = pinUnknowns(pins.length, solveFov);
	if (!keys.length) return {};
	const uv = (p: Pose) =>
		pins.flatMap((pin) => {
			const q = projectPoint(p, aspect, eye, pin.world);
			return q ? [q.u * imgW, q.v * imgH] : [Number.NaN, Number.NaN];
		});
	const r0 = uv(pose);
	if (r0.some((x) => !Number.isFinite(x))) return null;
	const h = 1e-4;
	const J = keys.map((k) => {
		const r1 = uv({ ...pose, [k]: pose[k] + h });
		return r1.map((x, n) => (x - r0[n]) / h);
	});
	const A = keys.map((_, i) =>
		keys.map((_, j) => J[i].reduce((s, x, n) => s + x * J[j][n], 0)),
	);
	const out: PinSigma = {};
	for (let i = 0; i < keys.length; i++) {
		const e = keys.map((_, j) => (j === i ? 1 : 0));
		const col = gaussJordan(A, e, pivotTol(A));
		if (!col || !(col[i] > 0)) return null;
		const sigma = Math.sqrt(col[i]) * tapSigmaPx;
		if (!(sigma <= PIN_SIGMA_MAX_DEG)) return null;
		out[keys[i]] = sigma;
	}
	return out;
}

/**
 * Each pin's miss (px) when the pose is solved from the other pins only (`solve(rest)`), or null
 * per pin when the rest cannot check it (fewer than 2 other pins). A wrong pin stands out with ≥ 4
 * pins; with 3, prefer `checkPinPairs` (it needs no solve and isolates one bad pin).
 */
export function leaveOneOutPx(
	pins: Pin[],
	solve: (rest: Pin[]) => Pose,
	aspect: number,
	eye: ArrayLike<number>,
	imgW: number,
	imgH: number,
): (number | null)[] {
	if (pins.length < 3) return pins.map(() => null);
	return pins.map((pin, k) => {
		const rest = pins.filter((_, i) => i !== k);
		const pose = solve(rest);
		return pinResidualsPx(pose, aspect, eye, [pin], imgW, imgH)[0];
	});
}

/**
 * How well naming the tap at (u, v) as the summit `world` fits the pins already placed: the largest
 * pair miss (deg, `checkPinPairs`) against any of them, 0 when it fits every one (and with no pins
 * yet). Rotation-free, so it can re-rank or flag the "Which peak did you tap?" menu from the
 * second tap on, before any solve.
 */
export function pairFitDeg(
	pins: Pin[],
	candidate: Pin,
	eye: ArrayLike<number>,
	aspect: number,
	vfovRangeDeg: [number, number],
): number {
	if (!pins.length) return 0;
	const all = [...pins, candidate];
	const last = all.length - 1;
	let worst = 0;
	for (const p of checkPinPairs(all, eye, aspect, vfovRangeDeg, 0).pairs)
		if (p.j === last) worst = Math.max(worst, p.missDeg);
	return worst;
}

export type PinReliability = {
	/** redundancy number per pin, 0..1 (mean of its two axes): 0 = the solve absorbs any error in it */
	redundancy: number[];
	/**
	 * minimal detectable error per pin (px): σ·4.1/√r (Baarda; α 0.001, power 0.8) with r the mean of the
	 * pin's two axes (an approximation: per axis the weaker axis hides more), Infinity when r ≈ 0
	 */
	detectablePx: number[];
};

/** Below this redundancy number a pin "cannot be checked" (its error hides in the pose). */
export const PIN_CHECKABLE_R = 0.3;

/**
 * Internal reliability of each pin at a solved pose (Baarda 1968): the diagonal of I − J(JᵀJ)⁻¹Jᵀ
 * per pixel axis, and the smallest tap error the residuals would reveal for a tap σ of `tapSigmaPx`.
 * One pin is always r = 0; two pins share r ≈ 0.25 each (one spare equation over four).
 */
export function pinReliability(
	pose: Pose,
	aspect: number,
	eye: ArrayLike<number>,
	pins: Pin[],
	imgW: number,
	imgH: number,
	tapSigmaPx: number,
	solveFov = true,
): PinReliability | null {
	const keys = pinUnknowns(pins.length, solveFov);
	const m = pins.length * 2;
	if (!keys.length) return { redundancy: [], detectablePx: [] };
	const uv = (p: Pose) =>
		pins.flatMap((pin) => {
			const q = projectPoint(p, aspect, eye, pin.world);
			return q ? [q.u * imgW, q.v * imgH] : [Number.NaN, Number.NaN];
		});
	const r0 = uv(pose);
	if (r0.some((x) => !Number.isFinite(x))) return null;
	const h = 1e-4;
	const J = keys.map((k) => {
		const r1 = uv({ ...pose, [k]: pose[k] + h });
		return r1.map((x, n) => (x - r0[n]) / h);
	});
	const A = keys.map((_, i) =>
		keys.map((_, j) => J[i].reduce((s, x, n) => s + x * J[j][n], 0)),
	);
	// leverage of row n: J_nᵀ A⁻¹ J_n
	const lev: number[] = [];
	for (let n = 0; n < m; n++) {
		const jn = keys.map((_, i) => J[i][n]);
		const x = gaussJordan(A, jn, pivotTol(A));
		if (!x) return null;
		lev.push(jn.reduce((s, v, i) => s + v * x[i], 0));
	}
	const redundancy = pins.map((_, i) =>
		Math.max(0, Math.min(1, 1 - (lev[2 * i] + lev[2 * i + 1]) / 2)),
	);
	const detectablePx = redundancy.map((r) =>
		r < 1e-6 ? Number.POSITIVE_INFINITY : (tapSigmaPx * 4.1) / Math.sqrt(r),
	);
	return { redundancy, detectablePx };
}
