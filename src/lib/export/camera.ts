// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Camera model for export: turns the app's pose (camera-anchored ENU, yaw/pitch/roll/vfov, see
// ../camera) into standard photogrammetry quantities — intrinsics K, rotations camera→ENU and
// camera→ECEF, the camera centre in ECEF, and an OpenCV-convention world→camera R,t.
//
// Conventions
// - Camera axes follow OpenCV/COLMAP: x right, y down, z forward (into the scene).
// - Pixel coordinates are "corner-origin continuous": (0,0) is the top-left corner of the image,
//   (W,H) the bottom-right corner, so camera projectPoint's (u,v) maps to (u·W, v·H). This is the
//   COLMAP convention (centre of the top-left pixel = (0.5,0.5)). OpenCV puts the centre of the
//   top-left pixel at (0,0); `Kopencv` is K with cx,cy shifted by −0.5 for that convention.
// - ENU→ECEF is the plain rigid transform (no refraction). The engine's EnuFrame.fromGeo adds a
//   refraction lift (k = 0.13) to distant points; the exported model is purely geometric.
import type { Vec3 } from "#/lib/ontology/core/geometry";
import {
	FF35_DIAGONAL_MM,
	hfovFromVfov,
	type Mat3,
	type Pose,
	poseToOpenCV,
} from "../camera";
import { DEG as D, toEcef, WGS84 } from "../geodesy";

export type { Vec3 };

export type CameraInput = {
	photoId: string;
	/** File name used in KML/KMZ hrefs and COLMAP lines. Default `${photoId}.jpg`. */
	imageName?: string;
	/** Full image size in pixels (the photo, not the viewport). */
	width: number;
	height: number;
	pose: Pose;
	/** Anchor of the ENU frame the pose/eye live in (engine.frame: EnuFrame is structurally OK). */
	frame: { lat: number; lon: number; h: number };
	/** Camera position in that ENU frame, metres (engine.eye → [x, y, z]). */
	eye: Vec3;
	/** DEM height under the camera (engine.demAtCamera), for the eye-offset field. */
	demAtCamera?: number | null;
	/**
	 * Geoid undulation N (m) at the camera: h_ellipsoid = H_msl + N. The app's heights come from the
	 * Mapterhorn DEM (orthometric, ≈ EGM2008 MSL) and are used as-is in the ENU frame, so by
	 * default N = 0 and "ECEF" is an MSL-on-ellipsoid approximation. In the Swiss Alps N ≈ 47–51 m.
	 */
	geoidUndulation?: number;
	/** ISO capture time (UTC), copied into outputs. */
	takenAt?: string | null;
};

export type CameraModel = {
	input: CameraInput;
	imageName: string;
	width: number;
	height: number;
	vfov: number;
	hfov: number;
	/** Diagonal FOV in degrees. */
	dfov: number;
	/** Focal length in px (square pixels, fx = fy). */
	f: number;
	/** Intrinsics, corner-origin pixel convention (COLMAP): cx = W/2, cy = H/2. */
	K: Mat3;
	/** Intrinsics for OpenCV's pixel-centre convention: cx = W/2 − 0.5, cy = H/2 − 0.5. */
	Kopencv: Mat3;
	/** 35 mm-equivalent focal length from the diagonal. */
	f35: number;
	/** Camera geodetic position (WGS84 lat/lon, heights in metres). */
	lat: number;
	lon: number;
	/** Height above MSL (the app's DEM datum). */
	altMsl: number;
	/** Ellipsoidal height = altMsl + geoidUndulation. */
	altEllipsoid: number;
	geoidUndulation: number;
	/** Camera height above the DEM surface, when demAtCamera was given. */
	eyeOffset: number | null;
	/** Rotation camera(OpenCV axes)→ENU of `input.frame`; columns = right, down, forward in ENU. */
	R_cam2enu: Mat3;
	/** Rotation ENU(frame)→ECEF; columns = east, north, up in ECEF. */
	R_enu2ecef: Mat3;
	/** Rotation camera(OpenCV axes)→ECEF. */
	R_cam2ecef: Mat3;
	/** ECEF of the ENU frame origin. */
	frameOriginEcef: Vec3;
	/** Camera centre in ECEF (metres). */
	C_ecef: Vec3;
	/** OpenCV world→camera with world = ECEF: x_cam = R·X + t. */
	R_w2c_ecef: Mat3;
	t_w2c_ecef: Vec3;
	/** Same with world = the local ENU frame (numerically friendlier for most tools). */
	R_w2c_enu: Mat3;
	t_w2c_enu: Vec3;
	/** Hamilton quaternion (w, x, y, z) of R_w2c_ecef, w ≥ 0 (COLMAP qvec). */
	q_w2c_ecef: [number, number, number, number];
	q_w2c_enu: [number, number, number, number];
};

