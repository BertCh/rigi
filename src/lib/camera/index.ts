// The camera model, pure numbers (no three.js). Pose lives in the camera-anchored ENU frame
// (x=E, y=N, z=Up): yaw = true heading clockwise from north, pitch up +, roll right side down +,
// vfov = vertical FOV of the photo, all degrees. Image coords are normalised 0..1, v pointing down.
// pose.ts adapts this to three.js; pose6dof/project.ts carries the same basis with analytic
// derivatives; geo/camera's pixel `Camera` is the solvers' representation (poseToCamera/cameraToPose).
import type { Mat3 } from "#/lib/ontology/core/geometry";
import type { Deg } from "#/lib/ontology/core/quantity";
import { type Camera, cameraFromAngles } from "../geo/camera";
import { wrap360 } from "../geodesy";
import { cross3, dot3, type Vec3 } from "../linalg";

export type Pose = { yaw: Deg; pitch: Deg; roll: Deg; vfov: Deg };
export type { Mat3 };

const D = Math.PI / 180;

/** Camera axes in ENU (same operation order as three.js vector math, so pose.ts is bitwise equal). */
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

/** Project an ENU point into normalised image coords (0..1, y down). null if behind (depth ≤ 0). */
export function projectPoint(
	p: Pose,
	aspect: number,
	eye: ArrayLike<number>,
	pt: ArrayLike<number>,
) {
	const { forward, right, up } = poseBasis(p);
	const v = [pt[0] - eye[0], pt[1] - eye[1], pt[2] - eye[2]];
	const z = dot3(v, forward);
	if (z <= 0) return null;
	const t = Math.tan((p.vfov * D) / 2);
	const x = dot3(v, right) / z / (t * aspect);
	const y = dot3(v, up) / z / t;
	return { u: 0.5 + x / 2, v: 0.5 - y / 2, depth: z };
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
export const vfovFromAspect = (hfov: number, aspect: number) =>
	(2 * Math.atan(Math.tan((hfov * Math.PI) / 360) / aspect) * 180) / Math.PI;

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
	const { forward: F, right: R, up: U } = poseBasis(p);
	const K: Mat3 = [f, 0, W / 2, 0, f, H / 2, 0, 0, 1];
	const R_cam2enu = [0, 1, 2].flatMap((i) => [R[i], -U[i], F[i]]) as Mat3;
	return { f, K, R_cam2enu };
}
