// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Minimal / closed-form pose solvers used to seed the robust LM:
//  - rotationFromBearings: Horn/Kabsch absolute orientation (≥2 bearings, position fixed)
//  - yawFromOnePoint: gravity-aided 1-point yaw (pitch/roll from the prior)
//  - p3p: Grunert's P3P with known focal (3 finite points → up to 4 poses incl. position)
//  - dlt: normalised DLT (≥6 correspondences, directions allowed as w=0 points) → pose, eye, vfov
import { type Pose, vfovFromFocal } from "../camera";
import {
	cross3,
	dot3,
	jacobiEigen,
	norm3,
	realRoots,
	scale3,
	sub3,
	unit3,
	type Vec3,
} from "../linalg";
import { azElFromDir, basis, poseFromAxes, unproject } from "./project";

const D = Math.PI / 180;

/**
 * Camera-frame bearing for normalised image coords, in the right-handed camera frame
 * (right, up, back) — the three.js convention, since pose.ts has right × up = −forward.
 */
export function bearing(
	u: number,
	v: number,
	vfov: number,
	aspect: number,
): Vec3 {
	const t = Math.tan((vfov * D) / 2);
	return unit3([(u * 2 - 1) * t * aspect, (1 - v * 2) * t, -1]);
}

/** Pose from a camera→world rotation given as columns (right, up, back). */
export function poseFromRotation(R: [Vec3, Vec3, Vec3], vfov: number): Pose {
	return poseFromAxes(R[0], R[1], scale3(R[2], -1), vfov);
}

/**
 * Rotation R (camera→world, columns = right, up, back) minimising Σ w |world_i − R cam_i|²,
 * via Horn's quaternion method. Inputs need not be unit length (points are used as-is).
 */
export function absoluteOrientation(
	cam: ArrayLike<number>[],
	world: ArrayLike<number>[],
	w?: number[],
): [Vec3, Vec3, Vec3] {
	const S = [
		[0, 0, 0],
		[0, 0, 0],
		[0, 0, 0],
	];
	for (let i = 0; i < cam.length; i++) {
		const wi = w ? w[i] : 1;
		for (let a = 0; a < 3; a++)
			for (let b = 0; b < 3; b++) S[a][b] += wi * cam[i][a] * world[i][b];
	}
	const [[xx, xy, xz], [yx, yy, yz], [zx, zy, zz]] = S;
	const N = [
		[xx + yy + zz, yz - zy, zx - xz, xy - yx],
		[yz - zy, xx - yy - zz, xy + yx, zx + xz],
		[zx - xz, xy + yx, -xx + yy - zz, yz + zy],
		[xy - yx, zx + xz, yz + zy, -xx - yy + zz],
	];
	const { vectors } = jacobiEigen(N);
	const q0 = vectors[0][3];
	const qx = vectors[1][3];
	const qy = vectors[2][3];
	const qz = vectors[3][3];
	// rotation matrix rows
	const R = [
		[
			q0 * q0 + qx * qx - qy * qy - qz * qz,
			2 * (qx * qy - q0 * qz),
			2 * (qx * qz + q0 * qy),
		],
		[
			2 * (qy * qx + q0 * qz),
			q0 * q0 - qx * qx + qy * qy - qz * qz,
			2 * (qy * qz - q0 * qx),
		],
		[
			2 * (qz * qx - q0 * qy),
			2 * (qz * qy + q0 * qx),
			q0 * q0 - qx * qx - qy * qy + qz * qz,
		],
	];
	// columns = images of camera axes
	return [
		[R[0][0], R[1][0], R[2][0]],
		[R[0][1], R[1][1], R[2][1]],
		[R[0][2], R[1][2], R[2][2]],
	];
}

/** Rotation-only pose from ≥2 (pixel, world direction) pairs with a fixed vfov. */
export function rotationFromBearings(
	uv: [number, number][],
	worldDirs: ArrayLike<number>[],
	vfov: number,
	aspect: number,
): Pose {
	const cam = uv.map(([u, v]) => bearing(u, v, vfov, aspect));
	const R = absoluteOrientation(
		cam,
		worldDirs.map((d) => unit3(d)),
	);
	return poseFromRotation(R, vfov);
}

/**
 * vfov such that the angle between the two pixel rays equals the angle between the two world
 * directions (the 2-point focal constraint). Bisection inside [lo, hi]; null if no sign change.
 */
