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

describe("TerrainSampler across tile edges", () => {
	// Four 8x8 tiles at z = 1 forming one 16x16 grid with h = 3 gx + 7 gy (+ a per-tile offset in the
	// SE tile, so a wrong tile shows). Bilinear over a linear field is exact inside each tile.
	const n = 8;
	const tiles = new Map<string, Float32Array>();
	for (let ty = 0; ty < 2; ty++)
		for (let tx = 0; tx < 2; tx++) {
			const t = new Float32Array(n * n);
			for (let y = 0; y < n; y++)
				for (let x = 0; x < n; x++)
					t[y * n + x] =
						3 * (tx * n + x) + 7 * (ty * n + y) + (tx && ty ? 1000 : 0);
			tiles.set(`1/${tx}/${ty}`, t);
		}
	const s = new TerrainSampler([{ z: 1, maxDistance: 1e9 }], tiles, n);
	const at = (gx: number, gy: number) => {
		// Mercator pixel (gx + 0.5, gy + 0.5) at z = 1 back to lon/lat.
		const x = (gx + 0.5) / (2 * n);
		const y = (gy + 0.5) / (2 * n);
		return {
			lon: x * 360 - 180,
			lat: (180 / Math.PI) * Math.atan(Math.sinh(Math.PI * (1 - 2 * y))),
		};
	};
	/** The four-tap bilinear through per-pixel tile lookups (the slow path), as the reference. */
	const reference = (gx: number, gy: number) => {
		const px = gx;
		const py = gy;
		const x0 = Math.floor(px);
		const y0 = Math.floor(py);
		const fx = px - x0;
		const fy = py - y0;
		const pix = (x: number, y: number) => {
			const t = tiles.get(`1/${Math.floor(x / n)}/${Math.floor(y / n)}`);
			return t
				? t[(y - Math.floor(y / n) * n) * n + (x - Math.floor(x / n) * n)]
				: Number.NaN;
		};
		return (
			(pix(x0, y0) * (1 - fx) + pix(x0 + 1, y0) * fx) * (1 - fy) +
			(pix(x0, y0 + 1) * (1 - fx) + pix(x0 + 1, y0 + 1) * fx) * fy
		);
	};
	it("interior, right-edge, bottom-edge and corner taps match the per-pixel lookup", () => {
		for (const [gx, gy] of [
			[3.25, 2.5], // interior of the NW tile
			[7.5, 2.25], // straddles NW | NE
			[2.75, 7.5], // straddles NW / SW
			[7.5, 7.5], // the four-tile corner
			[12.25, 11.75], // interior of the SE tile
		]) {
			const { lon, lat } = at(gx, gy);
			expect(s.sample(lon, lat, 1)).toBeCloseTo(reference(gx, gy), 6);
		}
	});
	it("the corner sample blends the SE tile, and a missing neighbour tile gives NaN", () => {
		const { lon, lat } = at(7.5, 7.5);
		expect(s.sample(lon, lat, 1)).toBeGreaterThan(250); // a quarter of the +1000 offset
		const holes = new Map(tiles);
		holes.delete("1/1/0");
		const h = new TerrainSampler([{ z: 1, maxDistance: 1e9 }], holes, n);
		const e = at(7.5, 2.25);
		expect(h.sample(e.lon, e.lat, 1)).toBeNaN();
		const i = at(3.25, 2.5);
		expect(h.sample(i.lon, i.lat, 1)).toBeCloseTo(reference(3.25, 2.5), 6);
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
