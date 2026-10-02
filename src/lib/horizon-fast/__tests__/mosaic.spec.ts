// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { seededRandom } from "#/test/helpers";
import { NO_DATA } from "../../dem";
import { destination } from "../../geodesy";
import {
	allocF32,
	buildMips,
	buildMosaic,
	buildMosaics,
	cellMeters,
	DEFAULT_RINGS,
	gridMips,
	LITE_RINGS,
	loadMosaics,
	MIP_MAX_LEVEL,
	MIP_MIN_LEVEL,
	type Mosaic,
	mercator,
	mosaicFor,
	mosaicHeight,
	mosaicTileKeys,
	resolveRings,
	ringWindow,
	TileStore,
	windowTiles,
} from "../mosaic";
import {
	fakeSource,
	gaussianPeak,
	pixelLonLat,
	TILE,
	tileFromFn,
} from "./demFixture";

const LAT = 10;
const LON = 10;

describe("mercator / cellMeters", () => {
	it("maps the world to the unit square", () => {
		expect(mercator(-180, 0)).toEqual({ x: 0, y: 0.5 });
		expect(mercator(180, 0).x).toBe(1);
		expect(mercator(0, 0).x).toBe(0.5);
	});
	it("y decreases northward and stays finite at the poles (sin clamped)", () => {
		expect(mercator(0, 60).y).toBeLessThan(mercator(0, 30).y);
		expect(Number.isFinite(mercator(0, 90).y)).toBe(true);
		expect(Number.isFinite(mercator(0, -90).y)).toBe(true);
		expect(mercator(0, 90).y).toBeLessThan(0);
	});
	it("pixelLonLat inverts mercator at pixel centres", () => {
		const z = 10;
		const p = pixelLonLat(z, TILE, 12345, 23456);
		const m = mercator(p.lon, p.lat);
		const w = 2 ** z * TILE;
		expect(m.x * w).toBeCloseTo(12345.5, 6);
		expect(m.y * w).toBeCloseTo(23456.5, 6);
	});
	it("cellMeters halves per zoom and shrinks with cos(lat)", () => {
		expect(cellMeters(0, 11, 256)).toBeCloseTo(cellMeters(0, 10, 256) / 2, 9);
		expect(cellMeters(60, 10, 256)).toBeCloseTo(cellMeters(0, 10, 256) / 2, 6);
		expect(cellMeters(0, 0, 256)).toBeCloseTo(40075016.686 / 256, 2);
	});
});

describe("allocF32", () => {
	it("allocates plain or shared float arrays", () => {
		expect(allocF32(4).buffer).toBeInstanceOf(ArrayBuffer);
		expect(allocF32(4, true).buffer).toBeInstanceOf(SharedArrayBuffer);
		expect(allocF32(5, true).length).toBe(5);
	});
});

describe("rings", () => {
	it("LITE_RINGS is one zoom coarser, same distances", () => {
		expect(LITE_RINGS.map((r) => r.z)).toEqual(
			DEFAULT_RINGS.map((r) => r.z - 1),
		);
		expect(LITE_RINGS.map((r) => r.maxDistance)).toEqual(
			DEFAULT_RINGS.map((r) => r.maxDistance),
		);
	});
	it("DEFAULT_RINGS get coarser and longer", () => {
		for (let i = 1; i < DEFAULT_RINGS.length; i++) {
			expect(DEFAULT_RINGS[i].z).toBeLessThan(DEFAULT_RINGS[i - 1].z);
			expect(DEFAULT_RINGS[i].maxDistance).toBeGreaterThan(
				DEFAULT_RINGS[i - 1].maxDistance,
			);
		}
	});
});

