// Which terrain path the deck backend draws:
//   "batched" (default since 2026-09-28) one instanced grid per mesh resolution, heights and imagery
//             in texture arrays, the mesh rebuilt in the vertex shader (batched-terrain-layer.ts).
//             Same poses as tiles on eval-app/deck smoke, ≥ 99.8 % identical imagery pixels, draws
//             20–100× fewer, mesh build ~8× faster (research_notes/gpu_compute_plan_2026-09.md)
//   "tiles"   one TerrainTileLayer + luma Model per tile, meshes built on the main thread
// Checked in order: globalThis.__RIGI_TERRAIN__ (tests; read live), ?terrain=batched|tiles in the
// page URL, localStorage "rigi.terrain" (both read once per page load).
// globalThis.__RIGI_TERRAIN_BOTH__ = true makes the streamer build both representations, so a
// harness can flip __RIGI_TERRAIN__ on the same tiles (parity checks).

export type TerrainMode = "tiles" | "batched";

type G = {
	__RIGI_TERRAIN__?: TerrainMode;
	__RIGI_TERRAIN_BOTH__?: boolean;
	__rigiTerrainStats?: typeof terrainDrawStats;
};

let fromPage: TerrainMode | null = null;

function readPage(): TerrainMode {
	try {
		const q = new URLSearchParams(globalThis.location?.search ?? "").get(
			"terrain",
		);
		if (q === "batched" || q === "tiles") return q;
	} catch {}
	try {
		const s = globalThis.localStorage?.getItem("rigi.terrain");
		if (s === "batched" || s === "tiles") return s;
	} catch {}
	return "batched";
}

export function terrainMode(): TerrainMode {
	const g = (globalThis as G).__RIGI_TERRAIN__;
	if (g === "tiles" || g === "batched") return g;
	fromPage ??= readPage();
	return fromPage;
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
