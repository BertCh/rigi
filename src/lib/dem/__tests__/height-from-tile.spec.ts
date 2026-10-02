// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { beforeEach, describe, expect, it, vi } from "vitest";
import { seededRandom } from "#/test/helpers";

// loadDemTile is the network + decode boundary: route it to a scripted raster
const loadDemTile = vi.fn();
vi.mock("../load", () => ({
	loadDemTile: (...a: unknown[]) => loadDemTile(...a),
}));
vi.mock("../../cache", () => ({
	tilePriority: (d: number, z: number) => 100 * d + z,
}));

import { sampleGrid } from "../grid";
import { heightFromTile } from "../height-from-tile";
import { latToTileY, lonToTileX, type TileKey } from "../tiles";

const S = 16;
const grid = () => {
	const h = new Float32Array(S * S);
	for (let y = 0; y < S; y++)
		for (let x = 0; x < S; x++)
			h[y * S + x] = 1500 + 3 * x + 7 * y + 11 * Math.sin(x * 0.9 + y * 0.4);
	return h;
};
const H = grid();
const raster = (key: TileKey) => ({ key, source: key, size: S, heights: H });

/** The pre-refactor copy (sampleTileGrid at fractional tile coords): the refactor must match it bit for bit. */
function oldSampleTileGrid(h: Float32Array, n: number, fu: number, fv: number) {
	const m = n - 1;
	const x = Math.min(Math.max(fu * n - 0.5, 0), m);
	const y = Math.min(Math.max(fv * n - 0.5, 0), m);
	const x0 = Math.floor(x);
	const y0 = Math.floor(y);
	const x1 = Math.min(x0 + 1, m);
	const y1 = Math.min(y0 + 1, m);
	const fx = x - x0;
	const fy = y - y0;
	const a = h[y0 * n + x0] * (1 - fx) + h[y0 * n + x1] * fx;
	const b = h[y1 * n + x0] * (1 - fx) + h[y1 * n + x1] * fx;
	return a * (1 - fy) + b * fy;
}

beforeEach(() => {
	loadDemTile.mockReset();
	loadDemTile.mockImplementation(async (key: TileKey) => raster(key));
});

describe("heightFromTile", () => {
	it("is null when no tile (or ancestor) loads", async () => {
		loadDemTile.mockResolvedValueOnce(null);
		expect(await heightFromTile(46.6, 7.9)).toBeNull();
	});

	it("asks for the zoom-z tile under the point, with its signal and priority (default z14)", async () => {
		const ac = new AbortController();
		await heightFromTile(46.6, 7.9, undefined, ac.signal);
		const key = {
			z: 14,
			x: Math.floor(lonToTileX(7.9, 14)),
			y: Math.floor(latToTileY(46.6, 14)),
		};
		expect(loadDemTile).toHaveBeenCalledWith(key, {
			signal: ac.signal,
			priority: 14,
		});
		await heightFromTile(46.6, 7.9, 12);
		expect(loadDemTile.mock.calls[1][0].z).toBe(12);
	});

	it("wiring: samples the loaded raster at the point's tile-local pixel position, incl. the clamped edges", async () => {
		const z = 13;
		const k = {
			x: Math.floor(lonToTileX(7.9, z)),
			y: Math.floor(latToTileY(46.6, z)),
		};
		// fractions of the tile: interior, within half a pixel of each edge (clamped), corners
		const fr = [0.5, 0.01, 0.99, 0.5 / S - 1e-6, 1 - 0.25 / S, 0.3];
		for (const u of fr)
			for (const v of fr) {
				const lon = ((k.x + u) / 2 ** z) * 360 - 180;
				const n = Math.PI - (2 * Math.PI * (k.y + v)) / 2 ** z;
				const lat = (180 / Math.PI) * Math.atan(Math.sinh(n));
				const fx = lonToTileX(lon, z);
				const fy = latToTileY(lat, z);
				expect(Math.floor(fx)).toBe(k.x);
				expect(Math.floor(fy)).toBe(k.y);
				const want = sampleGrid(H, S, (fx - k.x) * S, (fy - k.y) * S);
				expect(await heightFromTile(lat, lon, z)).toBe(want);
			}
	});

	it("matches the pre-refactor tile sampler bit for bit", async () => {
		const rand = seededRandom(7);
		for (let i = 0; i < 200; i++) {
			const lat = 45.8 + rand() * 1.5;
			const lon = 6.0 + rand() * 4.0;
			const z = 10 + Math.floor(rand() * 8);
			const fx = lonToTileX(lon, z);
			const fy = latToTileY(lat, z);
			const want = oldSampleTileGrid(
				H,
				S,
				fx - Math.floor(fx),
				fy - Math.floor(fy),
			);
			expect(await heightFromTile(lat, lon, z)).toBe(want);
		}
	});
});
