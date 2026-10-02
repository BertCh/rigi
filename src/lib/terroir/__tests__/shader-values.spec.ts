// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { EnuFrame } from "#/lib/geodesy";
import { CLASSIC } from "#/lib/style/defaults";
import { mergeStyle } from "#/lib/style/schema";
import type { ViewStyle } from "#/lib/style/types";
import { COVER_CLASSES } from "../classes";
import { isTerroirDefine, terroirTerrainFs } from "../glsl/terrain";
import {
	ADAPT_BOUNDS_M,
	ADAPT_TARGETS_M,
	adaptiveLevels,
	coverFit,
	coverTexels,
	SNOW_ALBEDO,
	SNOWLINE_BY_MONTH,
	snowlineM,
	swissMajorEvery,
	terroirBlockValues,
	terroirMajorEvery,
	terroirShader,
} from "../glsl/values";
import { makeGrid } from "../pack";
import {
	TERROIR_CONTOUR_TAIL,
	terroirAlbedoExpr,
	terroirFeatures,
	terroirNeedsCover,
	terroirOn,
	terroirSteepStmt,
	terroirWGSL,
} from "../wgsl/terrain";

const BBOX: [number, number, number, number] = [7.4, 46.5, 8.2, 47.0];
const frame = new EnuFrame(46.75, 7.8, 1500);
const grid = makeGrid(BBOX, 10, 8, new Uint8Array(80).fill(8));

const styleWith = (t: object): ViewStyle =>
	mergeStyle(CLASSIC, { terroir: t } as never);

describe("coverFit", () => {
	it("maps the pack bbox corners to (0,0)..(uMax,1) to within a few metres", () => {
		const fit = coverFit(grid, frame);
		expect(fit.texWidth).toBe(12); // 10 padded to a multiple of 4
		expect(fit.uMax).toBeCloseTo(10 / 12, 12);
		expect(fit.errM).toBeLessThan(5);
		const uv = (lat: number, lon: number) => {
			const [x, y] = frame.fromGeo(lat, lon, 1500);
			const u =
				fit.uvU[0] +
				fit.uvU[1] * x +
				fit.uvU[2] * y +
				fit.uvU[3] * x * y +
				fit.uvQ[0] * x * x +
				fit.uvQ[1] * y * y;
			const v =
				fit.uvV[0] +
				fit.uvV[1] * x +
				fit.uvV[2] * y +
				fit.uvV[3] * x * y +
				fit.uvQ[2] * x * x +
				fit.uvQ[3] * y * y;
			return [u, v];
		};
		const [u0, v0] = uv(47.0, 7.4); // north-west corner
		expect(u0).toBeCloseTo(0, 3);
		expect(v0).toBeCloseTo(0, 3);
		const [u1, v1] = uv(46.5, 8.2); // south-east corner
		expect(u1).toBeCloseTo(fit.uMax, 3);
		expect(v1).toBeCloseTo(1, 3);
	});
});

describe("coverTexels", () => {
	it("is the class array itself when already aligned, and pads rows otherwise (cached)", () => {
		const aligned = makeGrid(
			BBOX,
			8,
			2,
			Uint8Array.from({ length: 16 }, (_, i) => i),
		);
		expect(coverTexels(aligned, 8)).toBe(aligned.classes);
		const g = makeGrid(BBOX, 3, 2, Uint8Array.from([1, 2, 3, 4, 5, 6]));
		const t = coverTexels(g, 4);
		expect(Array.from(t)).toEqual([1, 2, 3, 0, 4, 5, 6, 0]);
		expect(coverTexels(g, 4)).toBe(t);
	});
});

describe("snowline", () => {
	it("is null without a valid date and follows the monthly table at mid-month", () => {
		expect(snowlineM(null)).toBeNull();
		expect(snowlineM("not a date")).toBeNull();
		expect(snowlineM("2026-08-16T12:00:00Z")).toBeGreaterThan(3000);
		expect(snowlineM("2026-01-15T12:00:00Z")).toBeCloseTo(1500, -1);
	});
	it("stays inside the table range, is highest in late summer and varies smoothly", () => {
		const lo = Math.min(...SNOWLINE_BY_MONTH);
		const hi = Math.max(...SNOWLINE_BY_MONTH);
		let prev = snowlineM("2026-01-01T00:00:00Z") ?? 0;
		let max = 0;
		for (let d = 0; d < 365; d += 2) {
			const t = new Date(Date.UTC(2026, 0, 1 + d)).toISOString();
			const s = snowlineM(t) ?? Number.NaN;
			expect(s).toBeGreaterThanOrEqual(lo - 1e-9);
			expect(s).toBeLessThanOrEqual(hi + 1e-9);
			expect(Math.abs(s - prev)).toBeLessThan(60);
			prev = s;
			max = Math.max(max, s);
		}
		expect(max).toBeGreaterThan(3150);
	});
});

