// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { DEG, EARTH_R, REFRACTION_K } from "../geodesy";
import type { TerrainSampler } from "./terrain";

export interface Ridge {
	/** Elevation angle, degrees. */
	elevation: number;
	distance: number;
}

export interface HorizonProfile {
	/** Azimuth step, degrees; sample i is at azimuth i * step. */
	step: number;
	/** Skyline elevation angle per azimuth, degrees. */
	elevation: Float32Array;
	/** Distance to the skyline point per azimuth, metres. */
	distance: Float32Array;
	/** Visible ridge crests (inner silhouettes) per azimuth, nearest first. */
	ridges: Ridge[][];
}

export interface HorizonOptions {
	step?: number;
	maxDistance?: number;
	minDistance?: number;
	/** Only report ridges that hide at least this fraction of their distance. */
	minOcclusion?: number;
	/** Ray step as a fraction of distance (min 10 m). */
	stepFactor?: number;
}

/**
 * Ray-marches the DEM outward from the camera for every azimuth and returns
 * the skyline (max elevation angle) plus the visible ridge crests. Curvature
 * and refraction are applied as a drop of d² / (2 R_eff).
 */
export function computeHorizon(
	terrain: TerrainSampler,
	lat: number,
	lon: number,
	eyeHeight: number,
	opts: HorizonOptions = {},
): HorizonProfile {
	const step = opts.step ?? 0.05;
	const maxDistance = opts.maxDistance ?? 150_000;
	const minDistance = opts.minDistance ?? 20;
	const minOcclusion = opts.minOcclusion ?? 0.08;
	const stepFactor = opts.stepFactor ?? 0.004;
	const rEff = EARTH_R / (1 - REFRACTION_K);

	const distances: number[] = [];
	for (let d = minDistance; d <= maxDistance; d += Math.max(10, d * stepFactor))
		distances.push(d);
	// geodesy.destination, unrolled: the same expressions in the same order (bit-identical), with the
	// per-distance, per-azimuth and per-eye trig hoisted out of the inner loop.
	const nd = distances.length;
	const sinD = new Float64Array(nd);
	const cosD = new Float64Array(nd);
	const drop = new Float64Array(nd);
	for (let j = 0; j < nd; j++) {
		const d = distances[j];
		sinD[j] = Math.sin(d / EARTH_R);
		cosD[j] = Math.cos(d / EARTH_R);
		drop[j] = (d * d) / (2 * rEff);
	}
	const p1 = lat * DEG;
	const sinP1 = Math.sin(p1);
	const cosP1 = Math.cos(p1);
	const lon1 = lon * DEG;

	const n = Math.round(360 / step);
	const elevation = new Float32Array(n);
	const distance = new Float32Array(n);
	const ridges: Ridge[][] = [];

	for (let i = 0; i < n; i++) {
		const a = i * step * DEG;
		const sinA = Math.sin(a);
		const cosA = Math.cos(a);
		let best = -90;
		let bestD = 0;
		let crest: Ridge | null = null;
		let prevVisible = false;
		const found: Ridge[] = [];
		for (let j = 0; j < nd; j++) {
			const d = distances[j];
			const sinP2 = sinP1 * cosD[j] + cosP1 * sinD[j] * cosA;
			const pLat = Math.asin(sinP2) / DEG;
			const pLon =
				(lon1 + Math.atan2(sinA * sinD[j] * cosP1, cosD[j] - sinP1 * sinP2)) /
				DEG;
			const h = terrain.sampleAt(pLon, pLat, d);
			if (Number.isNaN(h)) continue;
			const angle = Math.atan2(h - eyeHeight - drop[j], d) * (180 / Math.PI);
			if (angle > best) {
				best = angle;
				bestD = d;
				// Re-emerging terrain: the previous crest was occluding something.
				if (
					!prevVisible &&
					crest &&
					d - crest.distance > minOcclusion * crest.distance
				)
					found.push(crest);
				crest = { elevation: angle, distance: d };
				prevVisible = true;
			} else {
				prevVisible = false;
			}
		}
		elevation[i] = best;
		distance[i] = bestD;
		ridges.push(found);
	}
	return { step, elevation, distance, ridges };
}
