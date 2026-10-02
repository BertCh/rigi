// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { withFlags } from "#/test/helpers";
import {
	bboxAround,
	bundledRegionIdFor,
	isLocalRegionId,
	PEAK_RADIUS_KM,
	parseMetres,
	parsePeaks,
	parseTrails,
	peakBBox,
	REGION_SNAP_DEG,
	regionIdFor,
	regionQueries,
	snapCenter,
	TRAIL_RADIUS_KM,
} from "../region";

describe("bboxAround", () => {
	it("returns [south, west, north, east] centred on the point", () => {
		const [s, w, n, e] = bboxAround(47, 8, 100);
		expect((s + n) / 2).toBeCloseTo(47, 12);
		expect((w + e) / 2).toBeCloseTo(8, 12);
		expect(n - s).toBeCloseTo((2 * 100) / 111.32, 9);
	});
	it("widens in longitude with latitude (a degree of lon is shorter)", () => {
		const eq = bboxAround(0, 0, 50);
		const hi = bboxAround(60, 0, 50);
		expect(hi[3] - hi[1]).toBeCloseTo(
			(eq[3] - eq[1]) / Math.cos(Math.PI / 3),
			9,
		);
	});
});

describe("snapCenter / regionIdFor", () => {
	it("snaps to the 0.05 degree grid", () => {
		expect(REGION_SNAP_DEG).toBe(0.05);
		expect(snapCenter(46.96, 8.668)).toEqual([46.95, 8.65]);
		expect(snapCenter(46.976, 8.668)).toEqual([47, 8.65]);
		expect(snapCenter(46.98, 8.68)).toEqual([47, 8.7]);
		expect(snapCenter(-33.91, -70.62)).toEqual([-33.9, -70.6]);
	});
	it("nearby photos share a region id, far ones do not", () => {
		expect(regionIdFor(46.976, 8.668)).toBe(regionIdFor(46.99, 8.64));
		expect(regionIdFor(46.976, 8.668)).not.toBe(regionIdFor(47.2, 8.668));
	});
	it("formats the id with two decimals and the local prefix", () => {
		expect(regionIdFor(46.976, 8.668)).toBe("local-region-47.00_8.65");
		expect(regionIdFor(-33.9, -70.6)).toBe("local-region--33.90_-70.60");
		expect(isLocalRegionId(regionIdFor(1, 2))).toBe(true);
		expect(isLocalRegionId("region-0")).toBe(false);
	});
});

describe("regionQueries", () => {
	const q = regionQueries(47, 8);
	it("builds three Overpass QL queries with 5-decimal bboxes", () => {
		expect(q.peaks).toMatch(
			/^\[out:json\]\[timeout:90\];node\["natural"~"peak\|volcano"\]\["name"\]\(\d+\.\d{5},\d+\.\d{5},\d+\.\d{5},\d+\.\d{5}\);out;$/,
		);
		expect(q.trails).toContain('["sac_scale"]');
		expect(q.trails).toContain("out geom;");
		expect(q.water).toContain('"natural"="water"');
	});
	it("peaks use the 60 km box, trails the 12 km box widened by the 3 km snap slack", () => {
		const bb = (km: number) =>
			bboxAround(47, 8, km)
				.map((v) => v.toFixed(5))
				.join(",");
		expect(q.peaks).toContain(`(${bb(PEAK_RADIUS_KM)})`);
		expect(q.trails).toContain(`(${bb(TRAIL_RADIUS_KM + 3)})`);
		expect(q.water).toContain(`(${bb(TRAIL_RADIUS_KM + 3)})`);
	});
	it("peakBBox parses back to the same box", () => {
		const [s, w, n, e] = peakBBox(47, 8);
		const [s0, w0, n0, e0] = bboxAround(47, 8, PEAK_RADIUS_KM);
		for (const [a, b] of [
			[s, s0],
			[w, w0],
			[n, n0],
			[e, e0],
		])
			expect(a).toBeCloseTo(b, 5);
	});
});

describe("parseMetres", () => {
	it.each([
		["1234", 1234],
		["1234 m", 1234],
		["1'234", 1234],
		["1’234", 1234],
		["4,810", 4810],
		["4,810 m", 4810],
		["12,5", 12.5],
		["3000 ft", 914.4],
		["3000 feet", 914.4],
		["3000'", 914.4],
		["  2000.5 ", 2000.5],
		["-12", -12],
		["~1500", 1500],
	])("%s -> %s", (input, want) => {
		expect(parseMetres(input)).toBeCloseTo(want, 6);
	});
	it.each([
		[""],
		["n/a"],
		[undefined],
		[null],
		[1234],
		[{}],
	])("rejects %s", (v) => {
		expect(parseMetres(v)).toBeNull();
	});
});

describe("parsePeaks", () => {
	it("keeps named nodes with coordinates and parses ele / prominence", () => {
		const r = parsePeaks([
			{
				type: "node",
				id: 1,
				lat: 47,
				lon: 8,
				tags: { name: "A", ele: "2,000", prominence: "300 m" },
			},
			{ type: "node", id: 2, lat: 47, lon: 8, tags: { ele: "100" } },
			{ type: "node", id: 3, tags: { name: "NoCoords" } },
			{ type: "node", id: 4, lat: 1, lon: 2, tags: { name: "B" } },
		] as never);
		expect(r).toEqual([
			{ name: "A", lat: 47, lon: 8, ele: 2000, prominence: 300 },
			{ name: "B", lat: 1, lon: 2, ele: null, prominence: null },
		]);
	});
});

describe("parseTrails", () => {
	it("keeps ways with >= 2 points, rounds to 6 decimals as [lon, lat]", () => {
		const r = parseTrails([
			{
				type: "way",
				id: 1,
				tags: { sac_scale: "hiking", name: "T" },
				geometry: [
					{ lat: 47.12345678, lon: 8.87654321 },
					{ lat: 47.2, lon: 8.9 },
				],
			},
			{ type: "way", id: 2, geometry: [{ lat: 1, lon: 2 }] },
			{ type: "way", id: 3 },
			{
				type: "way",
				id: 4,
				geometry: [
					{ lat: 1, lon: 2 },
					{ lat: 3, lon: 4 },
				],
			},
		] as never);
		expect(r).toHaveLength(2);
		expect(r[0]).toEqual({
			sac: "hiking",
			name: "T",
			coords: [
				[8.876543, 47.123457],
				[8.9, 47.2],
			],
		});
		expect(r[1]).toEqual({
			sac: null,
			name: null,
			coords: [
				[2, 1],
				[4, 3],
			],
		});
	});
});

describe("bundledRegionIdFor", () => {
	it("is null far from every bundled region (and with none bundled)", () => {
		withFlags({});
		expect(bundledRegionIdFor(-80, 0)).toBeNull();
	});
});