describe("contour levels", () => {
	it("swissMajorEvery returns the index multiple only where 100 m is round", () => {
		expect(swissMajorEvery(10)).toBe(10);
		expect(swissMajorEvery(20)).toBe(5);
		expect(swissMajorEvery(25)).toBe(4);
		expect(swissMajorEvery(50)).toBe(2);
		expect(swissMajorEvery(100)).toBe(5);
		expect(swissMajorEvery(200)).toBe(5);
		expect(swissMajorEvery(30)).toBeNull();
		expect(swissMajorEvery(0)).toBeNull();
	});
	it("adaptiveLevels nest: each coarser level is a multiple of the finer and reaches the target", () => {
		const { minor, major } = adaptiveLevels(50, 4, false);
		expect(minor).toEqual([100, 200, 1000]);
		for (let k = 0; k < 3; k++) {
			expect(minor[k]).toBeGreaterThanOrEqual(ADAPT_TARGETS_M[k]);
			expect(major[k] % minor[k]).toBe(0);
			expect(major[k]).toBeGreaterThanOrEqual(minor[k]);
			if (k) expect(minor[k] % minor[k - 1]).toBe(0);
		}
		// a 30 m interval still nests
		const odd = adaptiveLevels(30, 5, true);
		expect(odd.minor[1] % odd.minor[0]).toBe(0);
		expect(ADAPT_BOUNDS_M).toHaveLength(3);
	});
	it("terroirMajorEvery prefers the Swiss index only when it is on and round", () => {
		const sh = terroirShader(
			styleWith({ contours: { swissIndex: true } }),
			null,
			null,
			null,
		);
		expect(terroirMajorEvery(sh, 50, 5)).toBe(2);
		expect(terroirMajorEvery(sh, 30, 5)).toBe(5);
		expect(terroirMajorEvery(null, 50, 5)).toBe(5);
	});
});

describe("terroirShader", () => {
	it("is null when no switch needs the shaders, and for the classic style", () => {
		expect(terroirShader(CLASSIC, grid, frame, null)).toBeNull();
	});
	it("cover switches need the pack's grid: without one they drop out", () => {
		const s = styleWith({
			cover: { on: true, snow: "date", pattern: true },
			contours: { inkByCover: true },
		});
		expect(terroirShader(s, null, frame, "2026-07-01T00:00:00Z")).toBeNull();
		const t = terroirShader(s, grid, frame, "2026-07-01T00:00:00Z");
		expect(t?.defines).toEqual([
			"TERROIR_CONTOUR_INK",
			"TERROIR_COVER",
			"TERROIR_PATTERN",
			"TERROIR_SNOW",
		]);
		expect(t?.grid).toBe(grid);
		expect(t?.fit).not.toBeNull();
		expect(t?.snowline).toBeGreaterThan(2000);
	});
	it("hatch and adaptive contours need no grid; the Landeskarte hatch adds its define", () => {
		const t = terroirShader(
			styleWith({
				hatch: true,
				hatchStyle: "landeskarte",
				contours: { adaptive: true },
			}),
			grid,
			frame,
			null,
		);
		expect(t?.defines).toEqual([
			"TERROIR_CONTOUR_ADAPTIVE",
			"TERROIR_HATCH",
			"TERROIR_HATCH_LK",
		]);
		expect(t?.grid).toBeNull();
		expect(t?.fit).toBeNull();
	});
	it("swiss index alone yields a shader with no defines", () => {
		const t = terroirShader(
			styleWith({ contours: { swissIndex: true } }),
			null,
			null,
			null,
		);
		expect(t).toEqual({
			defines: [],
			swissIndex: true,
			grid: null,
			fit: null,
			snowline: null,
		});
	});
	it("snow 'date' without a capture date adds no snow define", () => {
		const t = terroirShader(
			styleWith({ cover: { on: true, snow: "date" } }),
			grid,
			frame,
			null,
		);
		expect(t?.defines).toEqual(["TERROIR_COVER"]);
	});
});

