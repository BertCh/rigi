// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The camera model, pure numbers. Pose lives in the camera-anchored ENU frame
// (x=E, y=N, z=Up): yaw = true heading clockwise from north, pitch up +, roll right side down +,
// vfov = vertical FOV of the photo, all degrees. Image coords are normalised 0..1, v pointing down.
// pose.ts adapts it to math.gl vectors and view-camera.ts; pose6dof/project.ts carries the same basis with analytic
// derivatives; geo/camera's pixel `Camera` is the solvers' representation (poseToCamera/cameraToPose).
import type { Mat3 } from "#/lib/ontology/core/geometry";
import type { Deg } from "#/lib/ontology/core/quantity";
import { type Camera, cameraFromAngles } from "../geo/camera";
import { DEG as D, wrap360 } from "../geodesy";
import { cross3, dot3, type Vec3 } from "../linalg";

export type Pose = { yaw: Deg; pitch: Deg; roll: Deg; vfov: Deg };

/**
 * A usable pose: every angle finite and the vfov a real lens (0 < vfov < 180). Read paths (saved
 * poses, imported files) use it so a NaN or a sentinel such as `{yaw: null, …, vfov: 180}` never
 * reaches a renderer. It does not range-check yaw (any finite heading wraps) or pitch/roll.
 */
export function isPose(x: unknown): x is Pose {
	if (x == null || typeof x !== "object") return false;
	const p = x as Record<string, unknown>;
	return (
		Number.isFinite(p.yaw) &&
		Number.isFinite(p.pitch) &&
		Number.isFinite(p.roll) &&
		Number.isFinite(p.vfov) &&
		(p.vfov as number) > 0 &&
		(p.vfov as number) < 180
	);
}
export type { Mat3 };

/** Camera axes in ENU (pose.ts wraps these as math.gl vectors). */
export function poseBasis(p: Pose): { forward: Vec3; right: Vec3; up: Vec3 } {
	const y = p.yaw * D;
	const pt = p.pitch * D;
	const r = p.roll * D;
	const f: Vec3 = [
		Math.sin(y) * Math.cos(pt),
		Math.cos(y) * Math.cos(pt),
		Math.sin(pt),
	];
	const r0: Vec3 = [Math.cos(y), -Math.sin(y), 0];
	const u0 = cross3(r0, f);
	const cr = Math.cos(r);
	const sr = Math.sin(r);
	return {
		forward: f,
		right: [0, 1, 2].map((i) => r0[i] * cr - u0[i] * sr) as Vec3,
		up: [0, 1, 2].map((i) => u0[i] * cr + r0[i] * sr) as Vec3,
	};
}

/**
 * World(ENU) → OpenCV camera rotation of a pose, row-major: rows right, −up, forward (OpenCV axes
 * x right, y down, z forward). The inverse is `rToPose`.
 */
export function poseToR(p: Pose): Mat3 {
	const { forward: f, right: r, up: u } = poseBasis(p);
	return [r[0], r[1], r[2], -u[0], -u[1], -u[2], f[0], f[1], f[2]];
}

/** Camera(OpenCV axes) → ENU rotation of a pose, row-major: columns right, −up, forward (= poseToR transposed). */
export function camToEnu(p: Pose): Mat3 {
	const { forward: F, right: R, up: U } = poseBasis(p);
	return [R[0], -U[0], F[0], R[1], -U[1], F[1], R[2], -U[2], F[2]];
}

/**
 * Yaw / pitch / roll (deg, yaw in (−180, 180], not wrapped) of a camera with these ENU axes: the inverse of
 * `poseBasis`. Roll is well defined unless pitch = ±90°. Only forward and right are read.
 */
export function anglesFromAxes(
	forward: ArrayLike<number>,
	right: ArrayLike<number>,
): { yaw: Deg; pitch: Deg; roll: Deg } {
	const yaw = Math.atan2(forward[0], forward[1]);
	const pitch = Math.asin(Math.max(-1, Math.min(1, forward[2])));
	const r0: Vec3 = [Math.cos(yaw), -Math.sin(yaw), 0];
	const u0 = cross3(r0, forward);
	const roll = Math.atan2(-dot3(right, u0), dot3(right, r0));
	return { yaw: yaw / D, pitch: pitch / D, roll: roll / D };
}

/** Inverse of `poseToR` (mirror of tools/matcher/common.py R_to_pose): yaw in [0, 360), `vfov` passes through. */
export function rToPose(R: ArrayLike<number>, vfov: number): Pose {
	const a = anglesFromAxes([R[6], R[7], R[8]], [R[0], R[1], R[2]]);
	return { yaw: wrap360(a.yaw), pitch: a.pitch, roll: a.roll, vfov };
}

