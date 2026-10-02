// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * Multi-level Terrarium DEM sampler (tiles, sources and decoding: src/lib/dem).
 */
import {
	lonLatToTile,
	TERRAIN_LEVELS,
	type TerrainLevel,
	type TileKey,
	tileId,
	tilesAround,
} from "../dem";
import type { Height } from "../ontology/core/quantity";

/** Default tile size (AWS Terrarium). Pass the real size for other sources. */
export const TILE_SIZE = 256;

/**
 * Bilinear sampler over preloaded Terrarium tiles at several zooms: fine
 * near the camera, coarse far away. Missing tiles sample as NaN.
 */
export class TerrainSampler {
	constructor(
		readonly levels: TerrainLevel[],
		private readonly tiles: Map<string, Float32Array>,
		readonly tileSize = TILE_SIZE,
	) {}

	/** The loaded tiles by `z/x/y` id, in load order (read-only: identity and order key caches). */
	get tileSet(): ReadonlyMap<string, Float32Array> {
		return this.tiles;
	}

	/** Bilinear DEM height at (lon, lat) on zoom z: metres above mean sea level (Terrarium / Mapterhorn). */
	sample(lon: number, lat: number, z: number): Height<"msl"> {
		const t = lonLatToTile(lon, lat, z);
		const px = t.x * this.tileSize - 0.5;
		const py = t.y * this.tileSize - 0.5;
		const x0 = Math.floor(px);
		const y0 = Math.floor(py);
		const fx = px - x0;
		const fy = py - y0;
		const h00 = this.pixel(z, x0, y0);
		const h10 = this.pixel(z, x0 + 1, y0);
		const h01 = this.pixel(z, x0, y0 + 1);
		const h11 = this.pixel(z, x0 + 1, y0 + 1);
		return (
			(h00 * (1 - fx) + h10 * fx) * (1 - fy) + (h01 * (1 - fx) + h11 * fx) * fy
		);
	}

	/** Samples at the level appropriate for `distance`. */
	/**
	 * Samples at the level appropriate for `distance`, falling back to
	 * coarser levels where a fine tile is missing (e.g. Mapterhorn's high
	 * zooms outside national-lidar coverage).
	 */
	sampleAt(lon: number, lat: number, distance: number) {
		let i = this.levels.findIndex((l) => distance <= l.maxDistance);
		if (i < 0) i = this.levels.length - 1;
		for (; i < this.levels.length; i++) {
			const h = this.sample(lon, lat, this.levels[i].z);
			if (!Number.isNaN(h)) return h;
		}
		return Number.NaN;
	}

	/** Height at the camera position from the finest level that has data. */
	ground(lon: number, lat: number) {
		return this.sampleAt(lon, lat, 0);
	}

	private pixel(z: number, gx: number, gy: number) {
		const n = this.tileSize;
		const tx = Math.floor(gx / n);
		const ty = Math.floor(gy / n);
		const tile = this.tiles.get(`${z}/${tx}/${ty}`);
		if (!tile) return Number.NaN;
		return tile[(gy - ty * n) * n + (gx - tx * n)];
	}
}

export type TileLoader = (key: TileKey) => Promise<Float32Array | undefined>;

/**
 * Loads every tile needed around (lat, lon) through `loadTile` (browser or
 * Node specific) and returns a sampler. `tiles` can be shared across calls
 * as a cache.
 */
export async function loadTerrain(
	lat: number,
	lon: number,
	loadTile: TileLoader,
	levels: TerrainLevel[] = TERRAIN_LEVELS,
	tiles: Map<string, Float32Array> = new Map(),
	concurrency = 16,
	tileSize = TILE_SIZE,
) {
	const keys = levels
		.flatMap((l) => tilesAround(lat, lon, l.maxDistance, l.z))
		.filter((k) => !tiles.has(tileId(k)));
	for (let i = 0; i < keys.length; i += concurrency)
		await Promise.all(
			keys.slice(i, i + concurrency).map(async (k) => {
				const t = await loadTile(k);
				if (!t) return;
				// A wrong size would silently scramble heights, so fail loudly.
				if (t.length !== tileSize * tileSize)
					throw new Error(
						`Tile ${tileId(k)} has ${t.length} samples, expected ${tileSize}²`,
					);
				tiles.set(tileId(k), t);
			}),
		);
	return new TerrainSampler(levels, tiles, tileSize);
}
