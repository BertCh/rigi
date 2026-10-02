// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// /live has no photo file, but the engines are built around a PhotoMeta (eye position, size, prior). This
// makes one from an eye fix and the frame size, and picks the nearest bundled region (peaks, trails) for it.

import { distanceM } from "../geodesy";
import type { PhotoMeta } from "../photos";
import type { EyeFix } from "./contract";

/** Empty src = placeholder photo: the engines skip the decode, segmentation and edge map, and the live frames fill the texture. */
export const LIVE_PLACEHOLDER_SRC = "";

/** Farther than this from every bundled photo, no region is loaded (labels then come from nothing). */
export const REGION_MAX_DISTANCE_M = 80_000;

/** 35 mm-equivalent focal length (long side of a 36 mm frame) for a vertical field of view and frame shape. */
export function equivalentFocalLength(
	vfov: number,
	frame: { width: number; height: number },
): number {
	const tanVertical = Math.tan((vfov * Math.PI) / 360);
	const aspect = frame.width / frame.height;
	return 18 / (aspect >= 1 ? tanVertical * aspect : tanVertical);
}

export function makeEyePhoto(
	eye: Pick<EyeFix, "lat" | "lon" | "alt" | "accuracy">,
	frame: { width: number; height: number },
	vfov: number,
	region: string,
	now = new Date(),
): PhotoMeta {
	return {
		id: "live",
		src: LIVE_PLACEHOLDER_SRC,
		width: frame.width,
		height: frame.height,
		takenAt: now.toISOString(),
		lat: eye.lat,
		lon: eye.lon,
		// GPS altitude is above the ellipsoid, not MSL: leave it to the DEM
		alt: null,
		hAccuracy: eye.accuracy,
		heading: null,
		f35: equivalentFocalLength(vfov, frame),
		vfov,
		gravity: null,
		pitch: 0,
		roll: 0,
		holding: null,
		region,
	};
}

/** Region id of the bundled photo nearest to the eye, or null when none is within REGION_MAX_DISTANCE_M. */
export function nearestRegion(
	eye: { lat: number; lon: number },
	photos: readonly Pick<PhotoMeta, "lat" | "lon" | "region">[],
): string | null {
	let best: string | null = null;
	let bestDistance = REGION_MAX_DISTANCE_M;
	for (const photo of photos) {
		const d = distanceM(eye, photo);
		if (d < bestDistance) {
			bestDistance = d;
			best = photo.region;
		}
	}
	return best;
}
