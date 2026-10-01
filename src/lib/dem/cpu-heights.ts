// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The lazy CPU view of a DEM tile's heights (WAG W2.4). CPU consumers of streamed tiles (TerrainSet
// heightAt / localMax / raycast / lineOfSight, localElevRange, the CPU relief raster, the WebGL height
// pool) read heights through getCpuHeights(tile) instead of assuming every tile was decoded on the CPU.
//
// - A tile decoded on the CPU (loadDemTile, the default everywhere) carries `heights`: getCpuHeights
//   returns it, nothing else happens (the CPU twins are unchanged).
// - A tile whose heights went straight to the GPU (flag terrainGpuDecode, deck-webgpu/terrain-gpu-decode.ts)
//   carries `lazyHeights` instead: getCpuHeights materialises the CPU heights once, with the CPU twin's
//   own code, stores them on the tile and releases the lazy source. `heightStats` (lo / hi, and the
//   stride-7 lo / hi localElevRange samples) come with it, so the batch grid's bounding sphere and the
//   colour-ramp range need no CPU heights.
//
// heightStats() is the CPU twin of those statistics: the same comparisons, in the same order, as
// buildBatchGrid (lo / hi) and localElevRange (every 7th sample) ran inline before.

/** Exact statistics of a tile's final heights (after ancestor crop / downsample). */
export type HeightStats = {
	/** min / max over every sample (buildBatchGrid's bounding box) */
	lo: number;
	hi: number;
	/** min / max over samples 0, 7, 14, … of the row-major array (localElevRange) */
	lo7: number;
	hi7: number;
};

/** A source that can produce a tile's CPU heights on demand. */
export type LazyCpuHeights = {
	/** The tile's heights (size × size, row 0 = north), computed with the CPU twin's code. */
	materialize(): Float32Array;
	/** Drop what the source holds (called once the heights exist on the tile). */
	release?(): void;
};

/** Anything that holds DEM heights eagerly, lazily, or both. */
export type CpuHeightsTile = {
	/** size × size, row-major, row 0 = north edge; undefined until materialised for a lazy tile */
	heights?: Float32Array;
	lazyHeights?: LazyCpuHeights;
	heightStats?: HeightStats;
};

/** Diagnostics: lazy tiles materialised in this realm, and the main-thread ms they took. */
export const cpuHeightsCounters = { materialized: 0, ms: 0 };

/**
 * The tile's CPU heights: `heights` when present, else materialised once from `lazyHeights` (then
 * stored on the tile; the lazy source is released). Throws for a tile with neither (a bug).
 */
export function getCpuHeights(tile: CpuHeightsTile): Float32Array {
	const h = tile.heights;
	if (h) return h;
	const lazy = tile.lazyHeights;
	// invariant: every tile is built with eager heights or a lazy source (dem/cpu-heights.ts)
	if (!lazy) throw new Error("dem: tile has neither CPU heights nor a source");
	const t0 = performance.now();
	const out = lazy.materialize();
	tile.heights = out;
	tile.lazyHeights = undefined;
	lazy.release?.();
	cpuHeightsCounters.materialized++;
	cpuHeightsCounters.ms += performance.now() - t0;
	return out;
}

/** True when getCpuHeights(tile) costs nothing (no materialisation). */
export const hasCpuHeights = (tile: CpuHeightsTile) => tile.heights != null;

/** The CPU twin of HeightStats: buildBatchGrid's and localElevRange's scans, verbatim. */
export function heightStats(heights: Float32Array): HeightStats {
	let lo = Number.POSITIVE_INFINITY;
	let hi = Number.NEGATIVE_INFINITY;
	for (let i = 0; i < heights.length; i++) {
		const h = heights[i];
		if (h < lo) lo = h;
		if (h > hi) hi = h;
	}
	let lo7 = Number.POSITIVE_INFINITY;
	let hi7 = Number.NEGATIVE_INFINITY;
	for (let i = 0; i < heights.length; i += 7) {
		if (heights[i] < lo7) lo7 = heights[i];
		if (heights[i] > hi7) hi7 = heights[i];
	}
	return { lo, hi, lo7, hi7 };
}
