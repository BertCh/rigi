// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { FF35_DIAGONAL_MM, focalPxFromF35 } from "../camera/focal";
import { concordOn } from "../concord/flags";
import { focalPrior, lensModelFromCamera } from "../concord/priors/focal-table";
import { DEG } from "../geodesy";
import type { PhotoMeta, Vec3 } from "./photo-meta";

/**
 * Pinhole camera in the *display* image frame (after EXIF orientation):
 * x right, y down, z forward. World frame is local ENU at the camera.
 * `rows` holds the world axes expressed in camera coordinates, so a world
 * direction d maps to camera coords c = E*d.e + N*d.n + U*d.u.
 */
export interface Camera {
	width: number;
	height: number;
	f: number;
	cx: number;
	cy: number;
	east: Vec3;
	north: Vec3;
	up: Vec3;
	/** Human-readable angles, degrees. Pitch positive up, roll positive CW. */
	yaw: number;
	pitch: number;
	roll: number;
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
	a[1] * b[2] - a[2] * b[1],
	a[2] * b[0] - a[0] * b[2],
	a[0] * b[1] - a[1] * b[0],
];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const normalize = (a: Vec3) => scale(a, 1 / Math.hypot(...a));

/**
 * Apple's AccelerationVector is in the phone frame (+X toward the phone's
 * left edge, +Y toward its bottom, +Z out of the back, as seen by the rear
 * camera looking at a scene). Checked against the test photos: landscape
 * shots read ≈(-1,0,0), portrait ≈(0,-1,0), and negative Z means pitched down.
 * Returns gravity in the display camera frame (x right, y down, z forward).
 */
export function gravityInDisplayFrame(g: Vec3, orientation: number): Vec3 {
	// Sensor frame (stored pixels): u right, v down, w forward.
	const s: Vec3 = normalize([-g[1], -g[0], -g[2]]);
	switch (orientation) {
		case 6: // rotate 90° CW for display
			return [-s[1], s[0], s[2]];
		case 8: // rotate 90° CCW
			return [s[1], -s[0], s[2]];
		case 3:
			return [-s[0], -s[1], s[2]];
		default:
			return s;
	}
}

export function displaySize(meta: PhotoMeta) {
	const swap = meta.orientation >= 5;
	return swap
		? { width: meta.height, height: meta.width }
		: { width: meta.width, height: meta.height };
}

export function focalPx(focal35: number, width: number, height: number) {
	return (focal35 * Math.hypot(width, height)) / FF35_DIAGONAL_MM;
}

/** Builds the camera from gravity (pitch, roll) and heading (yaw). */
export function cameraFromGravity(opts: {
	width: number;
	height: number;
	f: number;
	gravity: Vec3;
	heading: number;
}): Camera {
	const { width, height, f, heading } = opts;
	const up = scale(normalize(opts.gravity), -1);
	const forward: Vec3 = [0, 0, 1];
	const fh = normalize(add(forward, scale(up, -dot(forward, up))));
	const rh = cross(fh, up);
	const psi = heading * DEG;
	const north = add(scale(fh, Math.cos(psi)), scale(rh, -Math.sin(psi)));
	const east = add(scale(fh, Math.sin(psi)), scale(rh, Math.cos(psi)));
	return {
		width,
		height,
		f,
		cx: width / 2,
		cy: height / 2,
		east,
		north,
		up,
		yaw: heading,
		pitch: Math.asin(Math.max(-1, Math.min(1, up[2]))) / DEG,
		roll: Math.atan2(-up[0], -up[1]) / DEG,
	};
}

export function cameraFromMeta(meta: PhotoMeta): Camera {
	if (!meta.gravity || meta.heading === undefined || !meta.focal35)
		throw new Error("Photo lacks gravity, heading or focal length");
	const { width, height } = displaySize(meta);
	return cameraFromGravity({
		width,
		height,
		// crop-aware (sensor = EXIF size); principal point stays centred, a crop's is unknown
		// ?concord=eye: the per-lens focal table (WP-B, concord/priors); off ⇒ the EXIF focal unchanged
		f: concordOn("eye")
			? focalPrior(
					lensModelFromCamera(meta.model, meta.focal35),
					meta.focal35,
					{ width, height },
					{ width: meta.sensorWidth, height: meta.sensorHeight },
				).fPx
			: focalPxFromF35(
					meta.focal35,
					{ width, height },
					{ width: meta.sensorWidth, height: meta.sensorHeight },
				),
		gravity: gravityInDisplayFrame(meta.gravity, meta.orientation),
		heading: meta.heading,
	});
}

