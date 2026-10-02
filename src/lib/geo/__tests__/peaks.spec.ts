// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { destination, distanceBearing } from "../../geodesy";
import { cameraFromAngles } from "../camera";
import {
	apparentElevation,
	layoutPeakLabels,
	overpassPeaksQuery,
	type Peak,
	type PeakView,
	parseOverpassPeaks,
	viewPeaks,
} from "../peaks";
import type { TerrainSampler } from "../terrain";

describe("overpassPeaksQuery", () => {
	it("embeds a rounded radius and 5-decimal coordinates for both peaks and volcanoes", () => {
		const q = overpassPeaksQuery(46.123456789, 7.9876543, 25_000.4);
		expect(q).toContain("around:25000,46.12346,7.98765");
		expect(q).toContain('"natural"="peak"');
		expect(q).toContain('"natural"="volcano"');
		expect(q.startsWith("[out:json]")).toBe(true);
	});
});

describe("parseOverpassPeaks", () => {
	it("returns [] for junk", () => {
		expect(parseOverpassPeaks(null)).toEqual([]);
		expect(parseOverpassPeaks({})).toEqual([]);
		expect(parseOverpassPeaks({ elements: "x" })).toEqual([]);
	});
	it("keeps only nodes with coordinates and parses tags", () => {
		const peaks = parseOverpassPeaks({
			elements: [
				{
					type: "node",
					id: 1,
					lat: 46,
					lon: 8,
					tags: { name: "A", ele: "2962", wikidata: "Q1" },
				},
				{ type: "way", id: 2, lat: 46, lon: 8 },
				{ type: "node", id: 3, tags: { name: "no coords" } },
				{
					type: "node",
					id: 4,
					lat: 47,
					lon: 9,
					tags: { "name:de": "Horn", ele: "9,000 ft", prominence: "120 m" },
				},
				{ type: "node", id: 5, lat: 47, lon: 9 },
			],
		});
		expect(peaks.map((p) => p.id)).toEqual(["node/1", "node/4", "node/5"]);
		expect(peaks[0]).toMatchObject({ name: "A", ele: 2962, wikidata: "Q1" });
		expect(peaks[1].name).toBe("Horn");
		expect(peaks[1].ele).toBeCloseTo(9000 * 0.3048, 6);
		expect(peaks[1].prominence).toBe(120);
		expect(peaks[2].name).toBeUndefined();
		expect(peaks[2].ele).toBeUndefined();
	});
	it("parses decimal commas and thousands separators", () => {
		const e = (ele: string) =>
			parseOverpassPeaks({
				elements: [{ type: "node", id: 1, lat: 0, lon: 0, tags: { ele } }],
			})[0].ele;
		expect(e("1,234")).toBe(1234);
		expect(e("1234,5")).toBeCloseTo(1234.5, 6);
		expect(e("2500 m")).toBe(2500);
		expect(e("n/a")).toBeUndefined();
	});
	it("treats an ele with a ' mark as feet", () => {
		const p = parseOverpassPeaks({
			elements: [
				{ type: "node", id: 1, lat: 0, lon: 0, tags: { ele: "1000'" } },
			],
		});
		expect(p[0].ele).toBeCloseTo(304.8, 6);
	});
});

describe("apparentElevation", () => {
	it("is atan(dh/d) at short range", () => {
		expect(apparentElevation(1100, 100, 1000)).toBeCloseTo(45, 2);
	});
	it("curvature lowers far objects at equal height", () => {
		expect(apparentElevation(100, 100, 50_000)).toBeLessThan(0);
		expect(apparentElevation(100, 100, 50_000)).toBeLessThan(
			apparentElevation(100, 100, 5000),
		);
	});
	it("drop equals d^2 / (2 R/(1-k)) metres", () => {
		const d = 30_000;
		const drop = (d * d) / (2 * (6371008.8 / (1 - 0.13)));
		expect(apparentElevation(500 + drop, 500, d)).toBeCloseTo(0, 6);
	});
});

