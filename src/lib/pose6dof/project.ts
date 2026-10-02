// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { DEG as D, wrap360 } from "#/lib/geodesy";
// The ../camera projection with an analytic Jacobian w.r.t. the 7 solver parameters. Equal to it up
// to rounding (u0 = r0 × f is simplified, unproject normalises with hypot). No allocation-heavy code.
import type { Pose } from "../camera";
import type { Vec3 } from "../linalg";

/** Parameter vector order used everywhere in this module. */
export const PARAM_NAMES = [
	"dx",
	"dy",
	"dz",
	"yaw",
	"pitch",
	"roll",
	"vfov",
] as const;
export type ParamName = (typeof PARAM_NAMES)[number];
export const NP = 7;

export type Basis = {
	forward: Vec3;
	right: Vec3;
	up: Vec3;
	/** d(basis)/d(yaw|pitch|roll) per radian. Index 0 yaw, 1 pitch, 2 roll. */
	dF: [Vec3, Vec3, Vec3];
	dR: [Vec3, Vec3, Vec3];
	dU: [Vec3, Vec3, Vec3];
};

/** Same basis as camera poseBasis(), plus analytic derivatives. */
export function basis(
	yawDeg: number,
	pitchDeg: number,
	rollDeg: number,
): Basis {
	const y = yawDeg * D;
	const p = pitchDeg * D;
	const r = rollDeg * D;
	const sy = Math.sin(y);
	const cy = Math.cos(y);
	const sp = Math.sin(p);
	const cp = Math.cos(p);
	const sr = Math.sin(r);
	const cr = Math.cos(r);
	const f: Vec3 = [sy * cp, cy * cp, sp];
	const r0: Vec3 = [cy, -sy, 0];
	const u0: Vec3 = [-sy * sp, -cy * sp, cp]; // = r0 × f
	const right: Vec3 = [
		cr * r0[0] - sr * u0[0],
		cr * r0[1] - sr * u0[1],
		cr * r0[2] - sr * u0[2],
	];
	const up: Vec3 = [
		cr * u0[0] + sr * r0[0],
		cr * u0[1] + sr * r0[1],
		cr * u0[2] + sr * r0[2],
	];
	const dr0y: Vec3 = [-sy, -cy, 0];
	const du0y: Vec3 = [-cy * sp, sy * sp, 0];
	const du0p: Vec3 = [-f[0], -f[1], -f[2]];
	const lin = (a: number, u: Vec3, b: number, w: Vec3): Vec3 => [
		a * u[0] + b * w[0],
		a * u[1] + b * w[1],
		a * u[2] + b * w[2],
	];
	return {
		forward: f,
		right,
		up,
		dF: [[cy * cp, -sy * cp, 0], u0, [0, 0, 0]],
		dR: [
			lin(cr, dr0y, -sr, du0y),
			lin(-sr, du0p, 0, du0p),
			[-up[0], -up[1], -up[2]],
		],
		dU: [
			lin(cr, du0y, sr, dr0y),
			lin(cr, du0p, 0, du0p),
			[right[0], right[1], right[2]],
		],
	};
}

/** A projection target: a finite ENU point, or a direction (point at infinity). */
export type Target = { world: ArrayLike<number> } | { dir: ArrayLike<number> };

export type Projection = {
	u: number;
	v: number;
	/** Distance along the optical axis (for a direction: cosine to the axis). */
	depth: number;
	/** du/dparam and dv/dparam for [dx,dy,dz,yaw°,pitch°,roll°,vfov°] (null unless requested). */
	Ju: number[] | null;
	Jv: number[] | null;
};

/**
 * Project a target with pose + eye offset. Returns normalised image coords (0..1, y down) exactly
 * as camera projectPoint does, or null if the target is behind the camera.
 */