export function vfovFromPair(
	uv: [number, number][],
	worldDirs: ArrayLike<number>[],
	aspect: number,
	lo: number,
	hi: number,
): number | null {
	const [w1, w2] = worldDirs.map((d) => unit3(d));
	const target = dot3(w1, w2);
	const f = (vf: number) =>
		dot3(
			bearing(uv[0][0], uv[0][1], vf, aspect),
			bearing(uv[1][0], uv[1][1], vf, aspect),
		) - target;
	let a = lo;
	let b = hi;
	let fa = f(a);
	const fb = f(b);
	if (!(fa * fb < 0)) return null;
	for (let i = 0; i < 50; i++) {
		const m = (a + b) / 2;
		const fm = f(m);
		if (fa * fm <= 0) b = m;
		else {
			a = m;
			fa = fm;
		}
	}
	return (a + b) / 2;
}

/** Yaw from one correspondence given pitch/roll/vfov (gravity-aided 1-point solver). */
export function yawFromOnePoint(
	u: number,
	v: number,
	worldDir: ArrayLike<number>,
	prior: Pose,
	aspect: number,
): number {
	const d0 = unproject({ ...prior, yaw: 0 }, aspect, u, v);
	const [az0] = azElFromDir(d0);
	const [az] = azElFromDir(worldDir);
	return (((az - az0) % 360) + 360) % 360;
}

/**
 * Grunert P3P with known intrinsics. `bearings` are unit camera-frame rays (right, up, forward),
 * `pts` the world points. Returns candidate {pose (vfov passed through), eye}.
 */
export function p3p(
	bearings: Vec3[],
	pts: ArrayLike<number>[],
	vfov: number,
): { pose: Pose; eye: Vec3 }[] {
	const [b1, b2, b3] = bearings;
	const [P1, P2, P3] = pts;
	const a = norm3(sub3(P2, P3));
	const b = norm3(sub3(P1, P3));
	const c = norm3(sub3(P1, P2));
	if (a < 1e-6 || b < 1e-6 || c < 1e-6) return [];
	const ca = dot3(b2, b3);
	const cb = dot3(b1, b3);
	const cg = dot3(b1, b2);
	const a2 = a * a;
	const b2s = b * b;
	const c2 = c * c;
	const amc = (a2 - c2) / b2s;
	const apc = (a2 + c2) / b2s;
	const A4 = (amc - 1) ** 2 - ((4 * c2) / b2s) * ca * ca;
	const A3 =
		4 *
		(amc * (1 - amc) * cb -
			(1 - apc) * ca * cg +
			((2 * c2) / b2s) * ca * ca * cb);
	const A2 =
		2 *
		(amc * amc -
			1 +
			2 * amc * amc * cb * cb +
			2 * ((b2s - c2) / b2s) * ca * ca -
			4 * apc * ca * cb * cg +
			2 * ((b2s - a2) / b2s) * cg * cg);
	const A1 =
		4 *
		(-amc * (1 + amc) * cb +
			((2 * a2) / b2s) * cg * cg * cb -
			(1 - apc) * ca * cg);
	const A0 = (1 + amc) ** 2 - ((4 * a2) / b2s) * cg * cg;
	const out: { pose: Pose; eye: Vec3 }[] = [];
	for (const v of realRoots([A4, A3, A2, A1, A0])) {
		if (!(v > 0)) continue;
		const den = 2 * (cg - v * ca);
		if (Math.abs(den) < 1e-15) continue;
		const u = ((-1 + amc) * v * v - 2 * amc * cb * v + 1 + amc) / den;
		if (!(u > 0)) continue;
		const s1sq = b2s / (1 + v * v - 2 * v * cb);
		if (!(s1sq > 0)) continue;
		const s1 = Math.sqrt(s1sq);
		const X = [scale3(b1, s1), scale3(b2, u * s1), scale3(b3, v * s1)];
		const res = rigidFromPoints(X, [P1, P2, P3]);
		if (!res) continue;
		out.push({ pose: poseFromRotation(res.R, vfov), eye: res.t });
	}
	return out;
}

/** Rigid transform world = R·cam + t from ≥3 point pairs (R as columns right, up, back). */
export function rigidFromPoints(cam: Vec3[], world: ArrayLike<number>[]) {
	const n = cam.length;
	const cc: Vec3 = [0, 0, 0];
	const cw: Vec3 = [0, 0, 0];
	for (let i = 0; i < n; i++)
		for (let k = 0; k < 3; k++) {
			cc[k] += cam[i][k] / n;
			cw[k] += world[i][k] / n;
		}
	const R = absoluteOrientation(
		cam.map((p) => sub3(p, cc)),
		world.map((p) => sub3(p, cw)),
	);
	// t = cw − R cc
	const Rc: Vec3 = [
		R[0][0] * cc[0] + R[1][0] * cc[1] + R[2][0] * cc[2],
		R[0][1] * cc[0] + R[1][1] * cc[1] + R[2][1] * cc[2],
		R[0][2] * cc[0] + R[1][2] * cc[1] + R[2][2] * cc[2],
	];
	const t = sub3(cw, Rc);
	return t.every(Number.isFinite) ? { R, t } : null;
}

