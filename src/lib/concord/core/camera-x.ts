// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// CameraX: wraps (never replaces) camera/index.ts with intrinsics (focal scale, radial k1,
// principal point). Identity intrinsics short-circuit to the exact projectPoint / unprojectDir
// path, so results are bitwise identical to the app's pinhole.
//
// Image plane convention: X = (u − 0.5)·2·aspect, Y = (0.5 − v)·2 (half-height units, Y up). The
// ideal pinhole at pose.vfov has X = xn/t, Y = yn/t with xn,yn focal-normalised (tangent) coords and
// t = tan(vfov/2). With intrinsics: X = fScale·xd/t, Y = fScale·yd/t, (xd,yd) = (xn,yn)·(1 + k1·r²),
// then u += cx, v += cy.
import { projectPoint, unprojectDir } from "../../camera";
import type { CameraX, Intrinsics, Vec3 } from "./types";

const D = Math.PI / 180;

export const isIdentity = (i: Intrinsics): boolean =>
	i.fScale === 1 && i.k1 === 0 && i.cx === 0 && i.cy === 0;

/** Ideal pinhole uv (identity intrinsics at vfov) → photo uv under `intr`. */
export function distortUV(
	u: number,
	v: number,
	intr: Intrinsics,
	aspect: number,
	vfov: number,
): [number, number] {
	if (isIdentity(intr)) return [u, v];
	const t = Math.tan((vfov * D) / 2);
	const xn = (u - 0.5) * 2 * aspect * t;
	const yn = (0.5 - v) * 2 * t;
	const s = 1 + intr.k1 * (xn * xn + yn * yn);
	const X = (intr.fScale * xn * s) / t;
	const Y = (intr.fScale * yn * s) / t;
	return [0.5 + X / (2 * aspect) + intr.cx, 0.5 - Y / 2 + intr.cy];
}

/** Photo uv under `intr` → ideal pinhole uv (identity intrinsics at vfov). 5 Newton iterations on the radius. */
export function undistortUV(
	u: number,
	v: number,
	intr: Intrinsics,
	aspect: number,
	vfov: number,
): [number, number] {
	if (isIdentity(intr)) return [u, v];
	const t = Math.tan((vfov * D) / 2);
	const xd = ((u - intr.cx - 0.5) * 2 * aspect * t) / intr.fScale;
	const yd = ((0.5 - (v - intr.cy)) * 2 * t) / intr.fScale;
	// Radial inverse: solve ρ(1 + k1ρ²) = ρd for ρ by 5 Newton iterations (quadratic convergence;
	// the plain fixed point ρ ← ρd / (1 + k1ρ²) stalls at ~1e-4 for wide FOV corners).
	const rd = Math.hypot(xd, yd);
	let r = rd;
	for (let k = 0; k < 5; k++) {
		const g = r * (1 + intr.k1 * r * r) - rd;
		const dg = 1 + 3 * intr.k1 * r * r;
		r -= g / dg;
	}
	const sc = rd > 0 ? r / rd : 1;
	const xn = xd * sc;
	const yn = yd * sc;
	return [0.5 + xn / (2 * aspect * t), 0.5 - yn / (2 * t)];
}

/** Project an ENU world point (same frame as cam.eye). null if behind (depth ≤ 0). */
export function projectX(
	cam: CameraX,
	world: ArrayLike<number>,
): { u: number; v: number; depth: number } | null {
	const p = projectPoint(cam.pose, cam.aspect, cam.eye, world);
	if (!p || isIdentity(cam.intr)) return p;
	const [u, v] = distortUV(p.u, p.v, cam.intr, cam.aspect, cam.pose.vfov);
	return { u, v, depth: p.depth };
}

/** Unit ENU direction through photo uv. */
export function unprojectDirX(cam: CameraX, u: number, v: number): Vec3 {
	if (isIdentity(cam.intr))
		return unprojectDir(cam.pose, cam.aspect, u, v) as Vec3;
	const [iu, iv] = undistortUV(u, v, cam.intr, cam.aspect, cam.pose.vfov);
	return unprojectDir(cam.pose, cam.aspect, iu, iv) as Vec3;
}
