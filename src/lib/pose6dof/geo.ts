// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Helpers to build correspondences and priors from geographic data (lat/lon/ele, az/el, photo meta).
import { EnuFrame } from "../geodesy";
import { dirFromAzEl } from "./project";
import type {
	AzimuthCorr,
	DirCorr,
	LevelCorr,
	PointCorr,
	Priors,
} from "./types";

/**
 * ENU frame whose origin is (lat, lon, h). NOTE: the app's renderer (engine.ts) uses
 * `new EnuFrame(photo.lat, photo.lon, 0)` — origin at h = 0 — with the eye at (0, 0, eyeAlt),
 * eyeAlt = max(alt, dem + 1.6). To share the renderer's frame use `engineFrame(lat, lon)` and pass
 * the engine eye to `priorsFromPhoto(photo, { eye })`. `cameraFrame(lat, lon, eyeAlt)` instead puts
 * the origin at the eye (then the default position prior [0,0,0] is right), but its coordinates
 * are NOT interchangeable with engine.ts world coords. fromGeo applies the k = 0.13 refraction drop
 * relative to the origin's tangent plane in both cases.
 */
export const cameraFrame = (lat: number, lon: number, h: number) =>
	new EnuFrame(lat, lon, h);

/** The frame engine.ts renders in: origin at (lat, lon, h = 0). Eye is then (0, 0, eyeAlt). */
export const engineFrame = (lat: number, lon: number) =>
	new EnuFrame(lat, lon, 0);

/** Pixel on a `basis`-px-wide image → normalised u, v (y down). */
export function pxToUV(
	x: number,
	y: number,
	basisWidth: number,
	aspect: number,
) {
	return { u: x / basisWidth, v: y / (basisWidth / aspect) };
}

export function pointCorr(
	frame: EnuFrame,
	lat: number,
	lon: number,
	ele: number,
	u: number,
	v: number,
	label?: string,
): PointCorr {
	const w = frame.fromGeo(lat, lon, ele);
	return { kind: "point", u, v, world: [w[0], w[1], w[2]], label };
}

export function dirCorr(
	az: number,
	el: number,
	u: number,
	v: number,
	label?: string,
): DirCorr {
	return { kind: "dir", u, v, dir: dirFromAzEl(az, el), label };
}

export function levelCorr(
	el: number,
	u: number,
	v: number,
	label?: string,
): LevelCorr {
	return { kind: "level", u, v, el, label };
}

export function azimuthCorr(
	az: number,
	u: number,
	v: number,
	label?: string,
): AzimuthCorr {
	return { kind: "azimuth", u, v, az, label };
}

/**
 * Priors from photo metadata as stored in public/photos/photos.json.
 * Defaults: σH = max(hAccuracy, 5) m, σV = max(1.5·σH, 10) m, gravity σ 2°, compass σ 10°
 * (unknown if no heading), vfov σ 3 %. A missing heading, pitch or roll may be undefined or null
 * (PhotoMeta stores null); either leaves that angle unknown instead of a confident prior at 0°.
 * `heading` must be TRUE north: pass `priorHeading(photo)` (geocam/priors/heading.ts) for uploads
 * whose EXIF ref is magnetic.
 *
 * `o.eye` is the absolute eye position in the correspondences' frame. With the app's engine frame
 * (engineFrame / EnuFrame(lat, lon, 0)) it MUST be `[engine.eye.x, engine.eye.y, engine.eye.z]`;
 * the default [0,0,0] is only correct when the frame origin is the eye (cameraFrame(lat, lon, eyeAlt)).
 */
export function priorsFromPhoto(
	photo: {
		hAccuracy?: number | null;
		heading?: number | null;
		pitch?: number | null;
		roll?: number | null;
		vfov: number;
	},
	o: {
		gravitySigma?: number;
		compassSigma?: number;
		vfovSigmaFrac?: number;
		sigmaV?: number;
		eye?: ArrayLike<number>;
	} = {},
): Priors {
	const sH = Math.max(photo.hAccuracy ?? 15, 5);
	const e = o.eye ?? [0, 0, 0];
	return {
		position: {
			value: [e[0], e[1], e[2]],
			sigmaH: sH,
			sigmaV: o.sigmaV ?? Math.max(1.5 * sH, 10),
		},
		yaw: {
			value: photo.heading ?? 0,
			sigma: photo.heading == null ? undefined : (o.compassSigma ?? 10),
		},
		pitch: {
			value: photo.pitch ?? 0,
			sigma: photo.pitch == null ? undefined : (o.gravitySigma ?? 2),
		},
		roll: {
			value: photo.roll ?? 0,
			sigma: photo.roll == null ? undefined : (o.gravitySigma ?? 2),
		},
		vfov: { value: photo.vfov, sigma: photo.vfov * (o.vfovSigmaFrac ?? 0.03) },
	};
}
