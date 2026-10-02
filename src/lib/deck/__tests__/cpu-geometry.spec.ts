// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { poseBasis } from "../../camera";
import { CpuGeometrySource, TerrainProfiles } from "../cpu-geometry";
import { skylineRows } from "../geometry-source";

const LAT = 46.7;
const LON = 8;
const frame = { lat: LAT, lon: LON, h: 1000 };
const DEG_LAT_M = 111_194.9; // metres per degree of latitude (EARTH_R * pi / 180)

/** Flat ground 100 m below the eye (eye at ENU z = 0). */
const flat = { frame, heightAt: () => 900 };

/** Flat ground plus a 1100 m wall (top 2000 m) from 1.11 km north of the eye northwards. */
const wallLat = LAT + 1112 / DEG_LAT_M;
const walled = {
	frame,
	heightAt: (lat: number) => (lat >= wallLat ? 2000 : 900),
};

const fast = { azStep: 1, maxRange: 6000 };
const unit = (elevDeg: number, azDeg: number) => {
	const e = (elevDeg * Math.PI) / 180;
	const a = (azDeg * Math.PI) / 180;
	return [
		Math.cos(e) * Math.sin(a),
		Math.cos(e) * Math.cos(a),
		Math.sin(e),
	] as const;
};

describe("TerrainProfiles.rangeAlong", () => {
	it("hits flat ground at depth / sin(depression)", () => {
		const p = new TerrainProfiles(flat, 0, fast);
		for (const [depr, az] of [
			[10, 0],
			[10, 137],
			[20, 270],
			[5, 45],
		]) {
			const r = p.rangeAlong(...unit(-depr, az));
			const want = 100 / Math.sin((depr * Math.PI) / 180);
			expect(Math.abs(r - want) / want).toBeLessThan(0.01);
		}
	});

	it("returns Infinity for rays above the terrain and for straight up/down", () => {
		const p = new TerrainProfiles(flat, 0, fast);
		expect(p.rangeAlong(...unit(5, 10))).toBe(Number.POSITIVE_INFINITY);
		expect(p.rangeAlong(0, 0, 1)).toBe(Number.POSITIVE_INFINITY);
		expect(p.rangeAlong(0, 0, -1)).toBe(Number.POSITIVE_INFINITY);
	});

	it("sees a wall at its distance and rays over it as sky", () => {
		const p = new TerrainProfiles(walled, 0, fast);
		const r = p.rangeAlong(...unit(10, 0));
		const want = 1112 / Math.cos((10 * Math.PI) / 180);
		expect(Math.abs(r - want) / want).toBeLessThan(0.01);
		// 50 degrees clears the 45-degree-ish wall top
		expect(p.rangeAlong(...unit(50, 0))).toBe(Number.POSITIVE_INFINITY);
		// facing south the wall is irrelevant
		expect(p.rangeAlong(...unit(10, 180))).toBe(Number.POSITIVE_INFINITY);
	});

	it("range is monotone in elevation on flat ground (steeper = nearer)", () => {
		const p = new TerrainProfiles(flat, 0, fast);
		let last = Number.POSITIVE_INFINITY;
		for (let d = 2; d <= 60; d += 4) {
			const r = p.rangeAlong(...unit(-d, 33));
			expect(r).toBeLessThan(last);
			last = r;
		}
	});

	it("snaps azimuth to bins, wraps 360 -> 0 and caches one bin per azimuth", () => {
		const p = new TerrainProfiles(flat, 0, fast);
		const a = p.rangeAlong(...unit(-10, 0.2));
		const b = p.rangeAlong(...unit(-10, 359.8));
		expect(Math.abs(a - b)).toBeLessThan(1e-3);
		expect(p.binCount).toBe(1);
		p.rangeAlong(...unit(-10, 90));
		expect(p.binCount).toBe(2);
	});

	it("treats missing DEM coverage as no terrain", () => {
		const p = new TerrainProfiles({ frame, heightAt: () => null }, 0, fast);
		expect(p.rangeAlong(...unit(-30, 0))).toBe(Number.POSITIVE_INFINITY);
	});

	it("a higher eye sees flat ground proportionally further", () => {
		const lo = new TerrainProfiles(flat, 0, fast);
		const hi = new TerrainProfiles(flat, 100, fast); // 200 m above ground
		const dir = unit(-10, 0);
		expect(hi.rangeAlong(...dir) / lo.rangeAlong(...dir)).toBeCloseTo(2, 1);
	});
});

