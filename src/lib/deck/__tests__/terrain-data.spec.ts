// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import type { DemRaster, TileKey } from "../../dem";
import { latToTileY, lonToTileX, tileBounds, tileId } from "../../dem";
import { EnuFrame } from "../../geodesy";
import {
	BASE_MAX,
	baseCells,
	buildBatchGrid,
	buildLiteMesh,
	gridMesh,
	gridTriangles,
	meshTriangles,
} from "../batched-terrain-grid";
import { CpuGeometrySource, TerrainProfiles } from "../cpu-geometry";
import {
	buildMesh,
	localMaxOf,
	segmentsFor,
	selectDemTiles,
	TerrainSet,
} from "../terrain-data";

const LAT = 46.68;
const LON = 7.85;

function keyAt(z: number): TileKey {
	return {
		z,
		x: Math.floor(lonToTileX(LON, z)),
		y: Math.floor(latToTileY(LAT, z)),
	};
}

function raster(
	key: TileKey,
	size: number,
	f: (i: number, j: number) => number,
): DemRaster {
	const heights = new Float32Array(size * size);
	for (let j = 0; j < size; j++)
		for (let i = 0; i < size; i++) heights[j * size + i] = f(i, j);
	return { key, size, heights, source: key };
}

describe("selectDemTiles", () => {
	const base = {
		radiusM: 20_000,
		maxZoom: 13,
		minZoom: 9,
		lod: 2,
		lodOutside: 0.6,
	};

	it("returns tiles sorted by distance, all within the radius", () => {
		const t = selectDemTiles(LAT, LON, base);
		expect(t.length).toBeGreaterThan(4);
		for (let i = 1; i < t.length; i++)
			expect(t[i].distance).toBeGreaterThanOrEqual(t[i - 1].distance);
		for (const c of t) {
			expect(c.distance).toBeLessThanOrEqual(base.radiusM);
			expect(c.key.z).toBeGreaterThanOrEqual(base.minZoom);
			expect(c.key.z).toBeLessThanOrEqual(base.maxZoom);
		}
	});

	it("refines near the camera and stays coarse far away", () => {
		const t = selectDemTiles(LAT, LON, base);
		expect(t[0].key.z).toBe(base.maxZoom);
		const far = t[t.length - 1];
		expect(far.key.z).toBeLessThan(base.maxZoom);
	});

	it("covers the camera position exactly once (no overlapping tiles)", () => {
		const t = selectDemTiles(LAT, LON, base);
		const ids = t.map((c) => tileId(c.key));
		expect(new Set(ids).size).toBe(ids.length);
		for (let i = 0; i < t.length; i++)
			for (let j = i + 1; j < t.length; j++) {
				const a = t[i].key;
				const b = t[j].key;
				const [hi, lo] = a.z >= b.z ? [a, b] : [b, a];
				const s = hi.z - lo.z;
				expect(hi.x >> s === lo.x && hi.y >> s === lo.y).toBe(false);
			}
	});

	it("a wedge refines inside and leaves the opposite side coarser", () => {
		const wedge = { headingDeg: 0, halfAngleDeg: 30 };
		const t = selectDemTiles(LAT, LON, { ...base, wedge });
		const north = t.filter((c) => c.focus && c.distance > 3000);
		const some = t.filter((c) => !c.focus);
		expect(north.length).toBeGreaterThan(0);
		expect(some.length).toBeGreaterThan(0);
		const maxFocusZ = Math.max(...north.map((c) => c.key.z));
		const maxOutZ = Math.max(...some.map((c) => c.key.z));
		expect(maxFocusZ).toBeGreaterThanOrEqual(maxOutZ);
		// without a wedge every tile is "focus"
		expect(selectDemTiles(LAT, LON, base).every((c) => c.focus)).toBe(true);
	});

	it("a 360 wedge marks everything in focus", () => {
		const t = selectDemTiles(LAT, LON, {
			...base,
			wedge: { headingDeg: 0, halfAngleDeg: 180 },
		});
		expect(t.every((c) => c.focus)).toBe(true);
	});

	it("segmentsFor picks resolution by focus and nearness", () => {
		const k = keyAt(10);
		expect(segmentsFor({ key: k, distance: 10, size: 100, focus: true })).toBe(
			256,
		);
		expect(segmentsFor({ key: k, distance: 500, size: 100, focus: true })).toBe(
			128,
		);
		expect(segmentsFor({ key: k, distance: 10, size: 100, focus: false })).toBe(
			128,
		);
		expect(
			segmentsFor({ key: k, distance: 500, size: 100, focus: false }),
		).toBe(64);
	});
});

