// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Step Inside 3D Tiles (reports/step-inside-google-3d-tiles.md): which OGC 3D Tiles sources are shown
// around the eye while stepping, from ?tiles3d= (src/lib/flags; default off).
//   ?tiles3d=off | buildings | swisstopo | google | all      (swisstopo = buildings + vegetation)
//   ?tiles3dBlend=fill (default) | over
//     fill: tiles only where the photo does not cover the view (outside its frame): the photo drape
//           stays the truth inside the frame and the tiles extend it when you look around
//     over: tiles everywhere (alignment check against the photo; the DEM loses the depth test to them)
// Google tiles are display-only (Map Tiles API policies): never in the geometry / horizon /
// silhouette passes, sampleAt, anchoring, exports or a persistent cache.

import { getFlag } from "#/lib/flags";
import { publicUrl } from "#/lib/public-url";

export type Tiles3DSourceId =
	| "swisstopo-buildings"
	| "swisstopo-vegetation"
	| "google";

export type Tiles3DSource = {
	id: Tiles3DSourceId;
	url: string;
	/** Static credit line (Google adds the per-tile copyrights, tiles3d getAttributions). */
	credit: string;
	/**
	 * What the tileset's ECEF heights are: "ellipsoidal" (true WGS84: Google) or "msl" (MSL heights put
	 * in the ellipsoid slot, as swisstopo's Cesium tilesets and Rigi's own ENU frame do). Measured
	 * 2026-09-29 at IMG_7018: swissBUILDINGS3D bases sit a median 2.8 m below the DEM with N = 0, and 53 m
	 * above it with N applied (probe in scripts/tiles3d/step-tiles-check.mjs --datum).
	 */
	heights: "ellipsoidal" | "msl";
	/** Display only: must never be read back (Google's terms). */
	displayOnly: boolean;
	/** Screen-space error target (px). */
	errorTarget: number;
	/**
	 * Log-depth bias toward the camera (w scale < 1) so coincident tile / DEM surfaces resolve to the
	 * tile instead of z-fighting (Google is a DSM over our DTM).
	 */
	depthBias: number;
	/** Solid colour for untextured meshes (swisstopo buildings / trees), sRGB 0..1. */
	fallbackColor: [number, number, number];
};

export const TILES3D_SOURCES: Record<Tiles3DSourceId, Tiles3DSource> = {
	"swisstopo-buildings": {
		id: "swisstopo-buildings",
		url: "https://3d.geo.admin.ch/ch.swisstopo.swissbuildings3d.3d/v1/tileset.json",
		credit: "Buildings © swisstopo",
		heights: "msl",
		displayOnly: false,
		errorTarget: 8,
		depthBias: 0.998,
		fallbackColor: [0.82, 0.8, 0.76],
	},
	"swisstopo-vegetation": {
		id: "swisstopo-vegetation",
		url: "https://3d.geo.admin.ch/ch.swisstopo.vegetation.3d/v1/tileset.json",
		credit: "Vegetation © swisstopo",
		heights: "msl",
		displayOnly: false,
		errorTarget: 8,
		depthBias: 0.998,
		fallbackColor: [0.33, 0.45, 0.28],
	},
	google: {
		id: "google",
		url: "https://tile.googleapis.com/v1/3dtiles/root.json",
		credit: "Google",
		heights: "ellipsoidal",
		displayOnly: true,
		errorTarget: 12,
		// its ground sits a few m under the Mapterhorn DTM in places (p10 −3 m at IMG_7018): 3% of range
		depthBias: 0.97,
		fallbackColor: [0.6, 0.6, 0.6],
	},
};

/** Evidence id of the nDSM (swissSURFACE3D - swissALTI3D, concord/occl): measurable, not a tile source. */
export const NDSM_SOURCE_ID = "ndsm";

/**
 * Licence gate for the split / readout / anchoring: true only for the nDSM and tile sources that are not
 * display-only. Google (displayOnly) and unknown ids are false.
 */
export function isMeasurableSource(id: string): boolean {
	if (id === NDSM_SOURCE_ID) return true;
	const s = (TILES3D_SOURCES as Record<string, Tiles3DSource | undefined>)[id];
	return !!s && !s.displayOnly;
}

/** Where the official Google Maps logo must be shipped (Tiles3DCredit.tsx shows it from there). */
export const GOOGLE_LOGO_ASSET = publicUrl("/tiles3d/google-maps-logo.png");

/**
 * Hard gate for Google tiles in a public (non-dev) build: false until the official logo asset exists
 * (`logoPresent`, supplied by the build or a probe; Google's policy requires logo + copyrights).
 * Dev builds are always allowed. The attribution component is Pod E's, this is only the gate.
 */
export function googleTilesPublicUseAllowed(opts: {
	dev: boolean;
	logoPresent: boolean;
}): boolean {
	return opts.dev || opts.logoPresent;
}

export type Tiles3DBlend = "fill" | "over";

export type Tiles3DConfig = {
	sources: Tiles3DSourceId[];
	blend: Tiles3DBlend;
	/** Tiles within this distance (m) of the eye load; they dither out from fadeStart to radius. */
	radius: number;
	fadeStart: number;
};

export const TILES3D_RADIUS = 3000;
export const TILES3D_FADE_START = 2200;

/** Google Maps Platform key (.env.local VITE_GOOGLE_TILES_KEY); Google tiles are skipped without it. */
export function googleTilesKey(): string | undefined {
	const k = (import.meta as { env?: Record<string, string | undefined> }).env
		?.VITE_GOOGLE_TILES_KEY;
	return k || undefined;
}

export function parseTiles3DSources(v: string | null): Tiles3DSourceId[] {
	switch ((v ?? "off").trim().toLowerCase()) {
		case "swisstopo":
			return ["swisstopo-buildings", "swisstopo-vegetation"];
		case "buildings":
			return ["swisstopo-buildings"];
		case "google":
			return ["google"];
		case "all":
			return ["google", "swisstopo-buildings", "swisstopo-vegetation"];
		default:
			return [];
	}
}

/** The 3D Tiles configuration for this page load, or null when off (the default). */
export function tiles3dConfig(): Tiles3DConfig | null {
	let sources = parseTiles3DSources(getFlag("tiles3d"));
	// TODO(pod-E attribution): replace logoPresent (false until the official logo ships in
	// public/tiles3d/, GOOGLE_LOGO_ASSET) with the attribution component's readiness before a public build.
	if (
		sources.includes("google") &&
		!googleTilesPublicUseAllowed({
			dev: !!(import.meta as { env?: { DEV?: boolean } }).env?.DEV,
			logoPresent: false,
		})
	) {
		console.warn(
			"[tiles3d] Google logo asset missing: Google tiles skipped in a public build",
		);
		sources = sources.filter((s) => s !== "google");
	}
	if (sources.includes("google") && !googleTilesKey()) {
		console.warn("[tiles3d] no VITE_GOOGLE_TILES_KEY: Google tiles skipped");
		sources = sources.filter((s) => s !== "google");
	}
	if (!sources.length) return null;
	const blend: Tiles3DBlend = getFlag("tiles3dBlend");
	return {
		sources,
		blend,
		radius: TILES3D_RADIUS,
		fadeStart: TILES3D_FADE_START,
	};
}