export type DltInput = {
	u: number;
	v: number;
	world?: ArrayLike<number>;
	dir?: ArrayLike<number>;
};

/**
 * Normalised DLT with a centred principal point and square pixels assumed only in the
 * decomposition. Needs ≥6 correspondences, ≥4 of them finite points. Directions enter as
 * homogeneous points with w = 0.
 */
export function dlt(
	corrs: DltInput[],
	aspect: number,
): { pose: Pose; eye: Vec3 } | null {
	if (corrs.length < 6) return null;
	const fin = corrs.filter((c) => c.world);
	if (fin.length < 4) return null;
	const c0: Vec3 = [0, 0, 0];
	for (const c of fin)
		for (let k = 0; k < 3; k++)
			c0[k] += (c.world as ArrayLike<number>)[k] / fin.length;
	let s = 0;
	for (const c of fin)
		s += norm3(sub3(c.world as ArrayLike<number>, c0)) / fin.length;
	if (!(s > 0)) return null;
	const rows: number[][] = [];
	for (const c of corrs) {
		const X = c.world
			? [...scale3(sub3(c.world, c0), 1 / s), 1]
			: [...unit3(c.dir as ArrayLike<number>), 0];
		// image coords normalised by half-height, y down, principal point at 0
		const x = (c.u * 2 - 1) * aspect;
		const y = c.v * 2 - 1;
		rows.push([...X, 0, 0, 0, 0, ...X.map((q) => -x * q)]);
		rows.push([0, 0, 0, 0, ...X, ...X.map((q) => -y * q)]);
	}
	const AtA = Array.from({ length: 12 }, (_, i) =>
		Array.from({ length: 12 }, (_, j) =>
			rows.reduce((acc, r) => acc + r[i] * r[j], 0),
		),
	);
	const { vectors } = jacobiEigen(AtA);
	const p = vectors.map((row) => row[0]);
	let P = [p.slice(0, 4), p.slice(4, 8), p.slice(8, 12)];
	const det3 = (m: number[][]) =>
		m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
		m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
		m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
	if (det3(P) < 0) P = P.map((r) => r.map((x) => -x));
	const m1: Vec3 = [P[0][0], P[0][1], P[0][2]];
	const m2: Vec3 = [P[1][0], P[1][1], P[1][2]];
	const m3: Vec3 = [P[2][0], P[2][1], P[2][2]];
	// RQ by Gram–Schmidt from the bottom row
	const k22 = norm3(m3);
	const r3 = scale3(m3, 1 / k22);
	const k12 = dot3(m2, r3);
	const t2 = sub3(m2, scale3(r3, k12));
	const k11 = norm3(t2);
	const r2 = scale3(t2, 1 / k11);
	const k02 = dot3(m1, r3);
	const k01 = dot3(m1, r2);
	const t1 = sub3(sub3(m1, scale3(r2, k01)), scale3(r3, k02));
	const k00 = norm3(t1);
	const r1 = scale3(t1, 1 / k00);
	const f = (k00 + k11) / 2 / k22; // in half-height units
	if (!(f > 0.05 && f < 100)) return null;
	// camera centre: M C = −p4
	const Mi = [m1, m2, m3];
	const b = [-P[0][3], -P[1][3], -P[2][3]];
	const det = det3(Mi);
	if (Math.abs(det) < 1e-300) return null;
	const col = (j: number, v: number[]) =>
		Mi.map((r, i) => r.map((x, k) => (k === j ? v[i] : x)));
	const Cn: Vec3 = [
		det3(col(0, b)) / det,
		det3(col(1, b)) / det,
		det3(col(2, b)) / det,
	];
	const eye: Vec3 = [c0[0] + Cn[0] * s, c0[1] + Cn[1] * s, c0[2] + Cn[2] * s];
	// rows of R: camera x (right), y (down), z (forward) in world
	const right = r1;
	const up = scale3(r2, -1);
	const fwd = r3;
	// pose.ts basis satisfies right × up = −forward; reject reflections
	const chk = dot3(cross3(right, up), fwd);
	if (!(chk < 0)) return null;
	const pose = poseFromAxes(right, up, fwd, vfovFromFocal(f, 2));
	// cheirality: majority of finite points in front
	const B = basis(pose.yaw, pose.pitch, pose.roll);
	let front = 0;
	for (const c of fin)
		if (dot3(sub3(c.world as ArrayLike<number>, eye), B.forward) > 0) front++;
	if (front < fin.length / 2) return null;
	return { pose, eye };
}
