// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { lonLatToTile } from "../../dem";
import { loadTerrain, TerrainSampler } from "../terrain";

// A world-spanning single tile (z = 0) of 8x8 samples, height linear in pixel index.
const N = 8;
const linear = () => {
	const t = new Float32Array(N * N);
	for (let y = 0; y < N; y++)
		for (let x = 0; x < N; x++) t[y * N + x] = 10 * x + 100 * y;
	return t;
};
const level0 = [{ z: 0, maxDistance: 1e9 }];
const lonLatAtPixel = (px: number, py: number) => {
	// invert lonLatToTile at z=0 for x = (px + 0.5)/N
	const x = (px + 0.5) / N;
	const lon = x * 360 - 180;
	const yT = (py + 0.5) / N;
	const lat = (180 / Math.PI) * Math.atan(Math.sinh(Math.PI * (1 - 2 * yT)));
	return { lon, lat };
};

describe("TerrainSampler", () => {
	const sampler = new TerrainSampler(level0, new Map([["0/0/0", linear()]]), N);
	it("returns exact heights at pixel centres", () => {
		const { lon, lat } = lonLatAtPixel(3, 2);
		expect(sampler.sample(lon, lat, 0)).toBeCloseTo(10 * 3 + 100 * 2, 3);
	});
	it("interpolates bilinearly (exact for a linear field)", () => {
		const a = lonLatAtPixel(3, 2);
		const t = lonLatToTile(a.lon, a.lat, 0);
		const px = t.x * N - 0.5 + 0.25;
		const py = t.y * N - 0.5 + 0.5;
		const lon = ((px + 0.5) / N) * 360 - 180;
		const yT = (py + 0.5) / N;
		const lat = (180 / Math.PI) * Math.atan(Math.sinh(Math.PI * (1 - 2 * yT)));
		expect(sampler.sample(lon, lat, 0)).toBeCloseTo(
			10 * (3 + 0.25) + 100 * (2 + 0.5),
			3,
		);
	});
	it("missing tiles sample as NaN, also across a tile edge", () => {
		expect(sampler.sample(10, 10, 3)).toBeNaN();
		// pixel -1 is outside the only tile
		const { lon, lat } = lonLatAtPixel(0, 3);
		expect(sampler.sample(lon - 0.4 * (360 / N), lat, 0)).toBeNaN();
	});
	it("sampleAt picks the level by distance and falls back to coarser levels", () => {
		const fine = new Float32Array(N * N).fill(500);
		const coarse = new Float32Array(N * N).fill(100);
		const s = new TerrainSampler(
			[
				{ z: 1, maxDistance: 1000 },
				{ z: 0, maxDistance: 1e9 },
			],
			new Map([
				["0/0/0", coarse],
				["1/0/0", fine],
			]),
			N,
		);
		// (lon, lat) in the NW quadrant: z=1 tile 0/0
		expect(s.sampleAt(-90, 45, 500)).toBe(500);
		expect(s.sampleAt(-90, 45, 5000)).toBe(100);
		// SE quadrant has no fine tile: falls back to coarse even for short distances
		expect(s.sampleAt(90, -45, 500)).toBe(100);
		// distance beyond every level uses the last
		expect(s.sampleAt(-90, 45, 1e12)).toBe(100);
		expect(s.ground(-90, 45)).toBe(500);
	});
	it("returns NaN when no level has the tile", () => {
		const s = new TerrainSampler(level0, new Map(), N);
		expect(s.sampleAt(0, 0, 10)).toBeNaN();
		expect(s.ground(0, 0)).toBeNaN();
	});
});

describe("loadTerrain", () => {
	it("requests each needed tile once, caches in the shared map and builds a sampler", async () => {
		const requested: string[] = [];
		const tiles = new Map<string, Float32Array>();
		const loader = async (k: { z: number; x: number; y: number }) => {
			requested.push(`${k.z}/${k.x}/${k.y}`);
			return new Float32Array(256 * 256).fill(k.z);
		};
		const levels = [{ z: 2, maxDistance: 1000 }];
		const s = await loadTerrain(46.5, 7.8, loader, levels, tiles, 4, 256);
		expect(requested.length).toBeGreaterThan(0);
		expect(new Set(requested).size).toBe(requested.length);
		expect(tiles.size).toBe(requested.length);
		expect(s.ground(7.8, 46.5)).toBe(2);
		const before = requested.length;
		await loadTerrain(46.5, 7.8, loader, levels, tiles, 4, 256);
		expect(requested.length).toBe(before);
	});
	it("skips tiles the loader does not have", async () => {
		const s = await loadTerrain(
			46.5,
			7.8,
			async () => undefined,
			[{ z: 2, maxDistance: 1000 }],
			new Map(),
			4,
			4,
		);
		expect(s.ground(7.8, 46.5)).toBeNaN();
	});
	it("rejects tiles of the wrong size", async () => {
		await expect(
			loadTerrain(
				46.5,
				7.8,
				async () => new Float32Array(10),
				[{ z: 2, maxDistance: 1000 }],
				new Map(),
				4,
				4,
			),
		).rejects.toThrow(/expected/);
	});
});
