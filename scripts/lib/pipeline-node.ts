// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/** Node helpers shared by baseline scripts: per-photo meta, prior, terrain, cached horizon. */
import fs from "node:fs";
import path from "node:path";
import { DEM_SOURCES } from "../../src/lib/dem";
import { type Camera, cameraFromMeta } from "../../src/lib/geo/camera";
import { computeHorizon, type HorizonProfile } from "../../src/lib/geo/horizon";
import {
	type ExifPhotoMeta,
	readPhotoMeta,
} from "../../src/lib/geo/photo-meta";
import { EYE_ABOVE_GROUND } from "../../src/lib/geo/pipeline";
import { loadTerrain, type TerrainSampler } from "../../src/lib/geo/terrain";
import { CACHE, demTileLoaderNode, imagePixelSize } from "./node-io";

/**
 * Eye-height rule, overridable with EYE=max|gps|ground for experiments.
 * GPS altitude on ridge tops reads 35–70 m above Terrarium ground here.
 */
export type EyeMode = "max" | "gps" | "ground";
export const EYE_MODE: EyeMode = (process.env.EYE as EyeMode) ?? "max";
/** HORIZON=fast uses d1's src/lib/horizon-fast drop-in instead of computeHorizon. */
const HORIZON = process.env.HORIZON ?? "classic";

export function eyeHeight(
	gpsAltitude: number | undefined,
	ground: number,
	mode: EyeMode = EYE_MODE,
) {
	const g = ground + EYE_ABOVE_GROUND;
	if (mode === "ground" || gpsAltitude === undefined) return g;
	if (mode === "gps") return gpsAltitude;
	return Math.max(gpsAltitude, g);
}
/** DEM=terrarium|mapterhorn selects the elevation source. */
export const DEM = DEM_SOURCES[process.env.DEM ?? "terrarium"];
if (!DEM) throw new Error(`Unknown DEM=${process.env.DEM}`);
const loadDemTile = demTileLoaderNode(DEM);
const tileCache = new Map<string, Float32Array>();

export interface PhotoContext {
	name: string;
	meta: ExifPhotoMeta;
	prior: Camera;
	terrain: TerrainSampler;
	ground: number;
	eye: number;
	horizon: HorizonProfile;
}

export async function photoContext(
	name: string,
	heic: string,
): Promise<PhotoContext> {
	const meta = await readPhotoMeta(fs.readFileSync(heic), imagePixelSize(heic));
	if (meta.lat === undefined || meta.lon === undefined)
		throw new Error(`${name}: no GPS`);
	const prior = cameraFromMeta(meta);
	const terrain = await loadTerrain(
		meta.lat,
		meta.lon,
		loadDemTile,
		DEM.levels,
		tileCache,
		16,
		DEM.tileSize,
	);
	// Eye height must come from the same DEM as the horizon.
	const ground = terrain.ground(meta.lon, meta.lat);
	const eye = eyeHeight(meta.altitude, ground);

	const file = path.join(
		CACHE,
		"horizon",
		`${name}_${meta.lat.toFixed(6)}_${meta.lon.toFixed(6)}_${eye.toFixed(1)}${HORIZON === "classic" ? "" : `_${HORIZON}`}${DEM.name === "terrarium" ? "" : `_${DEM.name}`}.json`,
	);
	let horizon: HorizonProfile;
	if (fs.existsSync(file)) {
		const j = JSON.parse(fs.readFileSync(file, "utf8"));
		horizon = {
			step: j.step,
			elevation: Float32Array.from(j.elevation),
			distance: Float32Array.from(j.distance),
			ridges: j.ridges,
		};
	} else {
		if (HORIZON === "fast") {
			const { computeHorizonFastCompat } = await import(
				"../../src/lib/horizon-fast/march"
			);
			horizon = await computeHorizonFastCompat(
				terrain,
				meta.lat,
				meta.lon,
				eye,
			);
		} else horizon = computeHorizon(terrain, meta.lat, meta.lon, eye);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(
			file,
			JSON.stringify({
				step: horizon.step,
				elevation: Array.from(horizon.elevation),
				distance: Array.from(horizon.distance),
				ridges: horizon.ridges,
			}),
		);
	}
	return { name, meta, prior, terrain, ground, eye, horizon };
}
