// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Conformance of the CPU height samplers that read the same DEM tiles (reports/steps-2026-10-02/terrain-sampler.md):
//   geo/terrain.ts TerrainSampler.sample      cross-tile bilinear (NaN when a corner tile is missing)
//   horizon-fast/mosaic.ts TileStore.heightAt  cross-tile bilinear, nearest-ancestor pixels for missing tiles
//   dem/grid.ts sampleGrid on the tile         heightFromTile, TerrainSet.heightAt (clamped to the tile)
//   deck/terrain-data.ts TerrainSet.heightAt   finest loaded tile, sampleGrid
// All are pixel-centred bilinear. They agree inside a tile; within half a pixel of a tile seam the
// tile-local ones clamp to their own edge pixels while the cross-tile ones blend across the seam.
import { describe, expect, it } from "vitest";
import { seededRandom } from "#/test/helpers";
import { buildMesh, TerrainSet } from "../../deck/terrain-data";
import { TerrainSampler } from "../../geo/terrain";
import { EnuFrame } from "../../geodesy";
import { TileStore } from "../../horizon-fast/mosaic";
import { MIN_VALID } from "../decode";
import { sampleGrid } from "../grid";
import {
	latToTileY,
	lonToTileX,
	type TileKey,
	tileId,
	tileXToLon,
	tileYToLat,
} from "../tiles";

const S = 16;
const Z = 12;
const LAT = 46.6;
const LON = 7.9;
const X0 = Math.floor(lonToTileX(LON, Z));
const Y0 = Math.floor(latToTileY(LAT, Z));

/** One smooth field over global pixel centres (gx, gy relative to the block's NW corner), so tiles are consistent. */
const field = (gx: number, gy: number) =>
	1000 + 37 * Math.sin(0.7 * gx) + 13 * gy + 0.5 * gx * gy;

function tileHeights(tx: number, ty: number) {
	const h = new Float32Array(S * S);
	for (let j = 0; j < S; j++)
		for (let i = 0; i < S; i++)
			h[j * S + i] = field((tx - X0) * S + i, (ty - Y0) * S + j);
	return h;
}

/** The 2×2 block of zoom-Z tiles at (X0..X0+1, Y0..Y0+1). */
const KEYS: TileKey[] = [0, 1].flatMap((dy) =>
	[0, 1].map((dx) => ({ z: Z, x: X0 + dx, y: Y0 + dy })),
);
const TILES = new Map(KEYS.map((k) => [tileId(k), tileHeights(k.x, k.y)]));

const noSource = { tileSize: S, maxZoom: 30, load: async () => null };
function storeOf(tiles: Map<string, Float32Array>) {
	const s = new TileStore(noSource, false);
	for (const [id, t] of tiles) s.tiles.set(id, t);
	return s;
}

const frame = new EnuFrame(LAT, LON, 1000);
const SET = new TerrainSet(
	frame,
	KEYS.map((key) =>
		buildMesh(
			frame,
			{
				key,
				source: key,
				size: S,
				heights: TILES.get(tileId(key)) as Float32Array,
			},
			4,
			100,
			true,
		),
	),
);
const SAMPLER = new TerrainSampler([{ z: Z, maxDistance: 1e9 }], TILES, S);
const STORE = storeOf(TILES);

/** lon/lat at block pixel (px, py) in [0, 2S) (pixel units at zoom Z, origin = the block's NW corner). */
const lonLatAt = (px: number, py: number) => ({
	lon: tileXToLon(X0 + px / S, Z),
	lat: tileYToLat(Y0 + py / S, Z),
});

/** sampleGrid on the containing tile (what heightFromTile and TerrainSet.heightAt compute). */
function tileLocal(lon: number, lat: number) {
	const fx = lonToTileX(lon, Z);
	const fy = latToTileY(lat, Z);
	const x = Math.floor(fx);
	const y = Math.floor(fy);
	const h = TILES.get(tileId({ z: Z, x, y })) as Float32Array;
	return sampleGrid(h, S, (fx - x) * S, (fy - y) * S);
}

