// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// DEM height at a point from one zoom-z tile alone (the camera's ground height), without loading a whole terrain.
import { tilePriority } from "../cache";
import { sampleGrid } from "./grid";
import { loadDemTile } from "./load";
import { latToTileY, lonToTileX } from "./tiles";

/**
 * DEM height at a point from its zoom-z tile alone, fetched, decoded and sampled with the shared DEM policy
 * (same URL and cache entry, same priority, dem/grid.ts sampleGrid: pixel-centred bilinear, clamped to the
 * tile's outer sample centres). Lets work that needs the camera's ground height (the horizon worker) start
 * before the whole terrain is in. Same value as TerrainSet.heightAt when the finest loaded tile there is this
 * zoom-z tile.
 */
export async function heightFromTile(
	lat: number,
	lon: number,
	z = 14,
	signal?: AbortSignal,
): Promise<number | null> {
	const fx = lonToTileX(lon, z);
	const fy = latToTileY(lat, z);
	const key = { z, x: Math.floor(fx), y: Math.floor(fy) };
	const dem = await loadDemTile(key, { signal, priority: tilePriority(0, z) });
	return (
		dem &&
		sampleGrid(
			dem.heights,
			dem.size,
			(fx - key.x) * dem.size,
			(fy - key.y) * dem.size,
		)
	);
}