export function project(
	pose: Pose,
	aspect: number,
	eye: ArrayLike<number>,
	target: Target,
	withJacobian = false,
	B: Basis = basis(pose.yaw, pose.pitch, pose.roll),
): Projection | null {
	let v0: number;
	let v1: number;
	let v2: number;
	let finite: boolean;
	if ("world" in target) {
		v0 = target.world[0] - eye[0];
		v1 = target.world[1] - eye[1];
		v2 = target.world[2] - eye[2];
		finite = true;
	} else {
		v0 = target.dir[0];
		v1 = target.dir[1];
		v2 = target.dir[2];
		finite = false;
	}
	const { forward: F, right: R, up: U } = B;
	const Z = v0 * F[0] + v1 * F[1] + v2 * F[2];
	if (!(Z > 0)) return null;
	const X = v0 * R[0] + v1 * R[1] + v2 * R[2];
	const Y = v0 * U[0] + v1 * U[1] + v2 * U[2];
	const t = Math.tan((pose.vfov * D) / 2);
	const x = X / Z / (t * aspect);
	const y = Y / Z / t;
	const out: Projection = {
		u: 0.5 + x / 2,
		v: 0.5 - y / 2,
		depth: Z,
		Ju: null,
		Jv: null,
	};
	if (!withJacobian) return out;
	const Ju = new Array<number>(7).fill(0);
	const Jv = new Array<number>(7).fill(0);
	const ku = 0.5 / (t * aspect);
	const kv = -0.5 / t;
	const iz2 = 1 / (Z * Z);
	if (finite) {
		// d v / d eye = -I
		for (let k = 0; k < 3; k++) {
			const dX = -R[k];
			const dY = -U[k];
			const dZ = -F[k];
			Ju[k] = ku * (dX * Z - X * dZ) * iz2;
			Jv[k] = kv * (dY * Z - Y * dZ) * iz2;
		}
	}
	for (let a = 0; a < 3; a++) {
		const dRa = B.dR[a];
		const dUa = B.dU[a];
		const dFa = B.dF[a];
		const dX = v0 * dRa[0] + v1 * dRa[1] + v2 * dRa[2];
		const dY = v0 * dUa[0] + v1 * dUa[1] + v2 * dUa[2];
		const dZ = v0 * dFa[0] + v1 * dFa[1] + v2 * dFa[2];
		Ju[3 + a] = ku * (dX * Z - X * dZ) * iz2 * D;
		Jv[3 + a] = kv * (dY * Z - Y * dZ) * iz2 * D;
	}
	const dt = ((1 + t * t) * D) / 2; // dt/dvfov°
	Ju[6] = 0.5 * (-x / t) * dt;
	Jv[6] = -0.5 * (-y / t) * dt;
	out.Ju = Ju;
	out.Jv = Jv;
	return out;
}

/** Unit ENU direction through normalised image coords (as camera unprojectDir). */
export function unproject(
	pose: Pose,
	aspect: number,
	u: number,
	v: number,
	B: Basis = basis(pose.yaw, pose.pitch, pose.roll),
): Vec3 {
	const t = Math.tan((pose.vfov * D) / 2);
	const x = (u * 2 - 1) * t * aspect;
	const y = (1 - v * 2) * t;
	const d: Vec3 = [
		B.forward[0] + B.right[0] * x + B.up[0] * y,
		B.forward[1] + B.right[1] * x + B.up[1] * y,
		B.forward[2] + B.right[2] * x + B.up[2] * y,
	];
	const n = Math.hypot(d[0], d[1], d[2]);
	return [d[0] / n, d[1] / n, d[2] / n];
}

/** ENU direction from azimuth (deg, clockwise from north) and elevation (deg). */
export function dirFromAzEl(az: number, el: number): Vec3 {
	const a = az * D;
	const e = el * D;
	return [Math.sin(a) * Math.cos(e), Math.cos(a) * Math.cos(e), Math.sin(e)];
}

/** [azimuth 0..360, elevation] in degrees of an ENU vector. */
export function azElFromDir(d: ArrayLike<number>): [number, number] {
	const az = Math.atan2(d[0], d[1]) / D;
	return [
		(az + 360) % 360,
		Math.asin(Math.max(-1, Math.min(1, d[2] / Math.hypot(d[0], d[1], d[2])))) /
			D,
	];
}

/**
 * Pose from a camera→world rotation given as the three world-frame axes
 * (right, up, forward). Inverse of basis(). Roll is well defined unless pitch = ±90°.
 */
export function poseFromAxes(
	right: ArrayLike<number>,
	up: ArrayLike<number>,
	forward: ArrayLike<number>,
	vfov: number,
): Pose {
	const pitch = Math.asin(Math.max(-1, Math.min(1, forward[2]))) / D;
	const yaw = wrap360(Math.atan2(forward[0], forward[1]) / D);
	const roll = Math.atan2(-right[2], up[2]) / D;
	return { yaw, pitch, roll, vfov };
}