describe("CPU height samplers agree", () => {
	it("inside a tile (bilinear neighbourhood within one tile): all four agree", () => {
		const rand = seededRandom(11);
		let n = 0;
		while (n < 400) {
			const px = rand() * 2 * S;
			const py = rand() * 2 * S;
			const lx = px % S;
			const ly = py % S;
			// stay a hair off the half-pixel band so coordinate ulps cannot cross it
			if (lx < 0.5 + 1e-6 || lx > S - 0.5 - 1e-6) continue;
			if (ly < 0.5 + 1e-6 || ly > S - 0.5 - 1e-6) continue;
			n++;
			const { lon, lat } = lonLatAt(px, py);
			const local = tileLocal(lon, lat);
			// TerrainSet.heightAt is sampleGrid on the same tile with the same arithmetic: bit for bit
			expect(SET.heightAt(lat, lon)).toBe(local);
			// the cross-tile samplers blend the same four pixels with their own op order / mercator
			expect(SAMPLER.sample(lon, lat, Z)).toBeCloseTo(local, 4);
			expect(STORE.heightAt(lon, lat, Z)).toBeCloseTo(local, 4);
		}
	});

	it("within half a pixel of an internal seam: tile-local samplers clamp, cross-tile ones blend", () => {
		const rand = seededRandom(12);
		let maxDiff = 0;
		for (let i = 0; i < 300; i++) {
			// across the vertical seam at block px = S (between column X0 and X0 + 1), away from the other seam
			const px = S - 0.5 + rand(); // [S - 0.5, S + 0.5)
			const py = 1 + rand() * (S - 2);
			if (Math.abs(px - S) < 1e-6) continue;
			const { lon, lat } = lonLatAt(px, py);
			const cross = SAMPLER.sample(lon, lat, Z);
			const local = tileLocal(lon, lat);
			expect(SET.heightAt(lat, lon)).toBe(local);
			expect(STORE.heightAt(lon, lat, Z)).toBeCloseTo(cross, 4);
			// the clamped value is the tile's own edge column, blended along y only
			const y = py - 0.5;
			const y0 = Math.floor(y);
			const fy = y - y0;
			const col = px < S ? S - 1 : S;
			const edge = field(col, y0) * (1 - fy) + field(col, y0 + 1) * fy;
			expect(local).toBeCloseTo(edge, 3);
			// the seam step between the two edge columns bounds the disagreement (half of it at most)
			const step = Math.max(
				Math.abs(field(S, y0) - field(S - 1, y0)),
				Math.abs(field(S, y0 + 1) - field(S - 1, y0 + 1)),
			);
			const d = Math.abs(cross - local);
			expect(d).toBeLessThanOrEqual(0.5 * step + 1e-3);
			maxDiff = Math.max(maxDiff, d);
		}
		// a real (non-zero) discontinuity: tile-local samplers jump by a pixel step at the seam
		expect(maxDiff).toBeGreaterThan(1);
	});

	it("missing tiles: TerrainSampler gives NaN and sampleAt falls back a level; TileStore reads ancestor pixels", () => {
		// drop the NE tile; the Z - 1 parents of the whole block are loaded (flat 777 m)
		const tiles = new Map(TILES);
		tiles.delete(tileId({ z: Z, x: X0 + 1, y: Y0 }));
		const ph = new Float32Array(S * S).fill(777);
		for (const k of KEYS)
			tiles.set(tileId({ z: Z - 1, x: k.x >> 1, y: k.y >> 1 }), ph);
		const sampler = new TerrainSampler(
			[
				{ z: Z, maxDistance: 1000 },
				{ z: Z - 1, maxDistance: 1e9 },
			],
			tiles,
			S,
		);
		const { lon, lat } = lonLatAt(S + S / 2, S / 2); // the middle of the dropped tile
		expect(sampler.sample(lon, lat, Z)).toBeNaN();
		expect(sampler.sampleAt(lon, lat, 0)).toBe(777); // the Z - 1 level answers
		// a point inside the kept NW tile whose neighbourhood touches the dropped tile: NaN at Z, then Z - 1
		const nearSeam = lonLatAt(S - 0.2, S / 2);
		expect(sampler.sample(nearSeam.lon, nearSeam.lat, Z)).toBeNaN();
		// the whole sample falls back (not just the missing corners): the kept tile's own pixels are not used
		expect(sampler.sampleAt(nearSeam.lon, nearSeam.lat, 0)).toBe(777);
		// TileStore: the dropped tile's pixels come from the nearest ancestor (nearest pixel, no blend)
		const store = storeOf(tiles);
		expect(store.heightAt(lon, lat, Z)).toBeCloseTo(777, 6);
		// no tile and no ancestor at all: NO_DATA corners, not NaN (callers must test < MIN_VALID)
		const empty = storeOf(new Map());
		expect(empty.heightAt(lon, lat, Z)).toBeLessThan(MIN_VALID);
		// TerrainSet: outside every loaded tile is null; it never mixes in a neighbour tile
		expect(new TerrainSet(frame, []).heightAt(lat, lon)).toBeNull();
	});
});