describe("localMaxOf", () => {
	it("finds the summit of a cone near the start and returns start when nothing is higher", () => {
		const peakLat = LAT + 0.0005;
		const peakLon = LON - 0.0004;
		const h = (la: number, lo: number) =>
			1000 - 1e5 * Math.hypot(la - peakLat, lo - peakLon);
		const r = localMaxOf(h, LAT, LON, 150);
		expect(r.h).toBeGreaterThan(h(LAT, LON));
		expect(Math.abs(r.lat - peakLat)).toBeLessThan(0.0003);
		const flat = localMaxOf(() => 5, LAT, LON, 150);
		expect(flat).toEqual({ lat: LAT, lon: LON, h: 5 });
	});

	it("null heights are skipped; all-null gives -Infinity", () => {
		expect(localMaxOf(() => null, LAT, LON).h).toBe(Number.NEGATIVE_INFINITY);
	});

	it("visits the start first then 81 grid points", () => {
		const calls: [number, number][] = [];
		localMaxOf(
			(a, b) => {
				calls.push([a, b]);
				return 0;
			},
			LAT,
			LON,
			100,
		);
		expect(calls.length).toBe(82);
		expect(calls[0]).toEqual([LAT, LON]);
	});
});

describe("TerrainSet", () => {
	const frame = new EnuFrame(LAT, LON, 600);
	// a plane rising to the east: h = 600 + 2*i  (size 33)
	const key = keyAt(11);
	const size = 33;
	const dem = raster(key, size, (i) => 600 + 2 * i);
	const mesh = buildMesh(frame, dem, 8, 100, true);
	const set = new TerrainSet(frame, [mesh]);
	const b = tileBounds(key);

	it("buildMesh emits consistent vertex arrays", () => {
		const n = 9;
		const vCount = n * n + 4 * n;
		expect(mesh.positions.length).toBe(vCount * 3);
		expect(mesh.normals.length).toBe(vCount * 3);
		expect(mesh.texCoords.length).toBe(vCount * 2);
		expect(mesh.elev.length).toBe(vCount);
		expect(mesh.indices.length).toBe(6 * 64 + 48 * 8);
		expect(meshTriangles(mesh)).toBe(gridTriangles(8));
		for (const i of mesh.indices) expect(i).toBeLessThan(vCount);
		for (let i = 0; i < mesh.normals.length; i += 3)
			expect(
				Math.hypot(mesh.normals[i], mesh.normals[i + 1], mesh.normals[i + 2]),
			).toBeCloseTo(1, 4);
	});

	it("heightAt interpolates inside coverage and is null outside", () => {
		const lat = (b.north + b.south) / 2;
		const west = b.west;
		const east = b.east;
		const hw = set.heightAt(lat, west + (east - west) * 0.001);
		const he = set.heightAt(lat, west + (east - west) * 0.99);
		expect(hw).not.toBeNull();
		expect(he as number).toBeGreaterThan(hw as number);
		expect(set.heightAt(b.north + 1, west)).toBeNull();
	});

	it("locate agrees with heightAt's lookup", () => {
		const out = { tile: mesh, px: 0, py: 0 };
		const lat = (b.north + b.south) / 2;
		const lon = (b.west + b.east) / 2;
		expect(set.locate(lat, lon, out)).toBe(out);
		expect(out.px).toBeCloseTo(size / 2, 3);
		expect(set.locate(0, 0, out)).toBeNull();
	});

	it("localMax climbs the slope to the east", () => {
		const lat = (b.north + b.south) / 2;
		const lon = (b.west + b.east) / 2;
		const m = set.localMax(lat, lon, 300);
		expect(m.lon).toBeGreaterThan(lon);
	});

	it("clearance is positive above the ground and NaN without data", () => {
		const e = set.frame.fromGeo(
			(b.north + b.south) / 2,
			(b.west + b.east) / 2,
			5000,
		);
		expect(set.clearance(e)).toBeGreaterThan(3000);
		expect(Number.isNaN(set.clearance([0, 1e7, 0]))).toBe(true);
	});

	it("raycast hits the ground below and misses the sky", () => {
		const eye = [0, 0, 400];
		const hit = set.raycast(eye, [0, 0, -1], 5000, 5);
		expect(hit).not.toBeNull();
		expect(set.raycast(eye, [0, 0, 1], 5000, 5)).toBeNull();
	});

	it("lineOfSight is blocked through a ridge and clear above it", () => {
		const ridge = raster(key, size, (i) => (i > 14 && i < 18 ? 3000 : 600));
		const rs = new TerrainSet(frame, [buildMesh(frame, ridge, 8, 100, true)]);
		const lat = (b.north + b.south) / 2;
		const a = frame.fromGeo(lat, b.west + (b.east - b.west) * 0.1, 800);
		const bb = frame.fromGeo(lat, b.west + (b.east - b.west) * 0.9, 800);
		expect(rs.lineOfSight(a, bb)).toBe(false);
		const a2 = frame.fromGeo(lat, b.west + (b.east - b.west) * 0.1, 6000);
		const b2 = frame.fromGeo(lat, b.west + (b.east - b.west) * 0.9, 6000);
		expect(rs.lineOfSight(a2, b2)).toBe(true);
	});
});

