// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// A StreamOptions.loadTile that serves DEM tiles from a baked seed (the roll map's terrain.bin,
// roll/map/roll-seed.ts decodeTerrainSeed) and falls through to another loader for the rest. A seed
// raster can only be downsampled, never upsampled: it is used when it is at least as big as the
// raster the default path would hand the mesh for that `seg`.
import type { DemRaster } from "../dem/load";
import { tileId } from "../dem/tiles";
import { fitStreamTile, type StreamTileLoader } from "./terrain-stream";

/** Full Mapterhorn tile size: what loadDemTile returns before the stream's downsamples. */
const FULL_TILE_SIZE = 512;

/** The raster size the default path (defaultStreamTile) feeds a `seg`-segment mesh. */
export function streamTileNeed(seg: number): number {
	let size = FULL_TILE_SIZE;
	while (size > 2 * seg && size > 256) size /= 2;
	return size;
}

/**
 * Seeded tiles first: `fitStreamTile(seeded, seg)` when the seeded raster has at least
 * `streamTileNeed(seg)` samples a side, else `fallback` (defaultStreamTile or the GPU decode loader).
 * The seeded raster carries CPU `heights`, which the stream accepts without GPU decode.
 */
export function seededTileLoader(
	seed: ReadonlyMap<string, DemRaster>,
	fallback: StreamTileLoader,
): StreamTileLoader {
	return async (key, seg, o) => {
		const seeded = seed.get(tileId(key));
		if (seeded && seeded.size >= streamTileNeed(seg))
			return fitStreamTile(seeded, seg);
		return fallback(key, seg, o);
	};
}

/**
 * One decode shared by every user of a seed (the live map and Step Inside): `acquire` starts the
 * decode on the first call, every call returns the same promise, and the decoded map (~64 MB of
 * Float32 for the sample trip) is dropped when the last `release` runs.
 */
export function sharedSeed<T>(decode: () => Promise<T>) {
	let users = 0;
	let value: Promise<T> | null = null;
	return {
		acquire() {
			users++;
			if (!value) {
				const p: Promise<T> = decode().catch((e) => {
					// a failed decode is retried by the next user (unless a newer one already started)
					if (value === p) value = null;
					throw e;
				});
				value = p;
			}
			let released = false;
			return {
				seed: value,
				release() {
					if (released) return;
					released = true;
					if (--users === 0) value = null;
				},
			};
		},
	};
}
