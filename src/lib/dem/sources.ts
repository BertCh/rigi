// Terrarium-encoded DEM tile services (h = R·256 + G + B/256 − 32768).
import type { TileKey } from "./tiles";

export interface TerrainLevel {
	z: number;
	/** Use this level for samples up to this distance from the camera (m). */
	maxDistance: number;
}

/** Fine near the camera, coarse far away (256 px AWS tiles). */
export const TERRAIN_LEVELS: TerrainLevel[] = [
	{ z: 13, maxDistance: 4_000 },
	{ z: 11, maxDistance: 40_000 },
	{ z: 10, maxDistance: 150_000 },
];

export interface DemSource {
	name: string;
	url(key: TileKey): string;
	tileSize: number;
	/** Deepest zoom the service has anywhere. */
	maxZoom: number;
	/** Default distance bands for geo/terrain's TerrainSampler. */
	levels: TerrainLevel[];
}

/** AWS open-data Terrarium: 256 px PNG, global, ~30–90 m (smooths summits and cliffs). */
export const TERRARIUM_AWS: DemSource = {
	name: "terrarium",
	url: (k) =>
		`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${k.z}/${k.x}/${k.y}.png`,
	tileSize: 256,
	maxZoom: 15,
	levels: TERRAIN_LEVELS,
};

/**
 * Mapterhorn: 512 px WebP Terrarium, up to z17 where a national high-res DEM
 * exists (swissALTI3D in CH, RGE ALTI in FR), coarser global coverage;
 * user-approved and preferred. A 512 px tile at zoom z matches a 256 px tile
 * at z+1, hence one zoom lower than TERRAIN_LEVELS, plus two finer near-field
 * levels. Missing fine tiles fall back to coarser levels in
 * TerrainSampler.sampleAt.
 */
export const MAPTERHORN: DemSource = {
	name: "mapterhorn",
	url: (k) => `https://tiles.mapterhorn.com/${k.z}/${k.x}/${k.y}.webp`,
	tileSize: 512,
	maxZoom: 17,
	levels: [
		{ z: 15, maxDistance: 1_000 },
		{ z: 14, maxDistance: 2_500 },
		{ z: 12, maxDistance: 6_000 },
		{ z: 11, maxDistance: 15_000 },
		{ z: 10, maxDistance: 40_000 },
		{ z: 9, maxDistance: 150_000 },
	],
};

export const DEM_SOURCES: Record<string, DemSource> = {
	terrarium: TERRARIUM_AWS,
	mapterhorn: MAPTERHORN,
};
