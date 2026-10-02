// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

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
 *
 * Heights (checked 2026-10-02 against the Mapterhorn pipeline, pipelines/utils.py, and decoded tiles):
 * - The WebP is lossless; heights are rounded to min(1, 2^(19 − z) / 256) m, so 1 m at z ≤ 11 and
 *   1/16 m at z15 (at most 0.5 m off: < 0.001° at 40 km, negligible for a skyline).
 * - Each source keeps its own vertical reference (no geoid step in the pipeline): swissALTI3D is
 *   LN02 (levelled, within 0.4 m of LHN95 orthometric), Copernicus GLO-30 is EGM2008. Both are
 *   "above sea level", which is what Height<"msl"> means here; steps at source seams are expected to
 *   be metre-scale but are unmeasured. Ellipsoidal heights differ by about 50 m (tiles3d/geoid.ts).
 */
export const MAPTERHORN_DEFAULT_URL =
	"https://tiles.mapterhorn.com/{z}/{x}/{y}.webp";

/**
 * Tile URL template: VITE_MAPTERHORN_URL (browser build) or MAPTERHORN_URL (Node scripts), e.g. a
 * self-hosted `pmtiles serve` endpoint (reports/licences.md); default the public service. Must
 * serve the same tiles (512 px Terrarium WebP) or every DEM consumer changes.
 */
function mapterhornTemplate(): string {
	let t: string | undefined;
	try {
		t = (import.meta as { env?: Record<string, string | undefined> }).env
			?.VITE_MAPTERHORN_URL;
	} catch {}
	t ||= (
		globalThis as { process?: { env?: Record<string, string | undefined> } }
	).process?.env?.MAPTERHORN_URL;
	return t || MAPTERHORN_DEFAULT_URL;
}
const MAPTERHORN_TEMPLATE = mapterhornTemplate();

/** An XYZ tile URL from a `{z}/{x}/{y}` template (every occurrence of each placeholder). */
export function tileUrlFromTemplate(template: string, k: TileKey): string {
	return template
		.replaceAll("{z}", String(k.z))
		.replaceAll("{x}", String(k.x))
		.replaceAll("{y}", String(k.y));
}

export const MAPTERHORN: DemSource = {
	name: "mapterhorn",
	url:
		MAPTERHORN_TEMPLATE === MAPTERHORN_DEFAULT_URL
			? (k) => `https://tiles.mapterhorn.com/${k.z}/${k.x}/${k.y}.webp`
			: (k) => tileUrlFromTemplate(MAPTERHORN_TEMPLATE, k),
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