describe("batched grid", () => {
	const frame = new EnuFrame(LAT, LON, 600);

	it("baseCells and triangles", () => {
		expect(baseCells(8)).toBe(BASE_MAX);
		expect(baseCells(10)).toBe(32);
		expect(gridTriangles(4)).toBe(2 * 16 + 64);
	});

	it("buildBatchGrid has (G+1)^2 nodes and a bounding sphere that holds the tile heights", () => {
		const key = keyAt(11);
		const g = buildBatchGrid(frame, key, new Float32Array([500, 1500]));
		expect(g.G).toBe(32);
		expect(g.base.length).toBe(33 * 33 * 4);
		expect(g.skirt).toBeGreaterThanOrEqual(30);
		expect(g.sphere[3]).toBeGreaterThan(0);
		// the same range as {lo,hi}
		const g2 = buildBatchGrid(frame, key, { lo: 500, hi: 1500 });
		expect(g2.sphere).toEqual(g.sphere);
		// node (0,0) is the NW corner: lat of tile north edge
		const b = tileBounds(key);
		const nw = frame.fromGeo(b.north, b.west, 0);
		expect(g.base[0]).toBeCloseTo(nw[0], 0);
		expect(g.base[1]).toBeCloseTo(nw[1], 0);
	});

	it("buildLiteMesh has empty vertex arrays and a grid; lazy tile needs stats", () => {
		const key = keyAt(11);
		const dem = raster(key, 17, () => 700);
		const lite = buildLiteMesh(frame, dem, 8, 50, true);
		expect(lite.positions.length).toBe(0);
		expect(lite.grid?.G).toBe(32);
		expect(meshTriangles(lite)).toBe(gridTriangles(8));
		const lazy = { ...dem, heights: undefined as never };
		expect(() => buildLiteMesh(frame, lazy, 8, 50, true)).toThrow(
			/heightStats/,
		);
	});

	it("gridMesh is cached, indices in range, skirt vertices flagged", () => {
		const m = gridMesh(4);
		expect(gridMesh(4)).toBe(m);
		const n = 5;
		const vCount = n * n + 4 * n;
		expect(m.grid.length).toBe(vCount * 3);
		expect(m.indices.length).toBe(6 * 16 + 48 * 4);
		for (const i of m.indices) expect(i).toBeLessThan(vCount);
		for (let v = n * n; v < vCount; v++) expect(m.grid[v * 3 + 2]).toBe(1);
		for (let v = 0; v < n * n; v++) expect(m.grid[v * 3 + 2]).toBe(0);
	});
});

