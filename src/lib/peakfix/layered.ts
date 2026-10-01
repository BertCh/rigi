// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Layered horizon (recovered verbatim from GA3 src/lib/geocam/tjunc/layered.ts @ a1845f5^ for PEAKFIX PK0): every visible silhouette crest per azimuth,
// not only the skyline.
//
// The march is a copy of src/lib/geo/horizon.ts:36-93 (0f's file, not imported) generalised to a
// scene-frame HeightFn and an arbitrary eye. Per azimuth the terrain elevation tangent t(d) = (z − z_eye)/d
// is walked outward; its running maximum M is the ray-visible profile. A crest is a sample where M was
// last raised before a hidden stretch (t < M) that ends with terrain re-emerging above M farther out:
// that sample is an occluding contour (a near ridge silhouetted against farther terrain), and the
// re-emergence distance dBack is the depth of what is seen just above it in the image. The final maximum
// is the skyline (dBack = ∞, sky = true). Crests are reported nearest first; their elevation angles
// increase monotonically along the list.
//
// Curvature + refraction: the concord scene frame (scripts/concord/lib.ts) already folds the drop
// d²/(2·R_eff), R_eff = R/(1 − k), k = 0.13 (src/lib/geodesy) into z, so the default leaves heights
// alone; `curvature: "apply"` subtracts it here for a plain-altitude HeightFn.
import type { Vec3 } from "../concord/core";
import { DEG, EARTH_R, REFRACTION_K } from "../geodesy";

/** Scene-frame z at ENU (e, n); d = horizontal distance from the eye (DEM level choice). NaN ⇒ no data. */
export type HeightFn = (e: number, n: number, d: number) => number;

export type Crest = {
	/** Azimuth (deg, clockwise from north). */
	az: number;
	/** Elevation angle from the eye (deg). */
	el: number;
	/** Horizontal distance from the eye (m). */
	d: number;
	/** Horizontal distance of the terrain seen just above the crest (m); Infinity for the skyline. */
	dBack: number;
	/** Scene-frame ENU of the crest point. */
	world: Vec3;
	/** True for the last crest of the azimuth (the skyline). */
	sky: boolean;
};

export type LayeredHorizon = {
	/** Azimuth step (deg); column i is at azimuth az0 + i·step. */
	step: number;
	az0: number;
	eye: Vec3;
	/** Crests per azimuth column, nearest first (last = skyline, if any terrain). */
	crests: Crest[][];
	stats: { samples: number; ms: number };
};

export type LayeredOpts = {
	/** Azimuth step (deg). Default 0.05 (geo/horizon.ts). */
	step?: number;
	/** First / last sample distance (m). Defaults 20 m / 150 km. */
	minD?: number;
	maxD?: number;
	/** Sample spacing max(minStep, growth·d). Defaults 5 m, 0.003 (finer than horizon.ts' 10 m / 0.004). */
	minStep?: number;
	growth?: number;
	/** Keep a crest only if the hidden stretch behind it is ≥ this fraction of its distance. Default 0.3 (ratio 1.3, contours.ts). */
	minOcclusion?: number;
	/** "frame" (default): HeightFn already includes the curvature + refraction drop; "apply": subtract d²/(2·R_eff) here. */
	curvature?: "frame" | "apply";
};

/** Sample distances of the march (shared by every azimuth). */
export function marchDistances(o: LayeredOpts = {}): Float64Array {
	const minD = o.minD ?? 20;
	const maxD = o.maxD ?? 150_000;
	const minStep = o.minStep ?? 5;
	const growth = o.growth ?? 0.003;
	const ds: number[] = [];
	for (let d = minD; d <= maxD; d += Math.max(minStep, d * growth)) ds.push(d);
	return Float64Array.from(ds);
}

/**
 * Every visible silhouette crest for azimuths in `sector` = [a0, a1] (deg, a1 > a0; may exceed 360) from
 * the scene-frame `eye`.
 */
export function layeredHorizon(
	h: HeightFn,
	eye: Vec3,
	sector: [number, number],
	o: LayeredOpts = {},
): LayeredHorizon {
	const t0 = Date.now();
	const step = o.step ?? 0.05;
	const minOcc = o.minOcclusion ?? 0.3;
	const rEff = EARTH_R / (1 - REFRACTION_K);
	const apply = o.curvature === "apply";
	const ds = marchDistances(o);
	const nd = ds.length;
	const az0 = sector[0];
	const nAz = Math.max(
		1,
		Math.floor((sector[1] - sector[0]) / step + 1e-9) + 1,
	);
	const crests: Crest[][] = [];
	const zs = new Float64Array(nd);
	let samples = 0;
	for (let i = 0; i < nAz; i++) {
		const az = az0 + i * step;
		const s = Math.sin(az * DEG);
		const c = Math.cos(az * DEG);
		for (let q = 0; q < nd; q++) {
			const d = ds[q];
			let z = h(eye[0] + d * s, eye[1] + d * c, d);
			if (apply) z -= (d * d) / (2 * rEff);
			zs[q] = z;
		}
		samples += nd;
		const found: Crest[] = [];
		let best = -Infinity;
		let bestQ = -1;
		let prevVisible = false;
		let crestQ = -1;
		const mk = (q: number, dBack: number, sky: boolean): Crest => {
			const d = ds[q];
			const tz = (zs[q] - eye[2]) / d;
			return {
				az,
				el: Math.atan(tz) / DEG,
				d,
				dBack,
				world: [eye[0] + d * s, eye[1] + d * c, zs[q]],
				sky,
			};
		};
		for (let q = 0; q < nd; q++) {
			const z = zs[q];
			if (Number.isNaN(z)) continue;
			const t = (z - eye[2]) / ds[q];
			if (t > best) {
				// re-emerging terrain: the previous crest was occluding something
				if (
					!prevVisible &&
					crestQ >= 0 &&
					ds[q] - ds[crestQ] > minOcc * ds[crestQ]
				)
					found.push(mk(crestQ, ds[q], false));
				best = t;
				bestQ = q;
				crestQ = q;
				prevVisible = true;
			} else prevVisible = false;
		}
		if (bestQ >= 0) found.push(mk(bestQ, Infinity, true));
		crests.push(found);
	}
	return {
		step,
		az0,
		eye: [eye[0], eye[1], eye[2]],
		crests,
		stats: { samples, ms: Date.now() - t0 },
	};
}
