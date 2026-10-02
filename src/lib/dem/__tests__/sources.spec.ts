// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import {
	DEM_SOURCES,
	MAPTERHORN,
	MAPTERHORN_DEFAULT_URL,
	TERRAIN_LEVELS,
	TERRARIUM_AWS,
} from "../sources";

describe("DEM sources", () => {
	it("builds Terrarium and Mapterhorn tile URLs", () => {
		const k = { z: 12, x: 2144, y: 1435 };
		expect(TERRARIUM_AWS.url(k)).toBe(
			"https://s3.amazonaws.com/elevation-tiles-prod/terrarium/12/2144/1435.png",
		);
		// the default template, unless the environment overrides it
		if (!process.env.MAPTERHORN_URL && !process.env.VITE_MAPTERHORN_URL)
			expect(MAPTERHORN.url(k)).toBe(
				MAPTERHORN_DEFAULT_URL.replace("{z}", "12")
					.replace("{x}", "2144")
					.replace("{y}", "1435"),
			);
	});
	it("is registered by name", () => {
		expect(DEM_SOURCES.terrarium).toBe(TERRARIUM_AWS);
		expect(DEM_SOURCES.mapterhorn).toBe(MAPTERHORN);
		for (const [name, s] of Object.entries(DEM_SOURCES))
			expect(s.name).toBe(name);
	});
	it("level tables go finer to coarser with growing distance", () => {
		for (const levels of [
			TERRAIN_LEVELS,
			TERRARIUM_AWS.levels,
			MAPTERHORN.levels,
		]) {
			for (let i = 1; i < levels.length; i++) {
				expect(levels[i].z).toBeLessThan(levels[i - 1].z);
				expect(levels[i].maxDistance).toBeGreaterThan(
					levels[i - 1].maxDistance,
				);
			}
		}
	});
	it("no level is deeper than the service's maxZoom", () => {
		for (const s of Object.values(DEM_SOURCES))
			expect(Math.max(...s.levels.map((l) => l.z))).toBeLessThanOrEqual(
				s.maxZoom,
			);
	});
	it("a 512 px Mapterhorn level is one zoom below the 256 px level of the same scale", () => {
		expect(MAPTERHORN.tileSize).toBe(2 * TERRARIUM_AWS.tileSize);
	});
});