describe("terroirBlockValues", () => {
	it("packs a 16-slot palette per quarter with the class colours and ink index", () => {
		const t = terroirShader(
			styleWith({ cover: { on: true, snow: "date" } }),
			grid,
			frame,
			"2026-08-01T00:00:00Z",
		);
		if (!t) throw new Error("no shader");
		const v = terroirBlockValues(t, 50, 4);
		expect(v.pal0).toHaveLength(16);
		const all = [...v.pal0, ...v.pal1, ...v.pal2, ...v.pal3];
		const glacier = COVER_CLASSES[1];
		expect(all[1 * 4 + 3]).toBe(2); // ice ink
		expect(all[3 * 4 + 3]).toBe(1); // rock ink
		expect(all[5 * 4 + 3]).toBe(0); // soil ink
		expect(glacier.key).toBe("glacier");
		expect(v.snowCol[3]).toBe(1);
		expect(v.snow[0]).toBe(t.snowline);
		expect(v.minorLv).toEqual([100, 200, 1000, 0]);
		expect(v.cover[3]).toBeCloseTo(t.fit?.uMax ?? -1, 12);
		expect(SNOW_ALBEDO.startsWith("#")).toBe(true);
	});
	it("without a fit or snowline the mapping is zeroed and the snowline is out of reach", () => {
		const t = terroirShader(styleWith({ hatch: true }), null, null, null);
		if (!t) throw new Error("no shader");
		const v = terroirBlockValues(t, 20, 5);
		expect(v.uvU).toEqual([0, 0, 0, 0]);
		expect(v.snow[0]).toBe(99999);
		expect(v.snowCol[3]).toBe(0);
		expect(v.cover[3]).toBe(0);
	});
});

describe("WGSL feature gating", () => {
	const all = terroirShader(
		styleWith({
			cover: { on: true, snow: "date", pattern: true },
			contours: { inkByCover: true, adaptive: true },
			hatch: true,
			hatchStyle: "landeskarte",
		}),
		grid,
		frame,
		"2026-07-01T00:00:00Z",
	);
	it("no shader or no defines gives no features", () => {
		expect(terroirFeatures("hillshade", null, false)).toEqual({});
		expect(terroirFeatures("hillshade", undefined, false)).toEqual({});
	});
	it("hillshade gets cover, pattern, snow and hatch, not the contour features", () => {
		expect(terroirFeatures("hillshade", all, false)).toEqual({
			terCover: true,
			terPattern: true,
			terHatch: true,
			terHatchLk: true,
			terSnow: true,
		});
	});
	it("imagery is lit but never hatched; contours get ink and adaptive unless tanaka", () => {
		const img = terroirFeatures("imagery", all, false);
		expect(img.terHatch).toBeUndefined();
		expect(img.terCover).toBe(true);
		expect(terroirFeatures("contours", all, false)).toEqual({
			terInk: true,
			terAdaptive: true,
		});
		expect(terroirFeatures("contours", all, true)).toEqual({});
		expect(terroirFeatures("hypsometric", all, false)).toEqual({});
	});
	it("terroirOn / terroirNeedsCover read the feature set", () => {
		expect(terroirOn({})).toBe(false);
		expect(terroirOn({ terAdaptive: true })).toBe(true);
		expect(terroirNeedsCover({ terAdaptive: true })).toBe(false);
		expect(terroirNeedsCover({ terSnow: true })).toBe(true);
		expect(terroirNeedsCover({ terInk: true })).toBe(true);
	});
	it("albedo and steep-face statements only appear for the features that need them", () => {
		expect(terroirAlbedoExpr({}, "base")).toBe("base");
		expect(terroirAlbedoExpr({ terSnow: true }, "base")).toBe(
			"ter_albedo(base, n, s)",
		);
		expect(terroirAlbedoExpr({ terAdaptive: true }, "base")).toBe("base");
		expect(terroirSteepStmt({}, "x")).toBe("");
		expect(terroirSteepStmt({ terCover: true }, "lit")).toContain(
			"mix(base, lit,",
		);
		expect(TERROIR_CONTOUR_TAIL).toContain("ter_contour");
	});
	it("terroirWGSL is empty when off and defines the functions for the enabled features", () => {
		expect(terroirWGSL({}, { relief: false, water: false })).toBe("");
		const wgsl = terroirWGSL(
			{ terCover: true, terSnow: true, terHatch: true },
			{ relief: false, water: false },
		);
		expect(wgsl).toContain("fn ter_hash");
		expect(wgsl).toContain("fn ter_steep");
		const lk = terroirWGSL(
			{ terHatch: true, terHatchLk: true, terAdaptive: true },
			{ relief: true, water: true },
		);
		expect(lk.length).toBeGreaterThan(0);
	});
});

describe("terroirTerrainFs", () => {
	it("passes the source through when no terroir define is requested", () => {
		expect(terroirTerrainFs("deck", "void main() {}", [])).toBe(
			"void main() {}",
		);
		expect(terroirTerrainFs("deck", "src", ["LOOK_RELIEF"])).toBe("src");
		expect(isTerroirDefine("TERROIR_SNOW")).toBe(true);
		expect(isTerroirDefine("LOOK_SNOW")).toBe(false);
	});
	it("throws when the terrain shader no longer has the anchor", () => {
		expect(() =>
			terroirTerrainFs("deck", "void main() {}", ["TERROIR_COVER"]),
		).toThrow(/anchor missing/);
		expect(() =>
			terroirTerrainFs("three", "void main() {}", ["TERROIR_HATCH"]),
		).toThrow(/terroir: three/);
	});
});
