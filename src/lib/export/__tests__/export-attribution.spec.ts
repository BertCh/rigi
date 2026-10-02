// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { afterEach, describe, expect, it, vi } from "vitest";
import { setFlagOverride } from "#/lib/flags";
import type { Renderer } from "#/lib/renderer";
import { DEFAULT_ATTRIBUTION } from "../annotate";
import {
	exportAttribution,
	exportFromEngine,
	GOOGLE_TILES_EXPORT_BLOCKED,
	showsGoogleTiles,
} from "../engine-export";

const engine = (tiles: string | null) =>
	({
		photo: { id: "demo-09", lat: 46.78, lon: 7.8 },
		pose: { yaw: 10, pitch: 0, roll: 0, vfov: 50 },
		settings: { mode: "overlay" },
		terrain: {},
		tiles3dAttribution: () => tiles,
		exportImage: vi.fn(async () => null),
	}) as unknown as Renderer;

afterEach(() => setFlagOverride("attrib", undefined));

describe("export attribution", () => {
	it("is the classic default line without 3D tiles", () => {
		expect(exportAttribution(engine(null))).toBe(DEFAULT_ATTRIBUTION);
	});

	it("appends the tiles' own credit while Step Inside draws them", () => {
		expect(exportAttribution(engine("Buildings © swisstopo"))).toBe(
			`${DEFAULT_ATTRIBUTION} · 3D: Buildings © swisstopo`,
		);
	});

	it("uses the per-source line under ?attrib=full", () => {
		setFlagOverride("attrib", "full");
		const line = exportAttribution(engine(null));
		expect(line).not.toBe(DEFAULT_ATTRIBUTION);
		expect(line.startsWith("Terrain © Mapterhorn (")).toBe(true);
	});
});

describe("Google 3D Tiles are display-only", () => {
	it("detects Google tiles in the on-screen credit", () => {
		expect(showsGoogleTiles(engine(null))).toBe(false);
		expect(showsGoogleTiles(engine("Buildings © swisstopo"))).toBe(false);
		expect(showsGoogleTiles(engine("Google · Data SIO, NOAA"))).toBe(true);
		expect(showsGoogleTiles(engine("© Google Earth; Airbus"))).toBe(true);
	});

	it("refuses a PNG export before rendering", async () => {
		const e = engine("Google");
		await expect(exportFromEngine(e, "png")).rejects.toThrow(
			GOOGLE_TILES_EXPORT_BLOCKED,
		);
		expect(e.exportImage).not.toHaveBeenCalled();
	});
});
