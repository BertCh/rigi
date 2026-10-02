// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it, vi } from "vitest";
import { withFlags } from "#/test/helpers";
import {
	attributionFor,
	attributionLine,
	CLASSIC_UI_LINE,
	ESRI_CREDIT,
	fullAttribution,
	MAPTERHORN_CREDIT,
	MAPTERHORN_SOURCES,
	OSM_CREDIT,
	SWISSTOPO_CREDIT,
} from "../attribution";
import { attributionMode, osmExtractEnabled, readSetting } from "../config";
import {
	customAttribution,
	customTemplate,
	esriUrl,
	imageryProvider,
	imageryTileUrls,
	inSwissBBox,
	osmTileUrl,
	pixelkarteUrl,
	swissimageUrl,
} from "../imagery";

const NIEDERHORN = { lat: 46.78, lon: 7.8 };
const UTAH = { lat: 40.58, lon: -111.65 };

describe("readSetting", () => {
	it("is undefined when nothing is set", () => {
		expect(readSetting("imagery", "IMAGERY_PROVIDER")).toBeUndefined();
		expect(readSetting(null, "NOPE")).toBeUndefined();
	});
	it("prefers a set flag over env", () => {
		vi.stubEnv("IMAGERY_PROVIDER", "swisstopo");
		withFlags({ imagery: "esri" });
		expect(readSetting("imagery", "IMAGERY_PROVIDER")).toBe("esri");
	});
	it("uses the flag's validated value (bad value = default)", () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		withFlags({ imagery: "bogus" });
		expect(readSetting("imagery", "IMAGERY_PROVIDER")).toBe("default");
	});
	it("falls back to the bare Node env name (VITE_<name> is read from import.meta.env at build time)", () => {
		vi.stubEnv("FOO_X", "node");
		expect(readSetting(null, "FOO_X")).toBe("node");
		vi.stubEnv("FOO_X", "");
		expect(readSetting(null, "FOO_X")).toBeUndefined();
	});
	it("treats empty strings as unset", () => {
		vi.stubEnv("BAR_X", "");
		vi.stubEnv("BAR_X", "");
		expect(readSetting(null, "BAR_X")).toBeUndefined();
	});
});

describe("attributionMode / osmExtractEnabled", () => {
	it("defaults to classic and only the exact value full switches", () => {
		expect(attributionMode()).toBe("classic");
		expect(fullAttribution()).toBe(false);
		vi.stubEnv("ATTRIBUTION", "FULL");
		expect(attributionMode()).toBe("classic");
		vi.stubEnv("ATTRIBUTION", "full");
		expect(attributionMode()).toBe("full");
		expect(fullAttribution()).toBe(true);
	});
	it("the ?attrib flag wins", () => {
		vi.stubEnv("ATTRIBUTION", "full");
		withFlags({ attrib: "classic" });
		expect(attributionMode()).toBe("classic");
	});
	it("osmExtractEnabled accepts 1/true/on only", () => {
		expect(osmExtractEnabled()).toBe(false);
		for (const [v, want] of [
			["1", true],
			["true", true],
			["on", true],
			["off", false],
			["0", false],
			["yes", false],
		] as const) {
			vi.stubEnv("OSM_EXTRACT", v);
			expect(osmExtractEnabled()).toBe(want);
		}
	});
	it("?osmextract=on enables it", () => {
		withFlags({ osmextract: "on" });
		expect(osmExtractEnabled()).toBe(true);
	});
});

describe("inSwissBBox", () => {
	it("is true inside the box and false on or outside its edges", () => {
		expect(inSwissBBox(46.9, 8.2)).toBe(true);
		expect(inSwissBBox(45.8, 8.2)).toBe(false); // edge is exclusive
		expect(inSwissBBox(46.9, 5.9)).toBe(false);
		expect(inSwissBBox(48.5, 8.2)).toBe(false);
		expect(inSwissBBox(UTAH.lat, UTAH.lon)).toBe(false);
	});
});