describe("viewPeaks", () => {
	const lat = 46;
	const lon = 8;
	const flat = (h: (d: number) => number) =>
		({
			sampleAt: (plon: number, plat: number, d: number) =>
				h(d) + 0 * (plon + plat),
		}) as unknown as TerrainSampler;
	const peakAt = (az: number, d: number, ele?: number): Peak => {
		const p = destination(lat, lon, az, d);
		return { id: `p${az}-${d}`, name: "P", lat: p.lat, lon: p.lon, ele };
	};
	it("computes azimuth and distance", () => {
		const [v] = viewPeaks(
			[peakAt(70, 10_000, 2000)],
			flat(() => 0),
			lat,
			lon,
			500,
		);
		expect(v.azimuth).toBeCloseTo(70, 3);
		expect(v.distance).toBeCloseTo(10_000, 0);
		expect(v.height).toBe(2000);
		expect(v.visible).toBe(true);
		expect(v.elevation).toBeCloseTo(
			apparentElevation(2000, 500, v.distance),
			6,
		);
	});
	it("uses the higher of DEM and OSM elevation", () => {
		const [a] = viewPeaks(
			[peakAt(0, 5000, 100)],
			flat(() => 700),
			lat,
			lon,
			0,
		);
		expect(a.height).toBe(700);
		const [b] = viewPeaks(
			[peakAt(0, 5000, 900)],
			flat(() => 700),
			lat,
			lon,
			0,
		);
		expect(b.height).toBe(900);
	});
	it("skips peaks too near, too far, or with no height at all", () => {
		const t = flat(() => 0);
		expect(viewPeaks([peakAt(0, 10, 1000)], t, lat, lon, 0)).toHaveLength(0);
		expect(viewPeaks([peakAt(0, 200_000, 1000)], t, lat, lon, 0)).toHaveLength(
			0,
		);
		expect(
			viewPeaks([peakAt(0, 200_000, 1000)], t, lat, lon, 0, {
				maxDistance: 300_000,
			}),
		).toHaveLength(1);
		const nan = flat(() => Number.NaN);
		expect(viewPeaks([peakAt(0, 5000)], nan, lat, lon, 0)).toHaveLength(0);
		expect(viewPeaks([peakAt(0, 5000, 1500)], nan, lat, lon, 0)).toHaveLength(
			1,
		);
	});
	it("a ridge between eye and peak hides the peak", () => {
		const ridge = flat((d) => (d > 2000 && d < 2500 ? 1000 : 0));
		const [hidden] = viewPeaks([peakAt(0, 8000, 1500)], ridge, lat, lon, 0);
		expect(hidden.visible).toBe(false);
		const [seen] = viewPeaks([peakAt(0, 8000, 6000)], ridge, lat, lon, 0);
		expect(seen.visible).toBe(true);
	});
	it("terrain right at the summit (within the ignore zone) does not hide it", () => {
		const t = flat((d) => (d > 7900 ? 1500 : 0));
		const [v] = viewPeaks([peakAt(0, 8000, 1500)], t, lat, lon, 0);
		expect(v.visible).toBe(true);
	});
});

describe("layoutPeakLabels", () => {
	const cam = cameraFromAngles({
		width: 1000,
		height: 800,
		f: 1000,
		yaw: 0,
		pitch: 0,
		roll: 0,
	});
	const view = (
		azimuth: number,
		elevation: number,
		extra: Partial<PeakView> = {},
		name = "N",
	): PeakView => ({
		peak: { id: `${azimuth}`, name, lat: 0, lon: 0 },
		azimuth,
		elevation,
		distance: 5000,
		height: 2000,
		visible: true,
		...extra,
	});
	it("drops invisible peaks and peaks outside the frame or behind the camera", () => {
		const out = layoutPeakLabels(
			[
				view(0, 0, { visible: false }),
				view(90, 0),
				view(180, 0),
				view(0, 40),
				view(2, 1),
			],
			cam,
		);
		expect(out).toHaveLength(1);
		expect(out[0].peak.id).toBe("2");
		expect(out[0].x).toBeGreaterThan(500);
	});
	it("returns left to right and enforces the horizontal spacing", () => {
		const views = [
			view(6, 2),
			view(-6, 2),
			view(0, 2),
			view(0.2, 2, { height: 5000 }),
		];
		const out = layoutPeakLabels(views, cam, { minSpacingPx: 30 });
		for (let i = 1; i < out.length; i++) {
			expect(out[i].x).toBeGreaterThanOrEqual(out[i - 1].x);
			expect(out[i].x - out[i - 1].x).toBeGreaterThanOrEqual(30);
		}
		// the taller peak wins the contested centre slot
		expect(out.some((o) => o.height === 5000)).toBe(true);
		expect(out.some((o) => o.peak.id === "0")).toBe(false);
	});
	it("honours maxLabels and ranks named/wikidata peaks first", () => {
		const views = [
			view(-5, 1, {}, ""),
			view(0, 1),
			view(5, 1, {
				peak: { id: "w", name: "W", wikidata: "Q1", lat: 0, lon: 0 },
			}),
		];
		views[0].peak.name = undefined;
		const out = layoutPeakLabels(views, cam, { maxLabels: 2 });
		expect(out).toHaveLength(2);
		expect(out.map((o) => o.peak.id)).not.toContain("-5");
	});
	it("distanceBearing sanity (fixture helper)", () => {
		const p = destination(46, 8, 123, 5000);
		const r = distanceBearing(46, 8, p.lat, p.lon);
		expect(r.distance).toBeCloseTo(5000, 3);
		expect(r.bearing).toBeCloseTo(123, 4);
	});
});