/**
 * projectPoint with the pose basis and tan(vfov/2) hoisted: bind once per pose, then project many
 * points. Same float operations in the same order as the one-shot projectPoint (which uses it).
 */
export function makeProjector(
	p: Pose,
	aspect: number,
	eye: ArrayLike<number>,
): (pt: ArrayLike<number>) => { u: number; v: number; depth: number } | null {
	const { forward, right, up } = poseBasis(p);
	const t = Math.tan((p.vfov * D) / 2);
	const ex = eye[0];
	const ey = eye[1];
	const ez = eye[2];
	return (pt) => {
		const v = [pt[0] - ex, pt[1] - ey, pt[2] - ez];
		const z = dot3(v, forward);
		if (z <= 0) return null;
		const x = dot3(v, right) / z / (t * aspect);
		const y = dot3(v, up) / z / t;
		return { u: 0.5 + x / 2, v: 0.5 - y / 2, depth: z };
	};
}

/** Project an ENU point into normalised image coords (0..1, y down). null if behind (depth ≤ 0). */
export function projectPoint(
	p: Pose,
	aspect: number,
	eye: ArrayLike<number>,
	pt: ArrayLike<number>,
) {
	return makeProjector(p, aspect, eye)(pt);
}

/** Unit ENU direction through normalised image coords. */
export function unprojectDir(
	p: Pose,
	aspect: number,
	u: number,
	v: number,
): Vec3 {
	const { forward, right, up } = poseBasis(p);
	const t = Math.tan((p.vfov * D) / 2);
	const x = (u * 2 - 1) * t * aspect;
	const y = (1 - v * 2) * t;
	const d = [0, 1, 2].map((i) => forward[i] + right[i] * x + up[i] * y);
	const s = 1 / (Math.sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2]) || 1);
	return [d[0] * s, d[1] * s, d[2] * s];
}

// 35 mm-equivalent focal → px, crop-aware (ExifImageWidth/Height vs the actual pixels).
export {
	CROP_ASPECT_TOL,
	FF35_DIAGONAL_MM,
	focalPxFromF35,
	isCropped,
	type PixelSize,
} from "./focal";

/** Focal length in px for an image of height H (square pixels, centred principal point). */
export const focalFromVfov = (vfov: number, H: number) =>
	H / 2 / Math.tan((vfov * D) / 2);
export const vfovFromFocal = (f: number, H: number) =>
	(2 * Math.atan(H / 2 / f)) / D;
export const hfovFromVfov = (vfov: number, W: number, H: number) =>
	(2 * Math.atan(Math.tan((vfov * D) / 2) * (W / H))) / D;
export const vfovFromHfov = (hfov: number, W: number, H: number) =>
	(2 * Math.atan(Math.tan((hfov * D) / 2) * (H / W))) / D;
/**
 * hfovFromVfov / vfovFromHfov for an aspect (w/h), in the renderers' operation order (π/360, ·180/π).
 * Not bit-identical to the pair above, so the callers that used this form keep it.
 */
export const hfovFromAspect = (vfov: number, aspect: number) =>
	(2 * Math.atan(Math.tan((vfov * Math.PI) / 360) * aspect) * 180) / Math.PI;

/** The solvers' pixel camera for a pose on a W×H image. */
export const poseToCamera = (p: Pose, W: number, H: number): Camera =>
	cameraFromAngles({
		width: W,
		height: H,
		f: focalFromVfov(p.vfov, H),
		yaw: p.yaw,
		pitch: p.pitch,
		roll: p.roll,
	});

export const cameraToPose = (c: Camera): Pose => ({
	yaw: wrap360(c.yaw),
	pitch: c.pitch,
	roll: c.roll,
	vfov: vfovFromFocal(c.f, c.height),
});

/**
 * OpenCV/COLMAP intrinsics (corner-origin pixels: cx = W/2, cy = H/2) and the rotation from
 * OpenCV camera axes (x right, y down, z forward) to ENU: columns right, −up, forward.
 */
export function poseToOpenCV(p: Pose, W: number, H: number) {
	const f = focalFromVfov(p.vfov, H);
	const K: Mat3 = [f, 0, W / 2, 0, f, H / 2, 0, 0, 1];
	const R_cam2enu = camToEnu(p);
	return { f, K, R_cam2enu };
}
