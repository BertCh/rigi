// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { defaultSettings } from "../settings";

describe("defaultSettings", () => {
	const s = defaultSettings;
	it("starts in the overlay view with a known style per mode", () => {
		expect(s.mode).toBe("overlay");
		expect(["contours", "bands", "slope", "none"]).toContain(s.overlayStyle);
		expect(["satellite", "topo", "hillshade", "bands"]).toContain(s.mapStyle);
		expect(["satellite", "topo", "hillshade"]).toContain(s.worldStyle);
		expect(["swipe", "lens", "range", "brush"]).toContain(s.method);
	});
	it("keeps normalised fractions inside [0, 1]", () => {
		for (const v of [
			s.layerOpacity,
			s.ridges,
			s.depthTint,
			s.swipe,
			s.lensR,
			s.feather,
			s.projectOpacity,
			...s.lens,
		]) {
			expect(v).toBeGreaterThanOrEqual(0);
			expect(v).toBeLessThanOrEqual(1);
		}
	});
	it("uses positive physical distances", () => {
		expect(s.contourInterval).toBeGreaterThan(0);
		expect(s.rangeKm).toBeGreaterThan(0);
		expect(s.minProjectRange).toBeGreaterThan(0);
		expect(s.nearFade).toBeGreaterThanOrEqual(0);
	});
	it("keeps Overpass trails opt-in and people protected", () => {
		expect(s.trails).toBe(false);
		expect(s.protectPeople).toBe(true);
	});
	it("has a lens centre of two numbers", () => {
		expect(s.lens).toHaveLength(2);
	});
});
