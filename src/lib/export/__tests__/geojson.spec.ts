// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { EARTH_R } from "../../geodesy";
import {
	buildGeoJson,
	type Feature,
	lineGeometry,
	pointAlong,
	polygonGeometry,
	ringSignedArea,
	sampleFootprint,
	unwrapLon,
} from "../geojson";
import { FIXTURE, SOUTH } from "./fixtures";

/** Exact initial great-circle bearing, degrees. */
function initialBearing(
	lat1: number,
	lon1: number,
	lat2: number,
	lon2: number,
) {
	const r = Math.PI / 180;
	const dl = (lon2 - lon1) * r;
	const y = Math.sin(dl) * Math.cos(lat2 * r);
	const x =
		Math.cos(lat1 * r) * Math.sin(lat2 * r) -
		Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos(dl);
	return (Math.atan2(y, x) / r + 360) % 360;
}

const kind = (fc: { features: Feature[] }, k: string) =>
	fc.features.filter((f) => f.properties.kind === k);

describe("pointAlong", () => {
	it("moves due north by dist/R radians", () => {
		const [lon, lat] = pointAlong(0, 10, 0, 1000);
		expect(lon).toBeCloseTo(10, 8);
		expect(lat).toBeCloseTo(((1000 / EARTH_R) * 180) / Math.PI, 7);
	});
	it("returns the start for zero distance", () => {
		expect(pointAlong(46.9, 8.6, 123, 0)).toEqual([8.6, 46.9]);
	});
	it("wraps longitude across the antimeridian", () => {
		const [lon] = pointAlong(0, 179.9, 90, 50_000);
		expect(lon).toBeLessThan(0);
		expect(lon).toBeGreaterThan(-180);
	});
	it("lands on the requested initial bearing", () => {
		const [lo, la] = pointAlong(46.9, 8.6, 70, 20_000);
		expect(initialBearing(46.9, 8.6, la, lo)).toBeCloseTo(70, 2);
	});
});

describe("ringSignedArea / unwrapLon", () => {
	it("is positive for CCW and negative for CW", () => {
		const sq: [number, number][] = [
			[0, 0],
			[1, 0],
			[1, 1],
			[0, 1],
			[0, 0],
		];
		expect(ringSignedArea(sq)).toBe(1);
		expect(ringSignedArea([...sq].reverse())).toBe(-1);
	});
	it("unwraps within 180 of the reference", () => {
		expect(unwrapLon(-179, 179)).toBe(181);
		expect(unwrapLon(179, -179)).toBe(-181);
		expect(unwrapLon(10, 12)).toBe(10);
	});
});

describe("polygonGeometry / lineGeometry", () => {
	it("keeps an ordinary ring a Polygon", () => {
		const ring: [number, number][] = [
			[8, 46],
			[9, 46],
			[9, 47],
			[8, 46],
		];
		expect(polygonGeometry(ring)).toEqual({
			type: "Polygon",
			coordinates: [ring],
		});
	});
	it("splits a ring crossing +180 into a MultiPolygon within [-180, 180]", () => {
		const ring: [number, number][] = [
			[179, 0],
			[181, 0],
			[181, 1],
			[179, 1],
			[179, 0],
		];
		const g = polygonGeometry(ring);
		expect(g.type).toBe("MultiPolygon");
		const polys = g.coordinates as [number, number][][][];
		expect(polys).toHaveLength(2);
		for (const p of polys)
			for (const [lon] of p[0]) expect(Math.abs(lon)).toBeLessThanOrEqual(180);
		expect(polys[0][0].every(([lon]) => lon >= 179)).toBe(true);
		expect(polys[1][0].every(([lon]) => lon <= -179)).toBe(true);
	});
	it("splits a line crossing -180", () => {
		const g = lineGeometry([
			[-179, 5],
			[-181, 7],
		]);
		expect(g.type).toBe("MultiLineString");
		const lines = g.coordinates as [number, number][][];
		expect(lines[0][lines[0].length - 1]).toEqual([-180, 6]);
		expect(lines[1][0]).toEqual([180, 6]);
		for (const l of lines)
			for (const [lon] of l) expect(Math.abs(lon)).toBeLessThanOrEqual(180);
	});
	it("keeps a normal line a LineString", () => {
		expect(
			lineGeometry([
				[1, 1],
				[2, 2],
			]).type,
		).toBe("LineString");
	});
});