describe("tile URLs", () => {
	it("builds the documented URL shapes", () => {
		expect(esriUrl(5, 3, 4)).toBe(
			"https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/5/4/3",
		);
		expect(swissimageUrl(5, 3, 4)).toContain("/3857/5/3/4.jpeg");
		expect(pixelkarteUrl(5, 3, 4)).toContain("pixelkarte-farbe");
		expect(osmTileUrl(5, 3, 4)).toBe(
			"https://tile.openstreetmap.org/5/3/4.png",
		);
	});
});

describe("imageryProvider", () => {
	it("defaults, accepts known ids and rejects unknown", () => {
		expect(imageryProvider()).toBe("default");
		vi.stubEnv("IMAGERY_PROVIDER", "esri");
		expect(imageryProvider()).toBe("esri");
		vi.stubEnv("IMAGERY_PROVIDER", "mapbox");
		expect(imageryProvider()).toBe("default");
	});
	it("custom without a URL falls back to default", () => {
		vi.stubEnv("IMAGERY_PROVIDER", "custom");
		expect(imageryProvider()).toBe("default");
		vi.stubEnv("IMAGERY_URL", "https://tiles.test/{z}/{x}/{y}.png");
		expect(imageryProvider()).toBe("custom");
	});
	it("reads the ?imagery flag", () => {
		withFlags({ imagery: "swisstopo" });
		expect(imageryProvider()).toBe("swisstopo");
	});
});

describe("imageryTileUrls", () => {
	const urls = (
		kind: "satellite" | "topo",
		where: { lat: number; lon: number },
		z = 10,
		provider?: never,
	) => imageryTileUrls(kind, z, 1, 2, where.lat, where.lon, provider);
	it("default satellite: SWISSIMAGE then Esri in CH at z >= 8, Esri alone below z 8 or abroad", () => {
		expect(urls("satellite", NIEDERHORN)).toEqual([
			swissimageUrl(10, 1, 2),
			esriUrl(10, 1, 2),
		]);
		expect(urls("satellite", NIEDERHORN, 7)).toEqual([esriUrl(7, 1, 2)]);
		expect(urls("satellite", UTAH)).toEqual([esriUrl(10, 1, 2)]);
	});
	it("topo: Pixelkarte then OSM in CH, OSM abroad, whatever the provider", () => {
		expect(urls("topo", NIEDERHORN)).toEqual([
			pixelkarteUrl(10, 1, 2),
			osmTileUrl(10, 1, 2),
		]);
		expect(urls("topo", UTAH)).toEqual([osmTileUrl(10, 1, 2)]);
		expect(
			imageryTileUrls("topo", 10, 1, 2, UTAH.lat, UTAH.lon, "swisstopo"),
		).toEqual([osmTileUrl(10, 1, 2)]);
	});
	it("esri provider: Esri everywhere", () => {
		expect(
			imageryTileUrls(
				"satellite",
				10,
				1,
				2,
				NIEDERHORN.lat,
				NIEDERHORN.lon,
				"esri",
			),
		).toEqual([esriUrl(10, 1, 2)]);
	});
	it("swisstopo provider: no Esri pixels anywhere, nothing outside CH", () => {
		expect(
			imageryTileUrls(
				"satellite",
				10,
				1,
				2,
				NIEDERHORN.lat,
				NIEDERHORN.lon,
				"swisstopo",
			),
		).toEqual([swissimageUrl(10, 1, 2)]);
		expect(
			imageryTileUrls(
				"satellite",
				3,
				1,
				2,
				NIEDERHORN.lat,
				NIEDERHORN.lon,
				"swisstopo",
			),
		).toEqual([swissimageUrl(3, 1, 2)]);
		expect(
			imageryTileUrls("satellite", 10, 1, 2, UTAH.lat, UTAH.lon, "swisstopo"),
		).toEqual([]);
	});
	it("custom provider fills {z}/{x}/{y} and flips {-y} for TMS", () => {
		vi.stubEnv("IMAGERY_URL", "https://t.test/{z}/{x}/{y}.png");
		expect(imageryTileUrls("satellite", 3, 5, 2, 0, 0, "custom")).toEqual([
			"https://t.test/3/5/2.png",
		]);
		vi.stubEnv("IMAGERY_URL", "https://t.test/{z}/{x}/{-y}.png");
		expect(imageryTileUrls("satellite", 3, 5, 2, 0, 0, "custom")).toEqual([
			"https://t.test/3/5/5.png",
		]);
	});
	it("custom without a template yields nothing", () => {
		expect(imageryTileUrls("satellite", 3, 5, 2, 0, 0, "custom")).toEqual([]);
	});
	it("resolves the provider from settings by default", () => {
		vi.stubEnv("IMAGERY_PROVIDER", "esri");
		expect(
			imageryTileUrls("satellite", 10, 1, 2, NIEDERHORN.lat, NIEDERHORN.lon),
		).toEqual([esriUrl(10, 1, 2)]);
	});
});