describe("resolveRings", () => {
	it("clips to maxDistance and tiles the range without gaps", async () => {
		const spans = await resolveRings(DEFAULT_RINGS, LAT, LON, 50_000);
		expect(spans[0].minDistance).toBe(0);
		for (let i = 1; i < spans.length; i++)
			expect(spans[i].minDistance).toBe(spans[i - 1].maxDistance);
		expect(spans[spans.length - 1].maxDistance).toBe(50_000);
		// the 80 km ring is the last one touched: 30 km < 50 km <= 80 km
		expect(spans.map((s) => s.z)).toEqual([14, 13, 12, 11]);
	});
	it("extends the last ring when the rings stop short of maxDistance", async () => {
		const spans = await resolveRings(
			[{ z: 10, maxDistance: 1000 }],
			LAT,
			LON,
			5000,
		);
		expect(spans).toEqual([{ z: 10, minDistance: 0, maxDistance: 5000 }]);
	});
	it("uses preferZ only when the store has that tile", async () => {
		const src = fakeSource(() => 0, { maxZoom: 15 });
		const store = new TileStore(src);
		const spans = await resolveRings(DEFAULT_RINGS, LAT, LON, 1000, store);
		expect(spans[0].z).toBe(15);
		const missing = new TileStore(
			fakeSource(() => 0, { missing: (k) => k.z === 15 }),
		);
		expect(
			(await resolveRings(DEFAULT_RINGS, LAT, LON, 1000, missing))[0].z,
		).toBe(14);
	});
	it("ignores preferZ beyond the source's maxZoom without loading", async () => {
		const src = fakeSource(() => 0, { maxZoom: 14 });
		const spans = await resolveRings(
			DEFAULT_RINGS,
			LAT,
			LON,
			1000,
			new TileStore(src),
		);
		expect(spans[0].z).toBe(14);
		expect(src.loads.some((l) => l.startsWith("15/"))).toBe(false);
	});
});

describe("ringWindow", () => {
	const span = { z: 12, minDistance: 0, maxDistance: 20_000 };
	it("contains every point of the ring and is aligned", () => {
		const win = ringWindow(LAT, LON, span, TILE);
		const A = 1 << MIP_MAX_LEVEL;
		expect(win.x0 % A).toBe(0);
		expect(win.y0 % A).toBe(0);
		expect(win.width % A).toBe(0);
		const w = 2 ** 12 * TILE;
		for (let az = 0; az < 360; az += 15) {
			const p = destination(LAT, LON, az, 20_000);
			const m = mercator(p.lon, p.lat);
			expect(m.x * w).toBeGreaterThanOrEqual(win.x0);
			expect(m.x * w).toBeLessThan(win.x0 + win.width);
			expect(m.y * w).toBeGreaterThanOrEqual(win.y0);
			expect(m.y * w).toBeLessThan(win.y0 + win.height);
		}
	});
	it("a sector window is smaller than the full circle", () => {
		const full = ringWindow(LAT, LON, span, TILE);
		const sector = ringWindow(LAT, LON, span, TILE, 0, 60);
		expect(sector.width * sector.height).toBeLessThan(full.width * full.height);
		// and it still contains the sector's far points
		const w = 2 ** 12 * TILE;
		for (const az of [0, 30, 60]) {
			const p = destination(LAT, LON, az, 20_000);
			const m = mercator(p.lon, p.lat);
			expect(m.x * w).toBeGreaterThanOrEqual(sector.x0);
			expect(m.x * w).toBeLessThan(sector.x0 + sector.width);
			expect(m.y * w).toBeGreaterThanOrEqual(sector.y0);
			expect(m.y * w).toBeLessThan(sector.y0 + sector.height);
		}
	});
	it("padding grows the window", () => {
		const a = ringWindow(LAT, LON, span, TILE, 0, 360, 0, 1);
		const b = ringWindow(LAT, LON, span, TILE, 0, 360, 5000, 1);
		expect(b.width).toBeGreaterThan(a.width);
	});
	it("is clamped to the world vertically", () => {
		const win = ringWindow(
			84,
			0,
			{ z: 3, minDistance: 0, maxDistance: 2_000_000 },
			TILE,
			0,
			360,
			0,
			1,
		);
		expect(win.y0).toBeGreaterThanOrEqual(0);
		expect(win.y0 + win.height).toBeLessThanOrEqual(2 ** 3 * TILE);
	});
});

