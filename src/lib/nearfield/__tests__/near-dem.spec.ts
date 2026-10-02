// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pose } from "../../camera";
import { latToTileY, lonToTileX } from "../../dem/tiles";

const loadDemTile = vi.fn();
vi.mock("../../dem", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../dem")>()),
	loadDemTile: (...a: unknown[]) => loadDemTile(...a),
}));

import {
	loadNearDem,
	NEAR_DEM_CPU_MAX,
	NEAR_DEM_ZOOM,
	nearFieldDemRangeFrom,
} from "../near-dem";

const flatTile = (h: number, size = 8) => ({
	size,
	heights: new Float32Array(size * size).fill(h),
});

let uniq = 0;
const freshLat = () => 46.5 + 0.01 * ++uniq; // distinct cache key per test

beforeEach(() => {
	loadDemTile.mockReset();
});

describe("loadNearDem", () => {
	it("loads every tile around the photo and exposes ground, eye height and a bilinear heightAt", async () => {
		loadDemTile.mockImplementation(async () => flatTile(1500));
		const lat = freshLat();
		const dem = await loadNearDem(lat, 8.0, null);
		expect(dem).not.toBeNull();
		expect(dem?.ground).toBeCloseTo(1500, 3);
		expect(dem?.eyeZ).toBeCloseTo(1501.8, 3); // no GPS altitude: DEM + 1.8
		expect(dem?.zoom).toBe(NEAR_DEM_ZOOM);
		expect(dem?.frame).toEqual({ lat, lon: 8.0, h: 0 });
		expect(dem?.heightAt(lat + 0.001, 8.001)).toBeCloseTo(1500, 3);
		const calls = loadDemTile.mock.calls.length;
		expect(calls).toBeGreaterThanOrEqual(4); // 440 m radius at z16 spans several tiles
		for (const [k] of loadDemTile.mock.calls) expect(k.z).toBe(NEAR_DEM_ZOOM);
		// heightAt outside the loaded tiles is null
		expect(dem?.heightAt(lat + 1, 8.0)).toBeNull();
	});
	it("uses the GPS altitude unless it is underground", async () => {
		loadDemTile.mockImplementation(async () => flatTile(1000));
		const hi = await loadNearDem(freshLat(), 8.1, 1010);
		expect(hi?.eyeZ).toBe(1010);
		const under = await loadNearDem(freshLat(), 8.1, 900);
		expect(under?.eyeZ).toBeCloseTo(1001.6, 6);
	});
	it("caches complete loads per photo position", async () => {
		loadDemTile.mockImplementation(async () => flatTile(10));
		const lat = freshLat();
		const a = loadNearDem(lat, 8.2, 12);
		const b = loadNearDem(lat, 8.2, 12);
		expect(b).toBe(a);
		await a;
		const n = loadDemTile.mock.calls.length;
		await loadNearDem(lat, 8.2, 12);
		expect(loadDemTile.mock.calls.length).toBe(n);
	});
	it("returns null (never throws) when the photo point has no DEM or every tile fails", async () => {
		loadDemTile.mockImplementation(async () => null);
		expect(await loadNearDem(freshLat(), 8.3, 0)).toBeNull();
		loadDemTile.mockImplementation(async () => {
			throw new Error("network");
		});
		expect(await loadNearDem(freshLat(), 8.3, 0)).toBeNull();
	});
	it("serves a DEM with missing tiles but does not cache it", async () => {
		const lat = freshLat();
		const px = Math.floor(lonToTileX(8.4, NEAR_DEM_ZOOM));
		const py = Math.floor(latToTileY(lat, NEAR_DEM_ZOOM));
		// only the photo's own tile exists
		loadDemTile.mockImplementation(async (k: { x: number; y: number }) =>
			k.x === px && k.y === py ? flatTile(700) : null,
		);
		const a = await loadNearDem(lat, 8.4, null);
		expect(a).not.toBeNull();
		await Promise.resolve();
		loadDemTile.mockClear();
		loadDemTile.mockImplementation(async () => flatTile(700));
		await loadNearDem(lat, 8.4, null);
		expect(loadDemTile).toHaveBeenCalled(); // retried
	});
	it("returns null when aborted", async () => {
		loadDemTile.mockImplementation(async () => flatTile(5));
		const ac = new AbortController();
		ac.abort();
		expect(
			await loadNearDem(freshLat(), 8.5, 0, { signal: ac.signal }),
		).toBeNull();
	});
	it("honours zoom and radius options", async () => {
		loadDemTile.mockImplementation(async () => flatTile(5));
		await loadNearDem(freshLat(), 8.6, 0, { zoom: 14, radiusM: 50 });
		for (const [k] of loadDemTile.mock.calls) expect(k.z).toBe(14);
		expect(loadDemTile.mock.calls.length).toBeLessThanOrEqual(4);
	});
});

describe("nearFieldDemRangeFrom", () => {
	const flat = (h: number) => ({
		frame: { lat: 46.5, lon: 8, h: 0 },
		heightAt: () => h,
	});
	const pose: Pose = { yaw: 0, pitch: -30, roll: 0, vfov: 60 };
	const view = { pose, aspect: 1, eye: { x: 0, y: 0, z: 100 } };

	it("answers with the engine fallback alone when there is no terrain", () => {
		const f = nearFieldDemRangeFrom(null, view, 16, 16, () => 123);
		expect(f(0.5, 0.5)).toBe(123);
		const f0 = nearFieldDemRangeFrom(flat(0), view, 16, 16, () => 7, 0);
		expect(f0(0.5, 0.5)).toBe(7);
		expect(nearFieldDemRangeFrom(flat(0), view, 0, 16, () => 9)(0.5, 0.5)).toBe(
			9,
		);
	});
	it("ranges over flat ground match plane geometry within the CPU radius", () => {
		// eye 100 m above flat ground at 0; looking 30 deg down: the centre ray hits at 100 / sin(30) = 200 m
		const f = nearFieldDemRangeFrom(flat(0), view, 32, 32, () => -1);
		const r = f(0.5, 0.5) as number;
		expect(r).toBeGreaterThan(190);
		expect(r).toBeLessThan(210);
		// steeper (lower in the frame) rays hit closer
		expect(f(0.5, 0.95) as number).toBeLessThan(r);
	});
	it("falls back where the profile sees no terrain or the hit is beyond cpuMax", () => {
		const f = nearFieldDemRangeFrom(flat(0), view, 32, 32, () => -1);
		expect(f(0.5, 0.02)).toBe(-1); // above the horizon: no hit
		const lim = nearFieldDemRangeFrom(flat(0), view, 32, 32, () => -1, 100);
		expect(lim(0.5, 0.5)).toBe(-1); // 200 m hit > cpuMax
		expect(NEAR_DEM_CPU_MAX).toBe(400);
	});
	it("a NearDem supplies its own eye height", () => {
		const nd = { ...flat(0), ground: 0, eyeZ: 50, zoom: 16 };
		const f = nearFieldDemRangeFrom(nd, view, 32, 32, () => -1);
		const r = f(0.5, 0.5) as number;
		expect(r).toBeGreaterThan(90);
		expect(r).toBeLessThan(110); // 50 / sin(30) = 100
	});
});
