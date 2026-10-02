// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import {
	attributionFor,
	attributionLine,
	GOOGLE_3D_TILES_CREDIT,
	groupCredits,
	SWISSTOPO_3D_TILES_CREDIT,
	tiles3dCredits,
} from "../attribution";
import { creditParts } from "../MapAttribution";

const NIEDERHORN = { lat: 46.78, lon: 7.8 };

describe("3D tiles credits", () => {
	it("maps each ?tiles3d value to its providers", () => {
		expect(tiles3dCredits(undefined)).toEqual([]);
		expect(tiles3dCredits("off")).toEqual([]);
		expect(tiles3dCredits("buildings")).toEqual([SWISSTOPO_3D_TILES_CREDIT]);
		expect(tiles3dCredits("swisstopo")).toEqual([SWISSTOPO_3D_TILES_CREDIT]);
		expect(tiles3dCredits("google")).toEqual([GOOGLE_3D_TILES_CREDIT]);
		expect(tiles3dCredits("all")).toEqual([
			SWISSTOPO_3D_TILES_CREDIT,
			GOOGLE_3D_TILES_CREDIT,
		]);
	});

	it("leaves the credits unchanged when no tiles are drawn", () => {
		const q = { ...NIEDERHORN, imagery: "satellite" as const };
		expect(attributionFor({ ...q, tiles3d: "off" })).toEqual(attributionFor(q));
		expect(attributionLine({ ...q, tiles3d: "off" })).toBe(attributionLine(q));
	});

	it("appends the providers last, in the line too", () => {
		const cs = attributionFor({ ...NIEDERHORN, tiles3d: "all" });
		expect(cs.slice(-2).map((c) => c.id)).toEqual([
			"swisstopo-3d-tiles",
			"google-3d-tiles",
		]);
		expect(attributionLine({ ...NIEDERHORN, tiles3d: "google" })).toMatch(
			/ · 3D © Google$/,
		);
	});
});

describe("groupCredits", () => {
	it("splits a view's credits into the display groups", () => {
		const g = groupCredits(
			attributionFor({ ...NIEDERHORN, imagery: "topo", tiles3d: "google" }),
		);
		expect(g.dem[0].id).toBe("mapterhorn");
		expect(g.dem.map((c) => c.id)).toContain("swissalti3d");
		expect(g.imagery.map((c) => c.id)).toEqual(["swisstopo"]);
		expect(g.imageryNoun).toBe("Map");
		expect(g.osm?.id).toBe("osm");
		expect(g.tiles3d).toEqual([GOOGLE_3D_TILES_CREDIT]);
	});

	it("says Imagery for a satellite drape and has no OSM when off", () => {
		const g = groupCredits(
			attributionFor({ ...NIEDERHORN, imagery: "satellite", osm: false }),
		);
		expect(g.imageryNoun).toBe("Imagery");
		expect(g.osm).toBeNull();
	});
});

describe("creditParts (MapAttribution)", () => {
	const cs = attributionFor({ ...NIEDERHORN, imagery: "satellite" });
	it("names only Mapterhorn for the terrain in classic mode", () => {
		const parts = creditParts(cs, { full: false });
		expect(parts[0]).toEqual({
			prefix: "Terrain ©",
			credits: [cs[0]],
		});
		expect(parts.map((p) => p.prefix)).toEqual(["Terrain ©", "Imagery ©", "©"]);
	});
	it("lists the DEM producers in full mode", () => {
		const parts = creditParts(cs, { full: true });
		expect(parts[0].credits.length).toBeGreaterThan(1);
		expect(parts[0].credits.map((c) => c.id)).toContain("swissalti3d");
	});
	it("adds a 3D part when tiles are drawn", () => {
		const parts = creditParts(
			attributionFor({ ...NIEDERHORN, osm: false, tiles3d: "swisstopo" }),
			{ full: false },
		);
		expect(parts.at(-1)).toEqual({
			prefix: "3D ©",
			credits: [SWISSTOPO_3D_TILES_CREDIT],
		});
	});
});
