// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { beforeEach, describe, expect, it, vi } from "vitest";

const dem = vi.hoisted(() => ({ loadDemTile: vi.fn() }));
vi.mock("#/lib/dem", async (orig) => ({
	...(await orig<typeof import("#/lib/dem")>()),
	loadDemTile: dem.loadDemTile,
}));

import type { DemRaster, TileKey } from "#/lib/dem";
import { tileId } from "#/lib/dem";
import { EnuFrame } from "#/lib/geodesy";
import { loadRollTerrain, type RollTerrainOptions } from "../roll-terrain";

type TerrainSet = NonNullable<Awaited<ReturnType<typeof loadRollTerrain>>>;
const statsOf = (s: TerrainSet | null) =>
	(s as TerrainSet).stats as NonNullable<TerrainSet["stats"]>;
const SIZE = 64;
const raster = (key: TileKey, source = key): DemRaster => ({
	key,
	source,
	size: SIZE,
	heights: new Float32Array(SIZE * SIZE).fill(1500),
});

const frame = new EnuFrame(46.7, 7.7, 0);
const base: RollTerrainOptions = {
	foci: [{ lat: 46.7, lon: 7.7 }],
	radiusM: 6000,
	minZoom: 11,
	maxZoom: 13,
	concurrency: 3,
};

beforeEach(() => {
	dem.loadDemTile.mockReset();
	dem.loadDemTile.mockImplementation(async (k: TileKey) => raster(k));
});

describe("loadRollTerrain", () => {
	it("builds a mesh per selected tile, nearest first, refined where the focus is", async () => {
		const set = await loadRollTerrain(frame, base);
		expect(set).not.toBeNull();
		const meshes = set?.tiles ?? [];
		expect(meshes.length).toBeGreaterThan(1);
		for (let i = 1; i < meshes.length; i++)
			expect(meshes[i].distance).toBeGreaterThanOrEqual(meshes[i - 1].distance);
		const zooms = meshes.map((m) => m.key.z);
		expect(Math.max(...zooms)).toBe(13); // down to maxZoom at the focus
		expect(zooms[0]).toBeGreaterThanOrEqual(zooms[zooms.length - 1]);
		expect(statsOf(set)).toMatchObject({
			tiles: meshes.length,
			standIns: 0,
			pending: 0,
			generation: 1,
		});
		expect(statsOf(set).zooms[13]).toBeGreaterThan(0);
		expect(statsOf(set).triangles).toBeGreaterThan(0);
	});

	it("covers a larger area with more tiles than a smaller radius", async () => {
		const small = await loadRollTerrain(frame, { ...base, radiusM: 3000 });
		const large = await loadRollTerrain(frame, { ...base, radiusM: 12_000 });
		expect(statsOf(large).tiles).toBeGreaterThan(statsOf(small).tiles ?? 0);
	});

	it("refines around every focus, not just the frame origin", async () => {
		const far = { lat: 46.72, lon: 7.85 };
		const wide = { ...base, radiusM: 20_000 };
		const one = await loadRollTerrain(frame, wide);
		const two = await loadRollTerrain(frame, {
			...wide,
			foci: [...base.foci, far],
		});
		expect(statsOf(two).zooms[13]).toBeGreaterThan(statsOf(one).zooms[13] ?? 0);
		expect(two?.tiles.some((m) => m.key.z === 13 && m.distance < 1)).toBe(true);
	});

	it("takes seeded rasters without loading them, and loads the rest", async () => {
		const full = await loadRollTerrain(frame, base);
		const keys = (full?.tiles ?? []).map((m) => m.key);
		const seed = new Map(keys.slice(0, 2).map((k) => [tileId(k), raster(k)]));
		dem.loadDemTile.mockClear();
		const set = await loadRollTerrain(frame, { ...base, seed });
		expect(statsOf(set).tiles).toBe(keys.length);
		expect(dem.loadDemTile).toHaveBeenCalledTimes(keys.length - 2);
	});

	it("skips tiles that fail to load and still reports progress for them", async () => {
		let n = 0;
		dem.loadDemTile.mockImplementation(async (k: TileKey) => {
			if (n++ % 2 === 0) throw new Error("404");
			return raster(k);
		});
		const progress: [number, number][] = [];
		const set = await loadRollTerrain(frame, {
			...base,
			onProgress: (d, t) => progress.push([d, t]),
		});
		const total = progress[0][1];
		expect(statsOf(set).tiles).toBeLessThan(total);
		expect(statsOf(set).tiles).toBeGreaterThan(0);
		expect(progress).toHaveLength(total);
		expect(progress[progress.length - 1][0]).toBe(total);
	});

	it("counts ancestor stand-ins as fallbacks", async () => {
		dem.loadDemTile.mockImplementation(async (k: TileKey) =>
			raster(k, k.z === 13 ? { z: 12, x: k.x >> 1, y: k.y >> 1 } : k),
		);
		const set = await loadRollTerrain(frame, base);
		expect(statsOf(set).fallbacks).toBe(
			set?.tiles.filter((m) => m.key.z === 13).length,
		);
		expect(statsOf(set).fallbacks).toBeGreaterThan(0);
	});

	it("resolves null when aborted", async () => {
		const ac = new AbortController();
		dem.loadDemTile.mockImplementation(async (k: TileKey) => {
			ac.abort();
			return raster(k);
		});
		expect(
			await loadRollTerrain(frame, { ...base, signal: ac.signal }),
		).toBeNull();
	});
});