export interface CameraParams {
	width: number;
	height: number;
	f: number;
	/** Degrees clockwise from true north. */
	yaw: number;
	/** Degrees, positive = looking up. */
	pitch: number;
	/** Degrees, positive = clockwise image rotation of the scene. */
	roll: number;
}

/** Builds a camera from explicit angles; the inverse of reading cam.yaw/pitch/roll. */
export function cameraFromAngles(p: CameraParams): Camera {
	const pitch = p.pitch * DEG;
	const roll = p.roll * DEG;
	const up: Vec3 = [
		-Math.sin(roll) * Math.cos(pitch),
		-Math.cos(roll) * Math.cos(pitch),
		Math.sin(pitch),
	];
	return cameraFromGravity({
		width: p.width,
		height: p.height,
		f: p.f,
		gravity: scale(up, -1),
		heading: p.yaw,
	});
}

export const cameraParams = (cam: Camera): CameraParams => ({
	width: cam.width,
	height: cam.height,
	f: cam.f,
	yaw: cam.yaw,
	pitch: cam.pitch,
	roll: cam.roll,
});

/** Offsets yaw, pitch and roll (degrees) and rescales f. */
export function perturbCamera(
	cam: Camera,
	dYaw: number,
	dPitch = 0,
	dRoll = 0,
	fScale = 1,
): Camera {
	return cameraFromAngles({
		width: cam.width,
		height: cam.height,
		f: cam.f * fScale,
		yaw: cam.yaw + dYaw,
		pitch: cam.pitch + dPitch,
		roll: cam.roll + dRoll,
	});
}

/** Same pose at a different image resolution (e.g. a downscaled working copy). */
export function resizeCamera(cam: Camera, width: number): Camera {
	const s = width / cam.width;
	return {
		...cam,
		width,
		height: cam.height * s,
		f: cam.f * s,
		cx: cam.cx * s,
		cy: cam.cy * s,
	};
}

/** World direction from azimuth (deg, CW from north) and elevation angle (deg). */
export function directionENU(azimuth: number, elevation: number): Vec3 {
	const a = azimuth * DEG;
	const e = elevation * DEG;
	return [Math.sin(a) * Math.cos(e), Math.cos(a) * Math.cos(e), Math.sin(e)];
}

/** Projects an ENU direction to display pixels, or null if behind the camera. */
export function project(cam: Camera, d: Vec3): [number, number] | null {
	const c = add(
		add(scale(cam.east, d[0]), scale(cam.north, d[1])),
		scale(cam.up, d[2]),
	);
	if (c[2] <= 1e-6) return null;
	return [cam.cx + (cam.f * c[0]) / c[2], cam.cy + (cam.f * c[1]) / c[2]];
}

/** Display pixel → unit ENU direction. */
export function unproject(cam: Camera, x: number, y: number): Vec3 {
	const c: Vec3 = normalize([(x - cam.cx) / cam.f, (y - cam.cy) / cam.f, 1]);
	// Camera axes expressed in world: transpose of [east north up] rows.
	return [
		cam.east[0] * c[0] + cam.east[1] * c[1] + cam.east[2] * c[2],
		cam.north[0] * c[0] + cam.north[1] * c[1] + cam.north[2] * c[2],
		cam.up[0] * c[0] + cam.up[1] * c[1] + cam.up[2] * c[2],
	];
}

/** ENU direction → [azimuth 0..360, elevation] in degrees. */
export function azimuthElevation(d: Vec3): [number, number] {
	const az = Math.atan2(d[0], d[1]) / DEG;
	return [
		(az + 360) % 360,
		Math.asin(Math.max(-1, Math.min(1, d[2] / Math.hypot(...d)))) / DEG,
	];
}