describe("windowTiles", () => {
	it("lists the covering tiles row by row", () => {
		const keys = windowTiles(
			{ z: 3, x0: 64, y0: 64, width: 128, height: 64 },
			64,
		);
		expect(keys).toEqual([
			{ z: 3, x: 1, y: 1 },
			{ z: 3, x: 2, y: 1 },
		]);
	});
	it("wraps x across the antimeridian", () => {
		const keys = windowTiles(
			{ z: 2, x0: -64, y0: 0, width: 128, height: 64 },
			64,
		);
		expect(keys.map((k) => k.x)).toEqual([3, 0]);
	});
	it("clips y to the world", () => {
		const n = 2 ** 2;
		const keys = windowTiles(
			{ z: 2, x0: 0, y0: -128, width: 64, height: 1000 },
			64,
		);
		expect(keys.every((k) => k.y >= 0 && k.y <= n - 1)).toBe(true);
	});
	it("a one-pixel window is one tile", () => {
		expect(
			windowTiles({ z: 5, x0: 100, y0: 100, width: 1, height: 1 }, 64),
		).toHaveLength(1);
	});
});

describe("gridMips / buildMips", () => {
	const brute = (d: Float32Array, W: number, H: number, level: number) => {
		const S = 1 << level;
		const w = Math.ceil(W / S);
		const h = Math.ceil(H / S);
		const out = new Float32Array(w * h).fill(Number.NEGATIVE_INFINITY);
		for (let y = 0; y < H; y++)
			for (let x = 0; x < W; x++) {
				const i = (y >> level) * w + (x >> level);
				out[i] = Math.max(out[i], d[y * W + x]);
			}
		return out;
	};
	it("every level is the exact block maximum (non-multiple sizes too)", () => {
		const r = seededRandom(5);
		const W = 77;
		const H = 53;
		const d = Float32Array.from({ length: W * H }, () => r() * 1000);
		const mip = gridMips(d, W, H, 2, 6);
		expect(mip.minLevel).toBe(2);
		expect(mip.mips).toHaveLength(5);
		mip.mips.forEach((m, i) => {
			const level = 2 + i;
			expect(mip.widths[i]).toBe(Math.ceil(W / (1 << level)));
			expect(mip.heights[i]).toBe(Math.ceil(H / (1 << level)));
			expect(Array.from(m)).toEqual(Array.from(brute(d, W, H, level)));
		});
	});
	it("the top level holds the global maximum", () => {
		const r = seededRandom(6);
		const d = Float32Array.from({ length: 64 * 64 }, () => r());
		const mip = gridMips(d, 64, 64, 2, 6);
		const top = mip.mips[mip.mips.length - 1];
		expect(Math.max(...top)).toBe(Math.max(...d));
	});
	it("buildMips defaults to levels 2..8", () => {
		const m = {
			data: new Float32Array(256 * 256).fill(1),
			width: 256,
			height: 256,
		} as Mosaic;
		const mip = buildMips(m);
		expect(mip.minLevel).toBe(MIP_MIN_LEVEL);
		expect(mip.mips).toHaveLength(MIP_MAX_LEVEL - MIP_MIN_LEVEL + 1);
	});
});

