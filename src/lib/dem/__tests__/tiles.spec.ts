// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { seededRandom, uniform } from "#/test/helpers";
import {
	latToTileY,
	lonLatToTile,
	lonToTileX,
	parentKey,
	tileBounds,
	tileId,
	tileNum,
	tilesAround,
	tileXToLon,
	tileYToLat,
} from "../tiles";

describe("tile coordinate transforms", () => {
	it("maps the world corners at zoom 0", () => {
		expect(lonToTileX(-180, 0)).toBe(0);
		expect(lonToTileX(180, 0)).toBe(1);
		expect(latToTileY(0, 0)).toBeCloseTo(0.5, 12);
		expect(latToTileY(85.0511287798, 0)).toBeCloseTo(0, 8);
		expect(latToTileY(-85.0511287798, 0)).toBeCloseTo(1, 8);
	});
	it("scales by 2 per zoom", () => {
		expect(lonToTileX(10, 5)).toBeCloseTo(lonToTileX(10, 4) * 2, 12);
		expect(latToTileY(47, 5)).toBeCloseTo(latToTileY(47, 4) * 2, 12);
	});
	it("lon/lat round-trip through fractional tile coords", () => {
		const rand = seededRandom(11);
		for (let i = 0; i < 100; i++) {
			const lon = uniform(rand, -179, 179);
			const lat = uniform(rand, -80, 80);
			const z = Math.floor(uniform(rand, 0, 18));
			const t = lonLatToTile(lon, lat, z);
			expect(tileXToLon(t.x, z)).toBeCloseTo(lon, 8);
			expect(tileYToLat(t.y, z)).toBeCloseTo(lat, 8);
		}
	});
	it("y grows southward", () => {
		expect(latToTileY(10, 6)).toBeLessThan(latToTileY(-10, 6));
	});
	it("known tile: Zurich at z10 is tile 536/358", () => {
		const t = lonLatToTile(8.54, 47.37, 10);
		expect(Math.floor(t.x)).toBe(536);
		expect(Math.floor(t.y)).toBe(358);
	});
});

describe("tile keys", () => {
	it("tileId formats z/x/y", () => {
		expect(tileId({ z: 3, x: 4, y: 5 })).toBe("3/4/5");
	});
	it("tileNum is injective over distinct keys", () => {
		const seen = new Set<number>();
		for (let z = 0; z < 4; z++)
			for (let x = 0; x < 8; x++)
				for (let y = 0; y < 8; y++) seen.add(tileNum(z, x, y));
		expect(seen.size).toBe(4 * 64);
	});
	it("parentKey halves coordinates", () => {
		expect(parentKey({ z: 5, x: 17, y: 9 })).toEqual({ z: 4, x: 8, y: 4 });
		expect(parentKey({ z: 1, x: 1, y: 0 })).toEqual({ z: 0, x: 0, y: 0 });
	});
});

describe("tileBounds", () => {
	it("zoom 0 covers the world", () => {
		const b = tileBounds({ z: 0, x: 0, y: 0 });
		expect(b.west).toBe(-180);
		expect(b.east).toBe(180);
		expect(b.north).toBeCloseTo(85.0511287798, 6);
		expect(b.south).toBeCloseTo(-85.0511287798, 6);
	});
	it("children partition the parent", () => {
		const p = tileBounds({ z: 8, x: 135, y: 90 });
		const sw = tileBounds({ z: 9, x: 270, y: 181 });
		const ne = tileBounds({ z: 9, x: 271, y: 180 });
		expect(sw.west).toBeCloseTo(p.west, 10);
		expect(sw.south).toBeCloseTo(p.south, 10);
		expect(ne.east).toBeCloseTo(p.east, 10);
		expect(ne.north).toBeCloseTo(p.north, 10);
	});
	it("contains the point that indexed it", () => {
		const lon = 7.9;
		const lat = 46.7;
		const t = lonLatToTile(lon, lat, 12);
		const b = tileBounds({ z: 12, x: Math.floor(t.x), y: Math.floor(t.y) });
		expect(lon).toBeGreaterThanOrEqual(b.west);
		expect(lon).toBeLessThan(b.east);
		expect(lat).toBeGreaterThan(b.south);
		expect(lat).toBeLessThanOrEqual(b.north);
	});
});

describe("tilesAround", () => {
	it("a tiny radius returns the single containing tile", () => {
		const keys = tilesAround(46.7, 7.9, 1, 12);
		expect(keys).toHaveLength(1);
		const t = lonLatToTile(7.9, 46.7, 12);
		expect(keys[0]).toEqual({ z: 12, x: Math.floor(t.x), y: Math.floor(t.y) });
	});
	it("grows with radius and always contains the centre tile", () => {
		const small = tilesAround(46.7, 7.9, 1000, 12);
		const big = tilesAround(46.7, 7.9, 30000, 12);
		expect(big.length).toBeGreaterThan(small.length);
		const t = lonLatToTile(7.9, 46.7, 12);
		expect(
			big.some((k) => k.x === Math.floor(t.x) && k.y === Math.floor(t.y)),
		).toBe(true);
	});
	it("tiles are unique and all at zoom z", () => {
		const keys = tilesAround(0, 0, 50000, 9);
		expect(new Set(keys.map(tileId)).size).toBe(keys.length);
		expect(keys.every((k) => k.z === 9)).toBe(true);
	});
});