function mat3FromCols(
	a: ArrayLike<number>,
	b: ArrayLike<number>,
	c: ArrayLike<number>,
): Mat3 {
	return [a[0], b[0], c[0], a[1], b[1], c[1], a[2], b[2], c[2]];
}
export function mat3Mul(a: Mat3, b: Mat3): Mat3 {
	const o = new Array(9).fill(0) as Mat3;
	for (let i = 0; i < 3; i++)
		for (let j = 0; j < 3; j++)
			o[i * 3 + j] =
				a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
	return o;
}
export function mat3T(a: Mat3): Mat3 {
	return [a[0], a[3], a[6], a[1], a[4], a[7], a[2], a[5], a[8]];
}
export function mat3Vec(a: Mat3, v: ArrayLike<number>): Vec3 {
	return [
		a[0] * v[0] + a[1] * v[1] + a[2] * v[2],
		a[3] * v[0] + a[4] * v[1] + a[5] * v[2],
		a[6] * v[0] + a[7] * v[1] + a[8] * v[2],
	];
}

/** Rotation ENU→ECEF at a geodetic lat/lon (columns: east, north, up). */
export function enuToEcefRotation(lat: number, lon: number): Mat3 {
	const sp = Math.sin(lat * D);
	const cp = Math.cos(lat * D);
	const sl = Math.sin(lon * D);
	const cl = Math.cos(lon * D);
	return mat3FromCols(
		[-sl, cl, 0],
		[-sp * cl, -sp * sl, cp],
		[cp * cl, cp * sl, sp],
	);
}

/** Exact-ish ECEF → WGS84 geodetic (iterative; sub-mm for terrestrial points). */
export function ecefToGeodetic(
	x: number,
	y: number,
	z: number,
): { lat: number; lon: number; h: number } {
	const p = Math.hypot(x, y);
	const lon = Math.atan2(y, x);
	let lat = Math.atan2(z, p * (1 - WGS84.E2));
	let h = 0;
	for (let i = 0; i < 8; i++) {
		const s = Math.sin(lat);
		const n = WGS84.A / Math.sqrt(1 - WGS84.E2 * s * s);
		h = p / Math.cos(lat) - n;
		lat = Math.atan2(z, p * (1 - (WGS84.E2 * n) / (n + h)));
	}
	return { lat: lat / D, lon: lon / D, h };
}

/** Rotation matrix → unit quaternion (w, x, y, z), w ≥ 0. */
export function mat3ToQuat(m: Mat3): [number, number, number, number] {
	const [m00, m01, m02, m10, m11, m12, m20, m21, m22] = m;
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
	const n = Math.hypot(w, x, y, z) * (w < 0 ? -1 : 1);
	return [w / n, x / n, y / n, z / n];
}

export function buildCameraModel(input: CameraInput): CameraModel {
	const { width: W, height: H, pose, frame, eye } = input;
	const N = input.geoidUndulation ?? 0;
	const { f, K, R_cam2enu } = poseToOpenCV(pose, W, H);
	const hfov = hfovFromVfov(pose.vfov, W, H);
	const dfov = (2 * Math.atan(Math.hypot(W, H) / 2 / f)) / D;
	const Kopencv: Mat3 = [f, 0, W / 2 - 0.5, 0, f, H / 2 - 0.5, 0, 0, 1];

	const R_enu2ecef = enuToEcefRotation(frame.lat, frame.lon);
	const R_cam2ecef = mat3Mul(R_enu2ecef, R_cam2enu);
	const frameOriginEcef = toEcef(frame.lat, frame.lon, frame.h + N);
	const d = mat3Vec(R_enu2ecef, eye);
	const C_ecef: Vec3 = [
		frameOriginEcef[0] + d[0],
		frameOriginEcef[1] + d[1],
		frameOriginEcef[2] + d[2],
	];
	const g = ecefToGeodetic(C_ecef[0], C_ecef[1], C_ecef[2]);

	const R_w2c_ecef = mat3T(R_cam2ecef);
	const rc = mat3Vec(R_w2c_ecef, C_ecef);
	const t_w2c_ecef: Vec3 = [-rc[0], -rc[1], -rc[2]];
	const R_w2c_enu = mat3T(R_cam2enu);
	const re = mat3Vec(R_w2c_enu, eye);
	const t_w2c_enu: Vec3 = [-re[0], -re[1], -re[2]];

	return {
		input,
		imageName: input.imageName ?? `${input.photoId}.jpg`,
		width: W,
		height: H,
		vfov: pose.vfov,
		hfov,
		dfov,
		f,
		K,
		Kopencv,
		f35: FF35_DIAGONAL_MM / 2 / Math.tan((dfov * D) / 2),
		lat: g.lat,
		lon: g.lon,
		altEllipsoid: g.h,
		altMsl: g.h - N,
		geoidUndulation: N,
		eyeOffset: input.demAtCamera != null ? g.h - N - input.demAtCamera : null,
		R_cam2enu,
		R_enu2ecef,
		R_cam2ecef,
		frameOriginEcef: [
			frameOriginEcef[0],
			frameOriginEcef[1],
			frameOriginEcef[2],
		],
		C_ecef,
		R_w2c_ecef,
		t_w2c_ecef,
		R_w2c_enu,
		t_w2c_enu,
		q_w2c_ecef: mat3ToQuat(R_w2c_ecef),
		q_w2c_enu: mat3ToQuat(R_w2c_enu),
	};
}