describe("TileStore", () => {
	const f = gaussianPeak(LAT, LON, 500, 1000);
	it("loads and caches tiles, de-duplicating concurrent requests", async () => {
		const src = fakeSource(f);
		const store = new TileStore(src);
		const k = { z: 10, x: 5, y: 5 };
		await Promise.all([store.ensure([k, k]), store.ensure([k])]);
		await store.ensure([k]);
		expect(src.loads).toEqual(["10/5/5"]);
		expect(store.has(k)).toBe(true);
		expect(store.get(k)).toBeInstanceOf(Float32Array);
	});
	it("a 404 loads its ancestor instead, and resolve() finds it", async () => {
		const src = fakeSource(f, { missing: (k) => k.z >= 8 });
		const store = new TileStore(src);
		await store.ensure([{ z: 9, x: 100, y: 100 }]);
		expect(store.get({ z: 9, x: 100, y: 100 })).toBeNull();
		expect(store.get({ z: 8, x: 50, y: 50 })).toBeNull();
		expect(store.get({ z: 7, x: 25, y: 25 })).toBeInstanceOf(Float32Array);
		const r = store.resolve({ z: 9, x: 100, y: 100 });
		expect(r?.dz).toBe(2);
	});
	it("tiles above the source's maxZoom are null without a request", async () => {
		const src = fakeSource(f, { maxZoom: 6 });
		const store = new TileStore(src);
		await store.ensure([{ z: 7, x: 0, y: 0 }]);
		expect(src.loads).not.toContain("7/0/0");
		expect(store.get({ z: 7, x: 0, y: 0 })).toBeNull();
	});
	it("a transient failure (undefined) is not cached", async () => {
		let n = 0;
		const store = new TileStore({
			tileSize: TILE,
			maxZoom: 15,
			load: async () => (++n === 1 ? undefined : new Float32Array(TILE * TILE)),
		});
		const k = { z: 3, x: 1, y: 1 };
		await store.ensure([k]);
		expect(store.has(k)).toBe(false);
		await store.ensure([k]);
		expect(store.has(k)).toBe(true);
	});
	it("repairs a tile with a 256 m R-channel error, preferring a clean reload", async () => {
		const k = { z: 10, x: 7, y: 7 };
		const clean = tileFromFn(k, TILE, () => 1000);
		const bad = Float32Array.from(clean);
		for (let j = 10; j < 14; j++)
			for (let i = 10; i < 14; i++) bad[j * TILE + i] += 256;
		const store = new TileStore({
			tileSize: TILE,
			maxZoom: 15,
			load: async () => Float32Array.from(bad),
			reload: async () => Float32Array.from(clean),
		});
		await store.ensure([k]);
		const got = store.get(k) as Float32Array;
		expect(got[11 * TILE + 11]).toBeCloseTo(1000, 3);
	});
	it("clear() drops tiles", async () => {
		const store = new TileStore(fakeSource(f));
		await store.ensure([{ z: 4, x: 1, y: 1 }]);
		store.clear();
		expect(store.has({ z: 4, x: 1, y: 1 })).toBe(false);
	});
	it("pixel() reads own tile, ancestor (nearest) and NO_DATA when nothing is loaded", async () => {
		const store = new TileStore(fakeSource(f, { missing: (k) => k.z >= 5 }));
		await store.ensure([{ z: 5, x: 8, y: 8 }]);
		const parent = store.get({ z: 4, x: 4, y: 4 }) as Float32Array;
		// global pixel (8*64+1, 8*64+2) at z5 -> ancestor pixel ((8*64+1)>>1 - 4*64, ...)
		const gx = 8 * TILE + 1;
		const gy = 8 * TILE + 2;
		expect(store.pixel(5, gx, gy)).toBe(
			parent[((gy >> 1) - 4 * TILE) * TILE + ((gx >> 1) - 4 * TILE)],
		);
		expect(store.pixel(5, 0, 0)).toBe(NO_DATA);
	});
	it("heightAt matches the analytic surface near the summit", async () => {
		const store = new TileStore(fakeSource(f));
		const z = 12;
		const w = 2 ** z * TILE;
		const m = mercator(LON, LAT);
		await store.ensure([
			{ z, x: Math.floor((m.x * w) / TILE), y: Math.floor((m.y * w) / TILE) },
		]);
		expect(Math.abs(store.heightAt(LON, LAT, z) - 500)).toBeLessThan(10);
	});
});

