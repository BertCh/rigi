// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import type { Matrix4 } from "@math.gl/core";
import { describe, expect, it, vi } from "vitest";
import { withFlags } from "#/test/helpers";
import { EnuFrame, toEcef } from "../../geodesy";
import {
	googleTilesKey,
	parseTiles3DSources,
	TILES3D_FADE_START,
	TILES3D_RADIUS,
	TILES3D_SOURCES,
	tiles3dConfig,
} from "../config";
import { enuFromEcef } from "../frame";
import { geoidUndulation } from "../geoid";

/** `m` applied to a point, as {x, y, z}. */
function apply(m: Matrix4, v: number[]) {
	const o = m.transformAsPoint(v) as number[];
	return { x: o[0], y: o[1], z: o[2] };
}

describe("geoidUndulation (EGM2008)", () => {
	// reference values from PROJ us_nga_egm08_25
	it.each([
		["Niederhorn", 46.71, 7.77, 50.543],
		["Zermatt", 46.02, 7.75, 54.684],
		["Rigi", 47.056, 8.485, 48.401],
	])("matches PROJ in the Alps grid at %s", (_n, lat, lon, expected) => {
		expect(Math.abs(geoidUndulation(lat, lon) - expected)).toBeLessThan(0.2);
	});
	it("is continuous across a grid cell (bilinear, not stepped)", () => {
		const a = geoidUndulation(46.7, 7.7);
		const b = geoidUndulation(46.7, 7.7001);
		expect(Math.abs(a - b)).toBeLessThan(0.01);
		const mid = geoidUndulation(46.75, 7.75);
		const corners = [
			geoidUndulation(46.7, 7.7),
			geoidUndulation(46.8, 7.7),
			geoidUndulation(46.7, 7.8),
			geoidUndulation(46.8, 7.8),
		];
		expect(mid).toBeGreaterThanOrEqual(Math.min(...corners) - 0.2);
		expect(mid).toBeLessThanOrEqual(Math.max(...corners) + 0.2);
	});
	it("falls back to the global grid outside the Alps", () => {
		const utah = geoidUndulation(40.599, -111.607);
		expect(utah).toBeLessThan(-10);
		expect(utah).toBeGreaterThan(-25);
		expect(geoidUndulation(28.3, -16.6)).toBeGreaterThan(40); // Tenerife
	});
	it("wraps longitude across the antimeridian and clamps the poles", () => {
		expect(
			Math.abs(geoidUndulation(10, 179.9) - geoidUndulation(10, -180.1)),
		).toBeLessThan(0.5);
		expect(Number.isFinite(geoidUndulation(90, 0))).toBe(true);
		expect(Number.isFinite(geoidUndulation(-90, 45))).toBe(true);
	});
});

describe("enuFromEcef", () => {
	const lat = 46.7197;
	const lon = 7.7014;
	it.each([
		0, 50.4,
	])("maps the origin at ellipsoid height h to (0, 0, h - N), N=%f", (n) => {
		const p = apply(enuFromEcef(lat, lon, n), toEcef(lat, lon, 800));
		expect(p.x).toBeCloseTo(0, 5);
		expect(p.y).toBeCloseTo(0, 5);
		expect(p.z).toBeCloseTo(800 - n, 5);
	});
	it("agrees with geodesy EnuFrame within 0.2 m over 1.3 km", () => {
		const m = enuFromEcef(lat, lon, 0);
		const q = new EnuFrame(lat, lon, 0).fromGeo(lat + 0.009, lon + 0.013, 900);
		const qe = apply(m, toEcef(lat + 0.009, lon + 0.013, 900));
		expect(Math.hypot(q[0] - qe.x, q[1] - qe.y, q[2] - qe.z)).toBeLessThan(0.2);
	});
	it("is a rigid transform: preserves distances", () => {
		const m = enuFromEcef(lat, lon, 12);
		const a = toEcef(lat, lon, 0);
		const b = toEcef(lat + 0.01, lon, 300);
		const d0 = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
		const pa = apply(m, a);
		const pb = apply(m, b);
		expect(Math.hypot(pa.x - pb.x, pa.y - pb.y, pa.z - pb.z)).toBeCloseTo(
			d0,
			4,
		);
	});
	it("points east / north / up on the axes", () => {
		const m = enuFromEcef(lat, lon, 0);
		const east = apply(m, toEcef(lat, lon + 0.001, 0));
		const north = apply(m, toEcef(lat + 0.001, lon, 0));
		const up = apply(m, toEcef(lat, lon, 100));
		expect(east.x).toBeGreaterThan(50);
		expect(Math.abs(east.y)).toBeLessThan(0.1);
		expect(north.y).toBeGreaterThan(100);
		expect(Math.abs(north.x)).toBeLessThan(0.1);
		expect(up.z).toBeCloseTo(100, 4);
	});
});

describe("tiles3d sources and flag parsing", () => {
	it("parses each flag value; unknown, null and 'off' give none", () => {
		expect(parseTiles3DSources(null)).toEqual([]);
		expect(parseTiles3DSources("off")).toEqual([]);
		expect(parseTiles3DSources("bogus")).toEqual([]);
		expect(parseTiles3DSources("buildings")).toEqual(["swisstopo-buildings"]);
		expect(parseTiles3DSources("swisstopo")).toEqual([
			"swisstopo-buildings",
			"swisstopo-vegetation",
		]);
		expect(parseTiles3DSources(" Google ")).toEqual(["google"]);
		expect(parseTiles3DSources("ALL")).toHaveLength(3);
	});
	it("only Google is display-only and ellipsoidal", () => {
		const s = Object.values(TILES3D_SOURCES);
		expect(s.filter((x) => x.displayOnly).map((x) => x.id)).toEqual(["google"]);
		expect(
			s.filter((x) => x.heights === "ellipsoidal").map((x) => x.id),
		).toEqual(["google"]);
		for (const x of s) {
			expect(TILES3D_SOURCES[x.id]).toBe(x);
			expect(x.depthBias).toBeGreaterThan(0.9);
			expect(x.depthBias).toBeLessThan(1);
			expect(x.fallbackColor.every((c) => c >= 0 && c <= 1)).toBe(true);
		}
	});
	it("fade starts inside the radius", () => {
		expect(TILES3D_FADE_START).toBeLessThan(TILES3D_RADIUS);
	});
});

describe("tiles3dConfig", () => {
	it("is null by default", () => {
		expect(tiles3dConfig()).toBeNull();
	});
	it("builds the config for swisstopo with the chosen blend", () => {
		withFlags({ tiles3d: "swisstopo", tiles3dBlend: "over" });
		expect(tiles3dConfig()).toEqual({
			sources: ["swisstopo-buildings", "swisstopo-vegetation"],
			blend: "over",
			radius: TILES3D_RADIUS,
			fadeStart: TILES3D_FADE_START,
		});
	});
	// import.meta.env is inlined from .env.local by Vite, so the key cannot be stubbed here: assert the
	// rule against whichever state this machine is in.
	it("keeps Google only when a key is configured", () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		withFlags({ tiles3d: "all" });
		const sources = tiles3dConfig()?.sources;
		if (googleTilesKey()) expect(sources).toContain("google");
		else
			expect(sources).toEqual(["swisstopo-buildings", "swisstopo-vegetation"]);
		withFlags({ tiles3d: "google" });
		expect(tiles3dConfig() === null).toBe(!googleTilesKey());
	});
});