describe("TerrainProfiles.horizonDirs", () => {
	it("returns unit ENU directions, one per step, skipping uncovered azimuths", async () => {
		const p = new TerrainProfiles(walled, 0, fast);
		const d = await p.horizonDirs(30, 4);
		expect(d.length / 3).toBe(12);
		for (let i = 0; i < d.length; i += 3)
			expect(Math.hypot(d[i], d[i + 1], d[i + 2])).toBeCloseTo(1, 5);
		// north azimuth (k = 0) is the wall: elevation of its top edge, well above flat ground
		expect(d[2]).toBeGreaterThan(0.2);
		const none = new TerrainProfiles({ frame, heightAt: () => null }, 0, fast);
		expect((await none.horizonDirs(30)).length).toBe(0);
	});

	it("stops when aborted", async () => {
		const p = new TerrainProfiles(flat, 0, fast);
		const ac = new AbortController();
		ac.abort();
		expect((await p.horizonDirs(10, 60, ac.signal)).length).toBe(0);
	});
});

describe("CpuGeometrySource", () => {
	const pose = { yaw: 0, pitch: -5, roll: 0, vfov: 40 };

	it("fills top-first range / xyz: sky above the horizon, ground below, consistent hits", () => {
		const p = new TerrainProfiles(flat, 0, fast);
		const src = new CpuGeometrySource(p, [0, 0, 0], 1.5, 12, 24);
		src.renderSync(pose);
		expect(src.pose).toEqual(pose);
		expect(src.pose).not.toBe(pose);
		const W = 12;
		for (let x = 0; x < W; x++) {
			expect(src.range[x]).toBe(Number.POSITIVE_INFINITY);
			expect(src.xyz[x * 3]).toBeNaN();
		}
		let finite = 0;
		for (let i = 0; i < src.range.length; i++) {
			if (!Number.isFinite(src.range[i])) continue;
			finite++;
			// the hit point lies on the ground plane (z about -100, curvature negligible) and
			// at |xyz| = range from the eye
			expect(src.xyz[i * 3 + 2]).toBeCloseTo(-100, 0);
			expect(
				Math.hypot(src.xyz[i * 3], src.xyz[i * 3 + 1], src.xyz[i * 3 + 2]),
			).toBeCloseTo(src.range[i], 3);
		}
		expect(finite).toBeGreaterThan(src.range.length / 4);
		// skyline rows are a non-increasing... a single contiguous sky band: every column the same row
		const sky = skylineRows(src);
		expect(new Set(sky).size).toBe(1);
		expect(sky[0]).toBeGreaterThan(0);
	});

	it("looks along the pose: yaw east hits ground east of the eye", async () => {
		const p = new TerrainProfiles(flat, 0, fast);
		const src = new CpuGeometrySource(p, [0, 0, 0], 1, 8, 8);
		await src.render({ yaw: 90, pitch: -20, roll: 0, vfov: 10 });
		const { forward } = poseBasis({ yaw: 90, pitch: -20, roll: 0, vfov: 10 });
		const i = 4 * 8 + 4;
		const dir = [src.xyz[i * 3], src.xyz[i * 3 + 1], src.xyz[i * 3 + 2]].map(
			(v) => v / src.range[i],
		);
		expect(dir[0]).toBeCloseTo(forward[0], 1);
		expect(dir[0]).toBeGreaterThan(0.8);
	});
});