describe("buildMosaic / loadMosaics / mosaicHeight", () => {
	const f = gaussianPeak(destination(LAT, LON, 0, 5000).lat, LON, 800, 1200);
	let mosaics: Mosaic[];
	const store = new TileStore(fakeSource(f));
	const rings = [
		{ z: 12, maxDistance: 8_000 },
		{ z: 10, maxDistance: 30_000 },
	];
	it("loadMosaics yields one mosaic per ring with matching metadata", async () => {
		mosaics = await loadMosaics(LAT, LON, store, {
			rings,
			maxDistance: 30_000,
		});
		expect(mosaics).toHaveLength(2);
		expect(mosaics.map((m) => m.z)).toEqual([12, 10]);
		expect(mosaics[0].minDistance).toBe(0);
		expect(mosaics[0].maxDistance).toBe(8_000);
		expect(mosaics[1].minDistance).toBe(8_000);
		expect(mosaics[0].worldPx).toBe(2 ** 12 * TILE);
		expect(mosaics[0].cellMeters).toBeCloseTo(cellMeters(LAT, 12, TILE), 9);
		expect(mosaics[0].data.length).toBe(mosaics[0].width * mosaics[0].height);
	});
	it("mosaicHeight reproduces the analytic surface (bilinear)", () => {
		const peak = destination(LAT, LON, 0, 5000);
		for (const [az, d] of [
			[0, 5000],
			[0, 4000],
			[30, 4500],
			[350, 6000],
		]) {
			const p = destination(peak.lat, peak.lon, az, d === 5000 ? 0 : 1000);
			const want = f(p.lon, p.lat);
			expect(
				Math.abs(mosaicHeight(mosaics[0], p.lon, p.lat) - want),
			).toBeLessThan(0.02 * 800 + 1);
		}
	});
	it("mosaicHeight is NaN outside the window and where data is missing", () => {
		expect(mosaicHeight(mosaics[0], LON + 5, LAT)).toBeNaN();
		const m: Mosaic = {
			...mosaics[0],
			data: new Float32Array(mosaics[0].data.length).fill(NO_DATA),
		};
		expect(mosaicHeight(m, LON, LAT)).toBeNaN();
	});
	it("mosaicFor picks the ring serving a distance (last ring beyond the end)", () => {
		expect(mosaicFor(mosaics, 100)).toBe(mosaics[0]);
		expect(mosaicFor(mosaics, 8_000)).toBe(mosaics[0]);
		expect(mosaicFor(mosaics, 8_001)).toBe(mosaics[1]);
		expect(mosaicFor(mosaics, 1e9)).toBe(mosaics[1]);
	});
	it("mips built during loading equal mips built from the pixels", async () => {
		const withMips = await loadMosaics(LAT, LON, store, {
			rings,
			maxDistance: 30_000,
			mips: true,
		});
		for (const m of withMips) {
			expect(m.mip).toBeDefined();
			// tile size 64: the tile-mip assembly stops at level log2(64) = 6
			const ref = buildMips(m, 2, 6);
			expect(m.mip?.mips.length).toBe(ref.mips.length);
			m.mip?.mips.forEach((a, i) => {
				expect(Array.from(a)).toEqual(Array.from(ref.mips[i]));
			});
		}
	});
	it("a missing tile fills NO_DATA", () => {
		const empty = new TileStore(fakeSource(f));
		const m = buildMosaic(
			empty,
			{ z: 12, x0: 0, y0: 0, width: 256, height: 256 },
			{ z: 12, minDistance: 0, maxDistance: 1 },
			LAT,
		);
		expect(m.data.every((v) => v === NO_DATA)).toBe(true);
	});
	it("ancestor fallback upsamples nearest", async () => {
		const s = new TileStore(fakeSource(f, { missing: (k) => k.z >= 6 }));
		const k = { z: 6, x: 33, y: 33 };
		await s.ensure([k]);
		const m = buildMosaic(
			s,
			{ z: 6, x0: 33 * TILE, y0: 33 * TILE, width: TILE, height: TILE },
			{ z: 6, minDistance: 0, maxDistance: 1 },
			LAT,
		);
		const parent = s.get({ z: 5, x: 16, y: 16 }) as Float32Array;
		// pixel (0,0) of tile (33,33) comes from ancestor pixel ((33*64)>>1 - 16*64) = 32
		expect(m.data[0]).toBe(parent[32 * TILE + 32]);
		// 2x2 blocks repeat
		expect(m.data[1]).toBe(m.data[0]);
		expect(m.data[TILE]).toBe(m.data[0]);
	});
	it("mosaicTileKeys covers every tile used by buildMosaics", async () => {
		const spans = await resolveRings(rings, LAT, LON, 30_000);
		const keys = mosaicTileKeys(LAT, LON, spans, TILE);
		const fresh = new TileStore(fakeSource(f));
		await fresh.ensure(keys);
		const built = buildMosaics(LAT, LON, fresh, spans);
		for (const m of built) {
			// no NO_DATA anywhere in the window except possibly beyond the world's vertical edge
			expect(m.data.includes(NO_DATA)).toBe(false);
		}
	});
});