describe("customTemplate / customAttribution", () => {
	it("read their env names", () => {
		expect(customTemplate()).toBeUndefined();
		expect(customAttribution()).toMatch(/set VITE_IMAGERY_ATTRIBUTION/);
		vi.stubEnv("IMAGERY_ATTRIBUTION", "© Acme Maps");
		expect(customAttribution()).toBe("© Acme Maps");
	});
});

describe("MAPTERHORN_SOURCES", () => {
	it("has unique ids and well-formed bboxes", () => {
		const ids = MAPTERHORN_SOURCES.map((s) => s.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const s of MAPTERHORN_SOURCES) {
			expect(s.kind).toBe("dem");
			expect(s.href).toMatch(/^https:/);
			expect(s.licence).toBeTruthy();
			if (s.bbox) {
				const [w, so, e, n] = s.bbox;
				expect(w).toBeLessThan(e);
				expect(so).toBeLessThan(n);
				expect(Math.abs(so)).toBeLessThanOrEqual(90);
				expect(Math.abs(w)).toBeLessThanOrEqual(180);
			}
		}
	});
	it("the global source has no bbox", () => {
		expect(MAPTERHORN_SOURCES.find((s) => s.id === "glo30")?.bbox).toBeNull();
	});
});

describe("attributionFor", () => {
	const ids = (q: Parameters<typeof attributionFor>[0]) =>
		attributionFor(q).map((c) => c.id);
	it("always starts with Mapterhorn and the global DEM", () => {
		const r = ids({ ...UTAH, imagery: "none" });
		expect(r.slice(0, 2)).toEqual(["mapterhorn", "glo30"]);
	});
	it("adds only the regional DEM sources whose bbox intersects the view", () => {
		const r = ids({ ...NIEDERHORN, imagery: "none" });
		expect(r).toContain("swissalti3d");
		expect(r).not.toContain("itbozen");
		expect(ids({ ...UTAH, imagery: "none" })).not.toContain("swissalti3d");
	});
	it("a larger radius reaches more sources", () => {
		const near = ids({ ...NIEDERHORN, imagery: "none", radiusKm: 5 });
		const far = ids({ ...NIEDERHORN, imagery: "none", radiusKm: 400 });
		expect(far.length).toBeGreaterThan(near.length);
	});
	it("does not leak the bbox field into credits", () => {
		for (const c of attributionFor({ ...NIEDERHORN, imagery: "none" }))
			expect("bbox" in c).toBe(false);
	});
	it("default satellite in CH credits swisstopo and Esri", () => {
		const r = ids({ ...NIEDERHORN, imagery: "satellite", provider: "default" });
		expect(r).toContain("swisstopo");
		expect(r).toContain("esri");
	});
	it("default satellite abroad credits only Esri", () => {
		const r = ids({ ...UTAH, imagery: "satellite", provider: "default" });
		expect(r).toContain("esri");
		expect(r).not.toContain("swisstopo");
	});
	it("swisstopo provider never credits Esri; esri provider never credits swisstopo", () => {
		expect(
			ids({ ...NIEDERHORN, imagery: "satellite", provider: "swisstopo" }),
		).not.toContain("esri");
		expect(
			ids({ ...NIEDERHORN, imagery: "satellite", provider: "esri" }),
		).not.toContain("swisstopo");
	});
	it("custom provider uses the configured attribution", () => {
		vi.stubEnv("IMAGERY_ATTRIBUTION", "© Acme");
		const c = attributionFor({
			...UTAH,
			imagery: "satellite",
			provider: "custom",
		}).find((x) => x.id === "custom");
		expect(c?.label).toBe("© Acme");
		expect(c?.kind).toBe("imagery");
	});
	it("topo credits the map as kind map, with OSM, and no duplicate OSM", () => {
		const cs = attributionFor({ ...NIEDERHORN, imagery: "topo" });
		expect(cs.filter((c) => c.id === "osm")).toHaveLength(1);
		expect(cs.find((c) => c.id === "osm")?.kind).toBe("map");
		expect(cs.find((c) => c.id === "swisstopo")?.kind).toBe("map");
	});
	it("adds OSM for labels unless osm is false", () => {
		expect(ids({ ...UTAH, imagery: "none" })).toContain("osm");
		expect(ids({ ...UTAH, imagery: "none", osm: false })).not.toContain("osm");
	});
	it("reads the provider from settings when omitted", () => {
		vi.stubEnv("IMAGERY_PROVIDER", "swisstopo");
		expect(ids({ ...NIEDERHORN, imagery: "satellite" })).not.toContain("esri");
	});
});

