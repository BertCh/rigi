// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// loadScene outside Mapterhorn's regional (z13–17) coverage: the finest level 404s, coarser ones exist
// (reports/steps-2026-10-02/terrain-sampler.md §2 P1, proposal §5.1). Pins today's behaviour; the
// proposed fix (ground from terrain.ground()) flips the first case.
import { describe, expect, it } from "vitest";
import type { DemSource, TileKey } from "../../dem";
import { loadScene } from "../pipeline";
import { TerrainSampler } from "../terrain";

const SIZE = 4;
const DEM: DemSource = {
	name: "test",
	url: () => "",
	tileSize: SIZE,
	maxZoom: 15,
	levels: [
		{ z: 15, maxDistance: 1_000 },
		{ z: 12, maxDistance: 150_000 },
	],
};
/** Only zoom ≤ 12 exists (each tile flat at 2000 m), like Mapterhorn's planet archive. */
const coarseOnly = async (k: TileKey) =>
	k.z <= 12 ? new Float32Array(SIZE * SIZE).fill(2000) : undefined;

describe("loadScene without the finest level", () => {
	it("throws today although a coarser level covers the fix (P1)", async () => {
		await expect(
			loadScene(27.988, 86.925, null, DEM, coarseOnly),
		).rejects.toThrow(/No DEM data/);
	});

	it("the sampler itself has the ground: terrain.ground() falls back to the coarser level", async () => {
		// the proposed fix's value, through the same tiles (level 0 present → identical to sample(level 0))
		const all = async (k: TileKey) =>
			new Float32Array(SIZE * SIZE).fill(k.z === 15 ? 3000 : 2000);
		const full = await loadScene(27.988, 86.925, null, DEM, all);
		expect(full.ground).toBe(3000);
		expect(full.terrain.ground(86.925, 27.988)).toBe(full.ground);
		const tiles = new Map<string, Float32Array>();
		await expect(
			loadScene(27.988, 86.925, null, DEM, coarseOnly, tiles),
		).rejects.toThrow();
		// tiles of the failed load stay in the shared cache: a sampler over them answers at z12
		expect(
			new TerrainSampler(DEM.levels, tiles, SIZE).ground(86.925, 27.988),
		).toBe(2000);
	});
});
