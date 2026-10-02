// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Pose conventions of the render-and-match solver (port of tools/matcher/common.py, itself a mirror
// of src/lib/pose.ts): world = camera-anchored ENU (x E, y N, z up); R maps world → OpenCV camera
// (x right, y down, z forward); a 3×3 matrix is a row-major Float64Array(9).

import type { Pose } from "#/lib/camera";

export const DEG = Math.PI / 180;

export type Mat3 = Float64Array;

/** pose_basis: forward, right, up unit vectors. */
export function poseBasis(p: Pick<Pose, "yaw" | "pitch" | "roll">) {
	const y = p.yaw * DEG;
	const pt = p.pitch * DEG;
	const r = p.roll * DEG;
	const f = [
		Math.sin(y) * Math.cos(pt),
		Math.cos(y) * Math.cos(pt),
		Math.sin(pt),
	];
	const r0 = [Math.cos(y), -Math.sin(y), 0];
	const u0 = cross(r0, f);
	const cr = Math.cos(r);
	const sr = Math.sin(r);
	const right = [0, 1, 2].map((i) => r0[i] * cr - u0[i] * sr);
	const up = [0, 1, 2].map((i) => u0[i] * cr + r0[i] * sr);
	return { f, right, up };
}

/** pose_to_R: rows [right, −up, forward]. */
export function poseToR(p: Pick<Pose, "yaw" | "pitch" | "roll">): Mat3 {
	const { f, right, up } = poseBasis(p);
	return Float64Array.of(
		right[0],
		right[1],
		right[2],
		-up[0],
		-up[1],
		-up[2],
		f[0],
		f[1],
		f[2],
	);
}

/** R_to_pose (yaw in [0, 360)). */
export function rToPose(R: ArrayLike<number>, vfov: number): Pose {
	const right = [R[0], R[1], R[2]];
	const f = [R[6], R[7], R[8]];
	const yaw = Math.atan2(f[0], f[1]) / DEG;
	const pitch = Math.asin(Math.max(-1, Math.min(1, f[2]))) / DEG;
	const y = yaw * DEG;
	const r0 = [Math.cos(y), -Math.sin(y), 0];
	const u0 = cross(r0, f);
	const roll = Math.atan2(-dot(right, u0), dot(right, r0)) / DEG;
	return { yaw: pyMod(yaw, 360), pitch, roll, vfov };
}

export const focalPx = (vfov: number, H: number) =>
	H / 2 / Math.tan((vfov * DEG) / 2);
export const vfovFromF = (f: number, H: number) =>
	(2 * Math.atan(H / 2 / f)) / DEG;
export const hfovFromVfov = (vfov: number, aspect: number) =>
	(2 * Math.atan(Math.tan((vfov * DEG) / 2) * aspect)) / DEG;
export const vfovFromHfov = (hfov: number, aspect: number) =>
	(2 * Math.atan(Math.tan((hfov * DEG) / 2) / aspect)) / DEG;

/** Python's `%` (result has the sign of the divisor). */
export const pyMod = (a: number, b: number) => ((a % b) + b) % b;

/** common.dang: signed angle a − b in [−180, 180). */
export const dang = (a: number, b: number) => pyMod(a - b + 540, 360) - 180;

/** Rotation angle (deg) between two poses' rotations (fusion.rot_angle). */
export function rotAngle(p: Pose, q: Pose): number {
	const A = poseToR(p);
	const B = poseToR(q);
	// trace(A Bᵀ) = Σ A_ij B_ij
	let tr = 0;
	for (let i = 0; i < 9; i++) tr += A[i] * B[i];
	return Math.acos(Math.max(-1, Math.min(1, (tr - 1) / 2))) / DEG;
}

export const plainPose = (p: Pose): Pose => ({
	yaw: +p.yaw,
	pitch: +p.pitch,
	roll: +p.roll,
	vfov: +p.vfov,
});

/** Python round(x, n) for reporting (half-even on exact binary ties is irrelevant at these scales). */
export function round(x: number, n = 3): number {
	const s = 10 ** n;
	return Math.round(x * s) / s;
}
export const roundOrNull = (x: number | null | undefined, n = 3) =>
	x == null || !Number.isFinite(x) ? null : round(x, n);

/** numpy median (mean of the two middle values for an even count); NaN for an empty input. */
export function median(a: ArrayLike<number>): number {
	const n = a.length;
	if (!n) return Number.NaN;
	const s = Float64Array.from(a).sort();
	const m = n >> 1;
	return n % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function cross(a: ArrayLike<number>, b: ArrayLike<number>): number[] {
	return [
		a[1] * b[2] - a[2] * b[1],
		a[2] * b[0] - a[0] * b[2],
		a[0] * b[1] - a[1] * b[0],
	];
}
export const dot = (a: ArrayLike<number>, b: ArrayLike<number>) =>
	a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Rotation matrix from a rotation vector (Rodrigues). */
export function rotvecToMatrix(v: ArrayLike<number>): Mat3 {
	const th = Math.hypot(v[0], v[1], v[2]);
	if (th < 1e-12) {
		// first order: I + [v]×
		return Float64Array.of(1, -v[2], v[1], v[2], 1, -v[0], -v[1], v[0], 1);
	}
	const kx = v[0] / th;
	const ky = v[1] / th;
	const kz = v[2] / th;
	const c = Math.cos(th);
	const s = Math.sin(th);
	const C = 1 - c;
	return Float64Array.of(
		c + kx * kx * C,
		kx * ky * C - kz * s,
		kx * kz * C + ky * s,
		ky * kx * C + kz * s,
		c + ky * ky * C,
		ky * kz * C - kx * s,
		kz * kx * C - ky * s,
		kz * ky * C + kx * s,
		c + kz * kz * C,
	);
}

/** Rotation vector of a rotation matrix (via the quaternion, stable near 0 and π). */
export function matrixToRotvec(R: ArrayLike<number>): number[] {
	const [m00, m01, m02, m10, m11, m12, m20, m21, m22] = Array.from(R);
	const tr = m00 + m11 + m22;
	let w: number;
	let x: number;
	let y: number;
	let z: number;
	if (tr > 0) {
		const s = Math.sqrt(tr + 1) * 2;
		w = 0.25 * s;
		x = (m21 - m12) / s;
		y = (m02 - m20) / s;
		z = (m10 - m01) / s;
	} else if (m00 > m11 && m00 > m22) {
		const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
		w = (m21 - m12) / s;
		x = 0.25 * s;
		y = (m01 + m10) / s;
		z = (m02 + m20) / s;
	} else if (m11 > m22) {
		const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
		w = (m02 - m20) / s;
		x = (m01 + m10) / s;
		y = 0.25 * s;
		z = (m12 + m21) / s;
	} else {
		const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
		w = (m10 - m01) / s;
		x = (m02 + m20) / s;
		y = (m12 + m21) / s;
		z = 0.25 * s;
	}
	if (w < 0) {
		w = -w;
		x = -x;
		y = -y;
		z = -z;
	}
	const sn = Math.hypot(x, y, z);
	if (sn < 1e-15) return [2 * x, 2 * y, 2 * z];
	const angle = 2 * Math.atan2(sn, w);
	return [(x / sn) * angle, (y / sn) * angle, (z / sn) * angle];
}

/** mulberry32: the solver's deterministic PRNG (numpy's default_rng is not reproducible here). */
export function mulberry32(seed: number) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