describe("buildGeoJson", () => {
	const fc = buildGeoJson(FIXTURE);
	it("is a FeatureCollection that survives JSON", () => {
		expect(fc.type).toBe("FeatureCollection");
		expect(JSON.parse(JSON.stringify(fc))).toEqual(fc);
		expect(fc.features.map((f) => f.properties.kind)).toEqual([
			"camera",
			"view-direction",
			"fov-wedge",
		]);
	});
	it("puts the camera at lon/lat/ellipsoidal z when N is known", () => {
		const cam = kind(fc, "camera")[0];
		const c = cam.geometry.coordinates as number[];
		expect(c[0]).toBeCloseTo(8.668494, 5);
		expect(c[1]).toBeCloseTo(46.975961, 5);
		expect(c[2]).toBeCloseTo(1361.3 + 49, 1);
		expect(cam.properties.altMsl).toBeCloseTo(1361.3, 1);
	});
	it("omits z and ellipsoidal height when N is unknown", () => {
		const cam = kind(
			buildGeoJson({ ...FIXTURE, geoidUndulation: undefined }),
			"camera",
		)[0];
		expect((cam.geometry.coordinates as number[]).length).toBe(2);
		expect(cam.properties.altEllipsoid).toBeNull();
	});
	it("draws the view ray along yaw for maxRange metres", () => {
		const ray = kind(fc, "view-direction")[0];
		const [a, b] = ray.geometry.coordinates as [number, number][];
		expect(initialBearing(a[1], a[0], b[1], b[0])).toBeCloseTo(20.84, 2);
		expect(ray.properties.rangeM).toBe(30000);
	});
	it("builds a CCW closed wedge ring starting at the camera", () => {
		const w = kind(fc, "fov-wedge")[0];
		const ring = (w.geometry.coordinates as [number, number][][])[0];
		expect(ring[0]).toEqual(ring[ring.length - 1]);
		expect(ring).toHaveLength(32 + 1 + 2); // camera + arc points + closing point
		expect(ringSignedArea(ring)).toBeGreaterThan(0);
	});
	it("scales the wedge with arcSteps and maxRange", () => {
		const f = buildGeoJson(FIXTURE, { arcSteps: 4, maxRange: 1000 });
		const ring = (
			kind(f, "fov-wedge")[0].geometry.coordinates as number[][][]
		)[0];
		expect(ring).toHaveLength(4 + 3);
	});
	it("handles a camera next to the antimeridian", () => {
		const f = buildGeoJson({
			...FIXTURE,
			frame: { lat: 0, lon: 179.95, h: 0 },
			pose: { ...FIXTURE.pose, yaw: 90 },
		});
		expect(kind(f, "fov-wedge")[0].geometry.type).toBe("MultiPolygon");
		expect(kind(f, "view-direction")[0].geometry.type).toBe("MultiLineString");
	});
	const peaks = [
		{
			name: "A",
			ele: 2000,
			lat: 47,
			lon: 8.7,
			u: 0.25,
			v: 0.5,
			visible: true,
			distKm: 1.23456,
		},
		{
			name: "B",
			ele: null,
			lat: 47.1,
			lon: 8.8,
			u: 0.5,
			v: 0.5,
			visible: false,
		},
		{
			name: "C",
			ele: 1500,
			lat: 47.2,
			lon: 8.9,
			u: 0.75,
			v: 0.5,
			visible: null,
		},
	];
	it("drops hidden peaks by default, keeps untested ones", () => {
		const names = kind(buildGeoJson(FIXTURE, { peaks }), "peak").map(
			(f) => f.properties.name,
		);
		expect(names).toEqual(["A", "C"]);
	});
	it("includes hidden peaks when asked and adds pixel coordinates", () => {
		const ps = kind(
			buildGeoJson(FIXTURE, { peaks, includeHiddenPeaks: true }),
			"peak",
		);
		expect(ps.map((f) => f.properties.name)).toEqual(["A", "B", "C"]);
		expect(ps[0].properties.px).toBe(1008);
		expect(ps[0].properties.py).toBe(1512);
		expect(ps[0].properties.distKm).toBe(1.235);
		expect(ps[1].properties.distKm).toBeNull();
	});
	it("gives peaks an ellipsoidal z only with N and an elevation", () => {
		const ps = kind(
			buildGeoJson(FIXTURE, { peaks, includeHiddenPeaks: true }),
			"peak",
		);
		expect((ps[0].geometry.coordinates as number[])[2]).toBe(2049);
		expect(ps[1].geometry.coordinates as number[]).toHaveLength(2);
		const noN = kind(buildGeoJson(SOUTH, { peaks }), "peak");
		expect(noN[0].geometry.coordinates as number[]).toHaveLength(2);
	});
	it("adds a footprint from pixelToLatLon", () => {
		const f = buildGeoJson(FIXTURE, {
			footprintCols: 4,
			footprintRows: 4,
			pixelToLatLon: (u, v) =>
				v < 0.3 ? null : { lat: 47 + (1 - v) * 0.01, lon: 8.6 + u * 0.01 },
		});
		const fp = kind(f, "footprint")[0];
		expect(fp.geometry.type).toBe("Polygon");
		expect(
			ringSignedArea(
				(fp.geometry.coordinates as number[][][])[0] as [number, number][],
			),
		).toBeGreaterThan(0);
	});
	it("skips the footprint when nothing hits the ground", () => {
		expect(
			kind(buildGeoJson(FIXTURE, { pixelToLatLon: () => null }), "footprint"),
		).toHaveLength(0);
	});
});

describe("sampleFootprint", () => {
	it("takes the lowest hit per column as the near edge and the topmost as the far edge", () => {
		const fp = sampleFootprint(
			(u, v) => (v >= 0.4 && v <= 0.8 ? { lat: v, lon: u } : null),
			2,
			10,
		);
		expect(fp).not.toBeNull();
		const ring = fp?.ring ?? [];
		expect(ring).toHaveLength(6);
		expect(ring[0][1]).toBeCloseTo(0.8, 6);
		expect(ring[ring.length - 1][1]).toBeCloseTo(0.4, 6);
		expect(fp?.samples).toBe(3 * 11);
	});
	it("ignores non-finite coordinates", () => {
		expect(
			sampleFootprint(() => ({ lat: Number.NaN, lon: 1 }), 3, 3),
		).toBeNull();
	});
	it("unwraps longitude around a reference", () => {
		const fp = sampleFootprint(() => ({ lat: 0, lon: -179.9 }), 2, 2, 179.9);
		expect(fp?.ring[0][0]).toBeCloseTo(180.1, 6);
	});
});
