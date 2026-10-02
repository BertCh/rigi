// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The sample trip's roll map, baked once by scripts/demo/bake-roll-map.mjs from a run of the live
// path with the landing's settings (LiveRollMap: 1024 px photos, the baked people masks, the "muted"
// basemap = satellite imagery), so the landing's live map needs neither Mapterhorn nor the WMTS
// tiles, nor any range-map readback or clear-air fit. Layouts: #/lib/roll/map/roll-seed.
// A failure rejects, and the engine then takes the live path for that part. The imagery and photo
// parts are not memoised: the engine keeps what it uses, and a later engine refetches from the HTTP
// cache. The terrain decode is shared (demoTerrainSeed) with the landing's Step Inside, which serves
// its far tiles from it (deck/seeded-tiles.ts) while it holds it.
import { sharedSeed } from "../deck/seeded-tiles";
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

/** How long the live map keeps the shared terrain decode after reading it (ms). */
const TERRAIN_SEED_HOLD_MS = 60_000;

/** The terrain seed's decode, shared while any user holds it (~64 MB of Float32 heights). */
export const demoTerrainSeed = sharedSeed(async () =>
	decodeTerrainSeed(await fetchGzip(url("terrain"))),
);

/** The sample trip's seed for RollMapOptions.seed. */
export const demoRollMapSeed: RollMapSeed = {
	// the engine keeps the rasters it uses; the shared decode is held a while longer so Step Inside
	// (the next section down) usually reuses it instead of decoding ~64 MB again
	terrain: async () => {
		const held = demoTerrainSeed.acquire();
		try {
			return await held.seed;
		} finally {
			setTimeout(held.release, TERRAIN_SEED_HOLD_MS);
		}
	},
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
