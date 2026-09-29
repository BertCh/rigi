import { destination, EARTH_R, REFRACTION_K } from "../geodesy";
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

	const n = Math.round(360 / step);
	const elevation = new Float32Array(n);
	const distance = new Float32Array(n);
	const ridges: Ridge[][] = [];

	for (let i = 0; i < n; i++) {
		const az = i * step;
		let best = -90;
		let bestD = 0;
		let crest: Ridge | null = null;
		let prevVisible = false;
		const found: Ridge[] = [];
		for (const d of distances) {
			const p = destination(lat, lon, az, d);
			const h = terrain.sampleAt(p.lon, p.lat, d);
			if (Number.isNaN(h)) continue;
			const angle =
				Math.atan2(h - eyeHeight - (d * d) / (2 * rEff), d) * (180 / Math.PI);
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