describe("attributionLine", () => {
	it("composes terrain, imagery and OSM parts with ·", () => {
		const l = attributionLine({
			...UTAH,
			imagery: "satellite",
			provider: "default",
		});
		expect(l.startsWith("Terrain © Mapterhorn")).toBe(true);
		expect(l).toContain(`Imagery © ${ESRI_CREDIT.label}`);
		expect(l.endsWith("© OpenStreetMap contributors")).toBe(true);
		expect(l.split(" · ")).toHaveLength(3);
	});
	it("lists regional DEM sources in parentheses, but not the global one's duplicate Mapterhorn", () => {
		const l = attributionLine({ ...NIEDERHORN, imagery: "none" });
		expect(l).toMatch(/^Terrain © Mapterhorn \(.*swisstopo swissALTI3D.*\)/);
	});
	it("compact mode uses producer abbreviations", () => {
		const l = attributionLine(
			{ ...NIEDERHORN, imagery: "none" },
			{ compact: true },
		);
		expect(l).toContain("Copernicus");
		expect(l).not.toContain("Copernicus GLO-30");
	});
	it("says Map instead of Imagery for topo", () => {
		const l = attributionLine({ ...NIEDERHORN, imagery: "topo" });
		expect(l).toContain("Map © swisstopo");
		expect(l).not.toContain("Imagery ©");
	});
	it("omits the imagery part with no imagery and OSM when disabled", () => {
		const l = attributionLine({ ...UTAH, imagery: "none", osm: false });
		expect(l).not.toContain("Imagery");
		expect(l).not.toContain("OpenStreetMap");
	});
	it("never repeats a source label", () => {
		const l = attributionLine({
			...NIEDERHORN,
			imagery: "satellite",
			provider: "default",
		});
		expect(l.match(/swisstopo/g)?.length).toBeGreaterThanOrEqual(1);
		expect(l.split("Esri, Maxar").length).toBe(2);
	});
});

describe("fixed credits", () => {
	it("are well-formed", () => {
		for (const c of [
			MAPTERHORN_CREDIT,
			OSM_CREDIT,
			SWISSTOPO_CREDIT,
			ESRI_CREDIT,
		]) {
			expect(c.id && c.label && c.href && c.licence).toBeTruthy();
		}
		expect(CLASSIC_UI_LINE).toContain("Mapterhorn");
		expect(CLASSIC_UI_LINE).toContain("OpenStreetMap");
	});
});
