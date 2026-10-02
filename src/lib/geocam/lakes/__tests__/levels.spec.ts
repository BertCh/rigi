// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import {
	lakeLevelOf,
	normName,
	parseEle,
	SWISS_LAKE_LEVELS,
	tableLevel,
} from "../levels";

describe("parseEle", () => {
	it("parses plain numbers, units and decimals", () => {
		expect(parseEle(558)).toBe(558);
		expect(parseEle("558")).toBe(558);
		expect(parseEle("558 m")).toBe(558);
		expect(parseEle("557.8")).toBeCloseTo(557.8, 12);
		expect(parseEle("557,8")).toBeCloseTo(557.8, 12);
		expect(parseEle(" -12 ")).toBe(-12);
	});
	it("treats apostrophes and a comma before exactly three digits as thousands separators", () => {
		expect(parseEle("1'234")).toBe(1234);
		expect(parseEle("1’234")).toBe(1234);
		expect(parseEle("4,810")).toBe(4810);
	});
	it("converts feet", () => {
		expect(parseEle("3000 ft")).toBeCloseTo(914.4, 6);
		expect(parseEle("100 feet")).toBeCloseTo(30.48, 6);
		expect(parseEle("1000'")).toBeCloseTo(304.8, 6);
	});
	it("returns null for unusable input", () => {
		expect(parseEle("")).toBeNull();
		expect(parseEle("high")).toBeNull();
		expect(parseEle(Number.NaN)).toBeNull();
		expect(parseEle(Number.POSITIVE_INFINITY)).toBeNull();
		expect(parseEle(undefined)).toBeNull();
		expect(parseEle(null)).toBeNull();
		expect(parseEle({})).toBeNull();
	});
});

describe("normName / tableLevel", () => {
	it("strips diacritics, case and extra whitespace", () => {
		expect(normName("  Vierwaldstättersee ")).toBe("vierwaldstattersee");
		expect(normName("Lac   de\tNeuchâtel")).toBe("lac de neuchatel");
	});
	it("finds a lake by any of its names", () => {
		expect(tableLevel("Thunersee")?.levelM).toBe(557.8);
		expect(tableLevel("Lac de Thoune")?.levelM).toBe(557.8);
		expect(tableLevel("Vierwaldstättersee")?.levelM).toBeCloseTo(433.6, 6);
	});
	it("splits bilingual names on / and ;", () => {
		expect(tableLevel("Bielersee / Lac de Bienne")?.levelM).toBe(429.1);
		expect(tableLevel("Foo;Zürichsee")?.levelM).toBe(405.9);
	});
	it("does not substring-match and returns null for unknown or missing names", () => {
		expect(tableLevel("Thun")).toBeNull();
		expect(tableLevel("Lac Inconnu")).toBeNull();
		expect(tableLevel(undefined)).toBeNull();
		expect(tableLevel("")).toBeNull();
	});
	it("has no name claimed by two rows and every name already normalised", () => {
		const seen = new Map<string, number>();
		for (const row of SWISS_LAKE_LEVELS)
			for (const n of row.names) {
				expect(normName(n)).toBe(n);
				expect(seen.has(n)).toBe(false);
				seen.set(n, row.levelM);
			}
	});
});

describe("lakeLevelOf priority", () => {
	it("prefers OSM ele, then the table, then the DEM", () => {
		expect(lakeLevelOf({ ele: 600, name: "Thunersee" }, 500)).toEqual({
			levelM: 600,
			source: "osm",
		});
		expect(lakeLevelOf({ ele: null, name: "Thunersee" }, 500)).toEqual({
			levelM: 557.8,
			source: "table",
		});
		expect(lakeLevelOf({ ele: null, name: "Nameless" }, 500)).toEqual({
			levelM: 500,
			source: "dem",
		});
	});
	it("only evaluates the DEM thunk when needed", () => {
		let calls = 0;
		const dem = () => {
			calls++;
			return 321;
		};
		lakeLevelOf({ ele: 10, name: undefined }, dem);
		lakeLevelOf({ ele: null, name: "Zugersee" }, dem);
		expect(calls).toBe(0);
		expect(lakeLevelOf({ ele: null, name: undefined }, dem)).toEqual({
			levelM: 321,
			source: "dem",
		});
		expect(calls).toBe(1);
	});
	it("returns null when nothing is finite", () => {
		expect(lakeLevelOf({ ele: null, name: undefined })).toBeNull();
		expect(lakeLevelOf({ ele: null, name: undefined }, Number.NaN)).toBeNull();
		expect(lakeLevelOf({ ele: null, name: undefined }, () => null)).toBeNull();
	});
	it("ignores a non-finite OSM ele", () => {
		expect(lakeLevelOf({ ele: Number.NaN, name: "Zugersee" })?.source).toBe(
			"table",
		);
	});
});
