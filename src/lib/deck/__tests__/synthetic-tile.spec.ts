// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { createSyntheticTile } from "../synthetic-tile";

describe("createSyntheticTile", () => {
	it("centres the frame on the tile and samples the height function on the grid", () => {
		const { frame, tile } = createSyntheticTile(() => 1500, { size: 17 });
		expect(tile.size).toBe(17);
		expect(tile.seg).toBe(16);
		expect(tile.key.z).toBe(12);
		const origin = [0, 0, 0];
		frame.fromGeo(frame.lat, frame.lon, 0, origin);
		expect(Math.hypot(origin[0], origin[1])).toBeLessThan(1e-6);
		expect(tile.heights).toBeDefined();
		for (const h of tile.heights ?? []) expect(h).toBeCloseTo(1500, 3);
	});

	it("puts row 0 on the north edge", () => {
		const { tile } = createSyntheticTile((_x, y) => y, { size: 9 });
		const north = (tile.heights ?? [])[0];
		const south = (tile.heights ?? []).at(-1) ?? Number.NaN;
		expect(north).toBeGreaterThan(0);
		expect(south).toBeLessThan(0);
	});

	it("places the frame origin southEdgeM metres south of the tile", () => {
		const { tile } = createSyntheticTile((_x, y) => y, {
			size: 9,
			southEdgeM: 5000,
		});
		const south = (tile.heights ?? []).at(-1) ?? Number.NaN;
		expect(south).toBeGreaterThan(4900);
		expect(south).toBeLessThan(5100);
	});

	it("builds the CPU mesh and batch grid when full", () => {
		const { tile } = createSyntheticTile(() => 800, { size: 9, full: true });
		expect(tile.positions.length).toBeGreaterThan(0);
		expect(tile.grid).toBeDefined();
	});
});
