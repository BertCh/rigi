// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// DEM height at a point from one zoom-z tile alone (the camera's ground height), without loading a whole terrain.
import { tilePriority } from "../cache";
import { loadDemTile } from "./load";
import { latToTileY, lonToTileX } from "./tiles";

/** Bilinear sample of an S×S grid at fractional tile coords (0..1). */
function sampleTileGrid(h: Float32Array, S: number, fu: number, fv: number) {
	const m = S - 1;
	const x = Math.min(Math.max(fu * S - 0.5, 0), m);
	const y = Math.min(Math.max(fv * S - 0.5, 0), m);
	const x0 = Math.floor(x);
	const y0 = Math.floor(y);
	const x1 = Math.min(x0 + 1, m);
	const y1 = Math.min(y0 + 1, m);
	const fx = x - x0;
	const fy = y - y0;
	const a = h[y0 * S + x0] * (1 - fx) + h[y0 * S + x1] * fx;
	const b = h[y1 * S + x0] * (1 - fx) + h[y1 * S + x1] * fx;
	return a * (1 - fy) + b * fy;
}

/**
 * DEM height at a point from its zoom-z tile alone, fetched, decoded and sampled with the shared DEM policy
 * (same URL and cache entry, same priority, bilinear). Lets work that needs the camera's ground height (the
 * horizon worker) start before the whole terrain is in.
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
	return dem && sampleTileGrid(dem.heights, dem.size, fx - key.x, fy - key.y);
}
