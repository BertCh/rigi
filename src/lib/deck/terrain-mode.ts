// Which terrain path the deck backend draws:
//   "batched" (default since 2026-09-28) one instanced grid per mesh resolution, heights and imagery
//             in texture arrays, the mesh rebuilt in the vertex shader (batched-terrain-layer.ts).
//             Same poses as tiles on eval-app/deck smoke, ≥ 99.8 % identical imagery pixels, draws
//             20–100× fewer, mesh build ~8× faster (research_notes/gpu_compute_plan_2026-09.md)
//   "tiles"   one TerrainTileLayer + luma Model per tile, meshes built on the main thread
// Set with ?terrain=tiles (src/lib/flags; harnesses flip globalThis.__RIGI_FLAGS__.terrain live).
// globalThis.__RIGI_TERRAIN_BOTH__ = true makes the streamer build both representations, so a
// harness can flip the terrain flag on the same tiles (parity checks).
import { getFlag } from "#/lib/flags";

export type TerrainMode = "tiles" | "batched";

type G = {
	__RIGI_TERRAIN_BOTH__?: boolean;
	__rigiTerrainStats?: typeof terrainDrawStats;
};

export function terrainMode(): TerrainMode {
	return getFlag("terrain");
}

/** What the streamer builds per tile: the CPU mesh (per-tile path) and / or the batch grid. */
export function terrainBuild() {
	const both = (globalThis as G).__RIGI_TERRAIN_BOTH__ === true;
	const m = terrainMode();
	return { mesh: both || m === "tiles", grid: both || m === "batched" };
}

/** Diagnostics for harnesses (globalThis.__rigiTerrainStats): terrain draw calls issued so far. */
export const terrainDrawStats = { draws: 0 };
(globalThis as G).__rigiTerrainStats = terrainDrawStats;
