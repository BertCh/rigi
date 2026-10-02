// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { parseOsmMetres } from "../metres";

describe("parseOsmMetres", () => {
	it.each([
		["1234", 1234],
		["1234 m", 1234],
		["~1500", 1500],
		["ca. 2000", 2000],
		["1234,5", 1234.5],
		["4,810", 4810],
		["1'234", 1234],
		["1’234", 1234],
		["3000 ft", 914.4],
		["3000 Feet", 914.4],
		["3000'", 914.4],
		["1'000'", 304.8],
		["-12", -12],
	])("%s -> %s", (input, want) => {
		expect(parseOsmMetres(input)).toBeCloseTo(want, 6);
	});
	it("does not read European dot or space thousands (OSM ele is metres with a dot decimal)", () => {
		expect(parseOsmMetres("1.234")).toBeCloseTo(1.234, 9);
		expect(parseOsmMetres("2 345")).toBe(2);
	});
	it.each([
		[""],
		["n/a"],
		[undefined],
		[null],
		[1234],
		[{}],
	])("rejects %s", (v) => {
		expect(parseOsmMetres(v)).toBeUndefined();
	});
});
