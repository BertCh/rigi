// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { defaultSettings, type Settings } from "#/lib/settings";
import { compositeFor, terrainLookFor } from "../settings-map";

const settings = (over: Partial<Settings>): Settings => ({
	...defaultSettings,
	...over,
});

describe("terrainLookFor", () => {
	it("overlay: contours by default, with contour opacity 1 and near fade", () => {
		const l = terrainLookFor(settings({ mode: "overlay" }));
		expect(l).toMatchObject({
			style: "contours",
			imagery: null,
			mode: "overlay",
			contourOpacity: 1,
			nearFade: defaultSettings.nearFade,
		});
	});
	it("overlay style none still renders at alpha 0", () => {
		const l = terrainLookFor(settings({ overlayStyle: "none" }));
		expect(l.style).toBe("contours");
		expect(l.contourOpacity).toBe(0);
	});
	it("overlay bands and slope map to elevation and slopeClass", () => {
		expect(terrainLookFor(settings({ overlayStyle: "bands" })).style).toBe(
			"elevation",
		);
		expect(terrainLookFor(settings({ overlayStyle: "slope" })).style).toBe(
			"slopeClass",
		);
	});
	it("replace: satellite and topo are imagery, bands is elevation, else hillshade", () => {
		const r = (mapStyle: Settings["mapStyle"]) =>
			terrainLookFor(settings({ mode: "replace", mapStyle }));
		expect(r("satellite")).toMatchObject({
			style: "imagery",
			imagery: "satellite",
			mode: "replace",
		});
		expect(r("topo")).toMatchObject({ style: "imagery", imagery: "topo" });
		expect(r("bands")).toMatchObject({ style: "elevation", imagery: null });
		expect(r("plain" as Settings["mapStyle"])).toMatchObject({
			style: "hillshade",
			imagery: null,
		});
		expect(r("satellite").nearFade).toBe(0);
	});
	it("world mode keeps the overlay photo view", () => {
		expect(
			terrainLookFor(settings({ mode: "world" as Settings["mode"] })).mode,
		).toBe("overlay");
		expect(
			compositeFor(settings({ mode: "world" as Settings["mode"] })).mode,
		).toBe("overlay");
	});
});

describe("compositeFor", () => {
	it("copies the composite uniforms and the lens tuple", () => {
		const s = settings({ lens: [0.2, 0.7], layerOpacity: 0.3, rangeKm: 9 });
		const c = compositeFor(s);
		expect(c.lens).toEqual([0.2, 0.7]);
		expect(c.lens).not.toBe(s.lens);
		expect(c.layerOpacity).toBe(0.3);
		expect(c.rangeKm).toBe(9);
		expect(c.keepSky).toBe(s.keepSky);
		expect(c.protectPeople).toBe(s.protectPeople);
	});
});