describe("CPU geometry", () => {
	// flat ground 100 m below the eye, a wall (high ridge) to the north at ~2 km
	const frame = { lat: LAT, lon: LON, h: 1000 };
	const wallLat = LAT + 2000 / 111_320;
	const terrain = {
		frame,
		heightAt: (lat: number) => (lat > wallLat ? 2500 : 900),
	};

	it("rangeAlong: down hits flat ground at the geometric range, up is sky", () => {
		const p = new TerrainProfiles(terrain, 0, { azStep: 1, maxRange: 20_000 });
		// looking east, 10 degrees down: ground is 100 m below (minus curvature, small)
		const el = (-10 * Math.PI) / 180;
		const r = p.rangeAlong(Math.cos(el), 0, Math.sin(el));
		expect(r).toBeCloseTo(100 / Math.sin(-el), -1);
		expect(p.rangeAlong(1, 0, 0.5)).toBe(Number.POSITIVE_INFINITY);
		expect(p.rangeAlong(0, 0, 1)).toBe(Number.POSITIVE_INFINITY);
		expect(p.binCount).toBeGreaterThan(0);
	});

	it("a ridge to the north is hit before the ground", () => {
		const p = new TerrainProfiles(terrain, 0, { azStep: 1, maxRange: 20_000 });
		const dir = [0, Math.cos(0.1), Math.sin(0.1)]; // slightly up, north
		const r = p.rangeAlong(dir[0], dir[1], dir[2]);
		expect(Number.isFinite(r)).toBe(true);
		expect(r).toBeGreaterThan(1900);
		expect(r).toBeLessThan(2300);
	});

	it("horizonDirs yields unit vectors and respects abort", async () => {
		const p = new TerrainProfiles(terrain, 0, { azStep: 5, maxRange: 5000 });
		const d = await p.horizonDirs(10, 1000);
		expect(d.length % 3).toBe(0);
		expect(d.length).toBeGreaterThan(0);
		for (let i = 0; i < d.length; i += 3)
			expect(Math.hypot(d[i], d[i + 1], d[i + 2])).toBeCloseTo(1, 5);
		const ac = new AbortController();
		ac.abort();
		expect((await p.horizonDirs(10, 1000, ac.signal)).length).toBe(0);
	});

	it("CpuGeometrySource fills range/xyz: sky is Infinity/NaN and ground rows are finite", async () => {
		const p = new TerrainProfiles(terrain, 0, { azStep: 2, maxRange: 20_000 });
		const src = new CpuGeometrySource(p, [0, 0, 0], 1.5, 12, 8);
		const pose = { yaw: 180, pitch: 0, roll: 0, vfov: 40 };
		await src.render(pose);
		expect(src.pose).toEqual(pose);
		expect(src.range[0]).toBe(Number.POSITIVE_INFINITY); // top row = sky
		expect(Number.isNaN(src.xyz[0])).toBe(true);
		const bottom = 7 * 12 + 6;
		expect(Number.isFinite(src.range[bottom])).toBe(true);
		expect(src.xyz[bottom * 3 + 2]).toBeLessThan(0); // below the eye
		// facing the wall (north): the centre column is nearer at the bottom than the top
		await src.render({ ...pose, yaw: 0 });
		expect(src.range[6]).toBeGreaterThan(src.range[7 * 12 + 6]);
		expect(src.range[6]).toBeGreaterThan(1900);
	});
});