/** Plain rigid ENU(frame)→ECEF (no refraction). */
export function enuToEcef(m: CameraModel, enu: ArrayLike<number>): Vec3 {
	const d = mat3Vec(m.R_enu2ecef, enu);
	const o = m.frameOriginEcef;
	return [o[0] + d[0], o[1] + d[1], o[2] + d[2]];
}

/** Project an ECEF point with K[R|t] → pixel (corner-origin), or null if behind the camera. */
export function projectEcef(
	m: CameraModel,
	X: ArrayLike<number>,
	K: Mat3 = m.K,
): { x: number; y: number; depth: number } | null {
	const c = mat3Vec(m.R_w2c_ecef, X);
	const xc = c[0] + m.t_w2c_ecef[0];
	const yc = c[1] + m.t_w2c_ecef[1];
	const zc = c[2] + m.t_w2c_ecef[2];
	if (zc <= 0) return null;
	return {
		x: K[0] * (xc / zc) + K[1] * (yc / zc) + K[2],
		y: K[4] * (yc / zc) + K[5],
		depth: zc,
	};
}

/**
 * Google Earth / KML <Camera> angles for this pose.
 * heading = yaw; tilt = 90 + pitch (0 = straight down, 90 = horizon); roll = −roll
 * (KML roll > 0 rolls the camera to the left, i.e. right side UP; ours is right side down +).
 */
export function kmlCameraAngles(pose: Pose) {
	return {
		heading: wrap360(pose.yaw),
		tilt: 90 + pose.pitch,
		roll: -pose.roll,
	};
}

/**
 * Single COLMAP data lines (cameras.txt camera line / images.txt pose line). World = ECEF unless
 * `world: 'enu'`. NOT a loadable file on its own: images.txt needs a POINTS2D line after every
 * image line — use `colmapFiles` / `buildColmapZip` (colmap.ts) for files COLMAP can read.
 */
export function colmapLines(
	m: CameraModel,
	opts: { cameraId?: number; imageId?: number; world?: "ecef" | "enu" } = {},
) {
	const cid = opts.cameraId ?? 1;
	const iid = opts.imageId ?? 1;
	const enu = opts.world === "enu";
	const q = enu ? m.q_w2c_enu : m.q_w2c_ecef;
	const t = enu ? m.t_w2c_enu : m.t_w2c_ecef;
	const fx = (v: number, p = 12) => Number(v.toPrecision(p)).toString();
	return {
		camera: `${cid} PINHOLE ${m.width} ${m.height} ${fx(m.f)} ${fx(m.f)} ${fx(m.K[2])} ${fx(m.K[5])}`,
		image: `${iid} ${q.map((v) => fx(v, 17)).join(" ")} ${t.map((v) => fx(v, 17)).join(" ")} ${cid} ${m.imageName}`,
	};
}

/** Normalise an angle to [0, 360). */
export function wrap360(deg: number) {
	const a = ((deg % 360) + 360) % 360;
	return a === 360 ? 0 : a;
}

/**
 * Angle in [0, 360) printed with `digits` decimals, wrapping values that round up to 360
 * (e.g. 359.9999999 → "0", not "360").
 */
export function fixedAzimuth(deg: number, digits: number) {
	const scale = 10 ** digits;
	const r = Math.round(wrap360(deg) * scale) % (360 * scale);
	return Number((r / scale).toFixed(digits)).toString();
}
