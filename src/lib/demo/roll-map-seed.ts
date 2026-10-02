// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The sample trip's roll map, baked once by scripts/demo/bake-roll-map.mjs from a run of the live
// path with the landing's settings (LiveRollMap: 1024 px photos, the baked people masks, the "muted"
// basemap = satellite imagery), so the landing's live map needs neither Mapterhorn nor the WMTS
// tiles, nor any range-map readback or clear-air fit. Layouts: #/lib/roll/map/roll-seed.
// A failure rejects, and the engine then takes the live path for that part. The big parts are not
// memoised: the engine keeps what it uses, and a later engine refetches from the HTTP cache.
import {
	decodeImagerySeed,
	decodePhotoSeeds,
	decodeTerrainSeed,
	fetchGzip,
	type RollMapSeed,
} from "../roll/map/roll-seed";

export const ROLL_MAP_SEED_DIR = "/demo/roll-map";
export const ROLL_MAP_SEED_FILES = {
	terrain: "terrain.bin",
	imagery: "imagery.bin",
	photos: "photos.bin",
} as const;
/** The imagery blobs' type (the bake encodes WebP). */
export const ROLL_MAP_IMAGERY_TYPE = "image/webp";

const url = (k: keyof typeof ROLL_MAP_SEED_FILES) =>
	`${ROLL_MAP_SEED_DIR}/${ROLL_MAP_SEED_FILES[k]}`;

/** The sample trip's seed for RollMapOptions.seed. */
export const demoRollMapSeed: RollMapSeed = {
	terrain: async () => decodeTerrainSeed(await fetchGzip(url("terrain"))),
	imagery: async () => {
		const res = await fetch(url("imagery"));
		if (!res.ok) throw new Error(`roll map imagery: HTTP ${res.status}`);
		return decodeImagerySeed(
			new Uint8Array(await res.arrayBuffer()),
			ROLL_MAP_IMAGERY_TYPE,
		);
	},
	photos: async () => decodePhotoSeeds(await fetchGzip(url("photos"))),
};
