// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { mercatorLat } from "#/lib/terroir/roll/logic";
import { seededRandom, uniform } from "#/test/helpers";
import { latToTileY, lonToTileX, tileXToLon, tileYToLat } from "../tiles";

// Reference copies of the inline Web-Mercator code the tile helpers replaced.
const rel = (a: number, b: number) =>
	Math.abs(a - b) / Math.max(1e-300, Math.abs(b));

describe("Web-Mercator inline copies equal the tile helpers", () => {
	it("TopoBoard worldPx (bit-identical: power-of-two scaling only)", () => {
		const Z = 14;
		const TILE = 256;
		const rand = seededRandom(1);
		for (let i = 0; i < 2000; i++) {
			const lat = uniform(rand, -80, 80);
			const lon = uniform(rand, -180, 180);
			const n = TILE * 2 ** Z;
			const s = Math.sin((lat * Math.PI) / 180);
			const old = {
				x: ((lon + 180) / 360) * n,
				y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n,
			};
			// the helper uses DEG = PI / 180, so lat * DEG may differ from (lat * PI) / 180 by an ulp
			expect(rel(lonToTileX(lon, Z) * TILE, old.x)).toBe(0);
			expect(rel(latToTileY(lat, Z) * TILE, old.y)).toBeLessThan(1e-12);
		}
	});

	it("roll mercatorLat, bake-live-lines unmerc and licences-check tileYToLat", () => {
		const rand = seededRandom(2);
		for (let i = 0; i < 2000; i++) {
			const z = Math.floor(uniform(rand, 2, 19));
			const tile = rand() < 0.5 ? 256 : 512;
			const y = uniform(rand, 0, 2 ** z * tile);
			const n1 = Math.PI - (2 * Math.PI * y) / (tile * 2 ** z);
			const oldRoll = (Math.atan(Math.sinh(n1)) * 180) / Math.PI;
			expect(Math.abs(mercatorLat(y, z, tile) - oldRoll)).toBeLessThan(1e-12);
			const n = tile * 2 ** z;
			const oldBake =
				(Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
			expect(Math.abs(tileYToLat(y / tile, z) - oldBake)).toBeLessThan(1e-12);
			const x = uniform(rand, 0, n);
			expect(
				Math.abs(tileXToLon(x / tile, z) - ((x / n) * 360 - 180)),
			).toBeLessThan(1e-12);
		}
	});
});
