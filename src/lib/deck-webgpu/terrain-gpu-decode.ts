// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// GPU Terrarium decode for the WebGPU engine's terrain stream (WAG W2.3 wiring + W2.4 lazy CPU view),
// flag terrainGpuDecode (default on; WebGPU engine, batched terrain, ?gpu=on only; WebGL and ?gpu=off
// always decode on the CPU).
//
// Per tile (deck/terrain-stream.ts StreamOptions.loadTile):
//   1. fetchDemBytes, exactly as loadDemTile (shared tile cache, missing-tile policy);
//   2. a tile standing in for a missing one (ancestor crop), an odd size, or more than one 2× step:
//      the CPU path (demRasterFromBytes + fitStreamTile, the default loader's code);
//   3. else createImageBitmap(bytes, no colour conversion / premultiply) → GPU decode (+ 2× box
//      downsample when the mesh wants it) → 32 B of stats back (gpu/ingest terrariumTileStatsGpu);
//   4. any sample validateTile would fill → the CPU path; else a lazy raster: `heightStats` (exact
//      lo / hi for the batch grid, stride-7 lo / hi for the colour ramp) and `lazyHeights`
//      (GpuDecodedHeights: the bitmap, decoded into the height atlas by the batched terrain's
//      TileStore, and into CPU heights by getCpuHeights only when a CPU consumer asks).
// The heights in the atlas and the lazily materialised CPU heights equal the CPU path's bit for bit when
// the texture's texel bytes equal the canvas bytes (scripts/gpu/terrarium-ingest-check.mjs; 1871 cached
// tiles on Apple / Metal, 2026-10-01) and the worker decode equals the page decode (same check).
import type { Device } from "@luma.gl/core";
import type { StreamRaster } from "#/lib/deck/batched-terrain-grid";
import {
	fitStreamTile,
	type StreamTileLoader,
} from "#/lib/deck/terrain-stream";
import {
	cpuHeightsCounters,
	type DemLoadOptions,
	demRasterFromBytes,
	downsampleSteps,
	fetchDemBytes,
	type TileKey,
} from "#/lib/dem";
import {
	GpuDecodedHeights,
	gpuDecodedCounters,
	TERRARIUM_BITMAP_OPTIONS,
	terrariumTileStatsGpu,
} from "#/lib/gpu/ingest/terrarium-tile";

/** Per-realm counts (globalThis.__rigiTerrainGpuDecode): which path each streamed tile took. */
export const terrainGpuDecodeCounters = {
	/** tiles handed to the stream as lazy GPU-decoded rasters */
	gpu: 0,
	/** CPU path: ancestor stand-ins, sizes the kernel does not take, samples to fill, GPU errors */
	cpuAncestor: 0,
	cpuSize: 0,
	cpuInvalid: 0,
	cpuError: 0,
};
/** Harness view: the path counts, lazy materialisations, certificate misses (must stay 0). */
(
	globalThis as {
		__rigiTerrainGpuDecode?: {
			tiles: typeof terrainGpuDecodeCounters;
			cpuHeights: typeof cpuHeightsCounters;
			certificate: typeof gpuDecodedCounters;
		};
	}
).__rigiTerrainGpuDecode = {
	tiles: terrainGpuDecodeCounters,
	cpuHeights: cpuHeightsCounters,
	certificate: gpuDecodedCounters,
};

/**
 * The stream loader for terrainGpuDecode. `device()` resolves the render device (null: the CPU path
 * for this tile, e.g. while the device is lost).
 */
export function gpuDecodeTileLoader(
	device: () => Promise<Device | null>,
): StreamTileLoader {
	return async (key: TileKey, seg: number, o: DemLoadOptions) => {
		const r = await fetchDemBytes(key, o);
		if (!r) return null;
		const cpu = async () => {
			const dem = await demRasterFromBytes(key, r);
			return dem && fitStreamTile(dem, seg);
		};
		if (r.source.z !== key.z) {
			terrainGpuDecodeCounters.cpuAncestor++;
			return cpu();
		}
		const d = await device();
		if (!d || o.signal?.aborted) {
			terrainGpuDecodeCounters.cpuError++;
			return o.signal?.aborted ? null : cpu();
		}
		let bitmap: ImageBitmap;
		try {
			bitmap = await createImageBitmap(
				new Blob([r.buf]),
				TERRARIUM_BITMAP_OPTIONS,
			);
		} catch {
			terrainGpuDecodeCounters.cpuError++;
			return cpu(); // an undecodable image: the CPU path's own null
		}
		const size = bitmap.width;
		const steps = downsampleSteps(size, seg);
		if (bitmap.height !== size || (size !== 256 && size !== 512) || steps > 1) {
			bitmap.close();
			terrainGpuDecodeCounters.cpuSize++;
			return cpu();
		}
		const down = steps ? 2 : 1;
		let stats: Awaited<ReturnType<typeof terrariumTileStatsGpu>>;
		try {
			stats = await terrariumTileStatsGpu(d, bitmap, down);
		} catch {
			bitmap.close();
			terrainGpuDecodeCounters.cpuError++;
			return o.signal?.aborted ? null : cpu();
		}
		if (stats.invalid > 0) {
			// validateTile would fill no-data samples: keep the CPU path's exact fill
			bitmap.close();
			terrainGpuDecodeCounters.cpuInvalid++;
			return cpu();
		}
		terrainGpuDecodeCounters.gpu++;
		const tile: StreamRaster = {
			key,
			source: r.source,
			size: size / down,
			heightStats: {
				lo: stats.lo,
				hi: stats.hi,
				lo7: stats.lo7,
				hi7: stats.hi7,
			},
			lazyHeights: new GpuDecodedHeights(bitmap, down),
		};
		return tile;
	};
}
