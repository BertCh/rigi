// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import {
	basemapLook,
	basemapSource,
	ROLL_BASEMAPS,
	type RollBasemap,
} from "../basemap";

describe("roll basemaps", () => {
	it("lists each preset once, with a label", () => {
		const values = ROLL_BASEMAPS.map((b) => b.value);
		expect(new Set(values).size).toBe(values.length);
		expect(values.sort()).toEqual([
			"dark",
			"muted",
			"relief",
			"satellite",
			"topo",
		]);
		for (const b of ROLL_BASEMAPS) expect(b.label.length).toBeGreaterThan(0);
	});

	it("fetches satellite tiles for the satellite-based looks, topo tiles for topo, none for relief", () => {
		expect(basemapSource("satellite")).toBe("satellite");
		expect(basemapSource("muted")).toBe("satellite");
		expect(basemapSource("dark")).toBe("satellite");
		expect(basemapSource("topo")).toBe("topo");
		expect(basemapSource("relief")).toBeNull();
	});

	it("shades the DEM alone for relief and drapes imagery otherwise", () => {
		expect(basemapLook("relief").style).toBe("hillshade");
		for (const b of ["satellite", "muted", "dark", "topo"] as RollBasemap[])
			expect(basemapLook(b).style).toBe("imagery");
	});

	it("leaves satellite and topo on the plain look", () => {
		expect(basemapLook("satellite").look).toEqual(basemapLook("topo").look);
		expect(basemapLook("relief").look).toEqual(basemapLook("satellite").look);
	});

	it("muted desaturates and dims the imagery, dark more so with a cool tint", () => {
		const plain = basemapLook("satellite").look;
		const muted = basemapLook("muted").look;
		const dark = basemapLook("dark").look;
		expect(muted).not.toEqual(plain);
		expect(muted.imgOn).toBe(1);
		expect(muted.imgAdj[0]).toBeCloseTo(0.3);
		expect(muted.imgAdj[1]).toBeCloseTo(0.85);
		expect(dark.imgAdj[0]).toBe(0);
		expect(dark.imgAdj[1]).toBeLessThan(muted.imgAdj[1]);
		expect(muted.imgTint[3]).toBe(0);
		expect(dark.imgTint[3]).toBeCloseTo(0.25);
		// the tint is a colour in 0..1, bluish for the dark look
		const [r, , b] = dark.imgTint;
		expect(b).toBeGreaterThan(r);
	});
});
