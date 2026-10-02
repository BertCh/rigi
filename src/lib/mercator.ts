// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Web-Mercator world pixels at zoom z (256 px tiles) for the slippy maps: the DEM tile maths in
// dem/tiles.ts scaled by the tile size, with latitude clamped to the Mercator limit.
import { lonToTileX, tileXToLon, tileYToLat } from "./dem/tiles";

export const MERCATOR_TILE_PX = 256;
const MAX_LAT = 85.05;

export const lonToWorldX = (lon: number, z: number) =>
	lonToTileX(lon, z) * MERCATOR_TILE_PX;
/**
 * Kept apart from latToTileY: it takes sin(lat·π/180) where that takes sin(lat·DEG), which differs
 * by an ULP in the world pixel (up to ~1e-7 px at z18).
 */
export const latToWorldY = (lat: number, z: number) => {
	const s = Math.sin(
		(Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * Math.PI) / 180,
	);
	return (
		(0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) *
		MERCATOR_TILE_PX *
		2 ** z
	);
};
export const worldXToLon = (x: number, z: number) =>
	tileXToLon(x / MERCATOR_TILE_PX, z);
export const worldYToLat = (y: number, z: number) =>
	tileYToLat(y / MERCATOR_TILE_PX, z);
