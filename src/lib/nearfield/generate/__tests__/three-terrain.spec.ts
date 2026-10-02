// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it, vi } from "vitest";
import { tileBounds, tileId } from "#/lib/dem/tiles";
import { distanceM } from "#/lib/geodesy";
import { selectTiles } from "../three-terrain";

const opts = { radiusM: 20_000, maxZoom: 13, minZoom: 9, lod: 2 };
const lat = 46.7;
const lon = 7.9;

describe("selectTiles", () => {
	const tiles = selectTiles(lat, lon, opts);
	it("is sorted nearest first", () => {
		for (let i = 1; i < tiles.length; i++)
			expect(tiles[i].distance).toBeGreaterThanOrEqual(tiles[i - 1].distance);
	});
	it("every tile is within the radius and inside the zoom range", () => {
		for (const t of tiles) {
			expect(t.distance).toBeLessThanOrEqual(opts.radiusM);
			expect(t.key.z).toBeGreaterThanOrEqual(opts.minZoom);
			expect(t.key.z).toBeLessThanOrEqual(opts.maxZoom);
		}
	});
	it("refines near the camera and coarsens far away", () => {
		expect(tiles[0].key.z).toBe(opts.maxZoom);
		expect(tiles[tiles.length - 1].key.z).toBeLessThan(opts.maxZoom);
		const zs = tiles.map((t) => t.key.z);
		// z never decreases then increases by more than the pyramid allows: zoom is non-increasing in distance on average
		const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
		const h = zs.length >> 1;
		expect(mean(zs.slice(0, h))).toBeGreaterThan(mean(zs.slice(h)));
	});
	it("a tile containing the camera is distance 0 and tiles do not overlap", () => {
		expect(tiles[0].distance).toBe(0);
		// no selected tile is an ancestor of another
		const ids = new Set(tiles.map((t) => tileId(t.key)));
		for (const t of tiles) {
			let z = t.key.z;
			let x = t.key.x;
			let y = t.key.y;
			while (z > 0) {
				z--;
				x >>= 1;
				y >>= 1;
				expect(ids.has(`${z}/${x}/${y}`)).toBe(false);
			}
		}
	});
	it("tile distances agree with geodesic distance to the clamped box", () => {
		const t = tiles[tiles.length - 1];
		const bb = tileBounds(t.key);
		const d = distanceM(
			{ lat, lon },
			{
				lat: Math.min(Math.max(lat, bb.south), bb.north),
				lon: Math.min(Math.max(lon, bb.west), bb.east),
			},
		);
		expect(t.distance).toBeCloseTo(d, 6);
	});
	it("coverage: a ring of points at 0.9 R lies in some selected tile", () => {
		for (let az = 0; az < 360; az += 30) {
			const a = (az * Math.PI) / 180;
			const r = 0.9 * opts.radiusM;
			const plat = lat + (r * Math.cos(a)) / 111_320;
			const plon =
				lon + (r * Math.sin(a)) / (111_320 * Math.cos((lat * Math.PI) / 180));
			const hit = tiles.some(({ key }) => {
				const bb = tileBounds(key);
				return (
					plon >= bb.west &&
					plon <= bb.east &&
					plat >= bb.south &&
					plat <= bb.north
				);
			});
			expect(hit).toBe(true);
		}
	});
	it("a bigger lod factor yields more tiles", () => {
		const more = selectTiles(lat, lon, { ...opts, lod: 6 });
		expect(more.length).toBeGreaterThan(tiles.length);
	});
	it("maxZoom == minZoom yields only minZoom tiles", () => {
		const flat = selectTiles(lat, lon, { ...opts, maxZoom: 9 });
		expect(flat.every((t) => t.key.z === 9)).toBe(true);
	});
	it("a tiny radius selects very few tiles", () => {
		expect(
			selectTiles(lat, lon, { ...opts, radiusM: 10 }).length,
		).toBeLessThanOrEqual(4);
	});
});

describe("module import", () => {
	it("does not start workers or network at import", async () => {
		const f = vi.fn();
		vi.stubGlobal("fetch", f);
		await import("../three-terrain");
		expect(f).not.toHaveBeenCalled();
		vi.unstubAllGlobals();
	});
});
