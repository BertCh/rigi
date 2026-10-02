// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { seededRandom, uniform } from "#/test/helpers";
import {
	DEG,
	distanceBearing,
	EARTH_R,
	equirectangularM,
	latLonBox,
	M_PER_DEG_LAT,
} from "../geodesy";

// Reference copies of the pre-consolidation code.
function refDistBearing(
	lat0: number,
	lon0: number,
	lat1: number,
	lon1: number,
) {
	const D = Math.PI / 180;
	const dLat = (lat1 - lat0) * D;
	const dLon = (lon1 - lon0) * D;
	const a =
		Math.sin(dLat / 2) ** 2 +
		Math.cos(lat0 * D) * Math.cos(lat1 * D) * Math.sin(dLon / 2) ** 2;
	const d = 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(a)));
	const y = Math.sin(dLon) * Math.cos(lat1 * D);
	const x =
		Math.cos(lat0 * D) * Math.sin(lat1 * D) -
		Math.sin(lat0 * D) * Math.cos(lat1 * D) * Math.cos(dLon);
	return { d, brg: (((Math.atan2(y, x) / D) % 360) + 360) % 360 };
}
function refHav(lat1: number, lon1: number, lat2: number, lon2: number) {
	const k = Math.PI / 180;
	const dx = (lon2 - lon1) * k * Math.cos(((lat1 + lat2) / 2) * k);
	const dy = (lat2 - lat1) * k;
	return Math.hypot(dx, dy) * 6371000;
}
const rel = (a: number, b: number) =>
	Math.abs(a - b) / Math.max(1e-300, Math.abs(b));

describe("geodesy consolidation helpers", () => {
	it("distanceBearing replaces upload's distBearing (<= 1e-12 relative)", () => {
		const rand = seededRandom(3);
		for (let i = 0; i < 2000; i++) {
			const lat0 = uniform(rand, 45.5, 48);
			const lon0 = uniform(rand, 5.5, 10.8);
			const lat1 = lat0 + uniform(rand, -0.8, 0.8);
			const lon1 = lon0 + uniform(rand, -1, 1);
			const ref = refDistBearing(lat0, lon0, lat1, lon1);
			const got = distanceBearing(lat0, lon0, lat1, lon1);
			expect(rel(got.distance, ref.d)).toBeLessThan(1e-12);
			expect(Math.abs(got.bearing - ref.brg)).toBeLessThan(1e-9);
		}
	});

	it("equirectangularM with the rounded radius is bit-identical to the old peakTiers hav", () => {
		const rand = seededRandom(5);
		for (let i = 0; i < 2000; i++) {
			const lat1 = uniform(rand, 44, 48);
			const lon1 = uniform(rand, 5, 11);
			const lat2 = lat1 + uniform(rand, -0.01, 0.01);
			const lon2 = lon1 + uniform(rand, -0.01, 0.01);
			expect(equirectangularM(lat1, lon1, lat2, lon2, 6371000)).toBe(
				refHav(lat1, lon1, lat2, lon2),
			);
		}
	});

	it("latLonBox equals the three inline boxes it replaced", () => {
		const rand = seededRandom(9);
		for (let i = 0; i < 2000; i++) {
			const lat = uniform(rand, -70, 70);
			const lon = uniform(rand, -180, 180);
			const r = uniform(rand, 10, 200000);
			const box = latLonBox({ lat, lon }, r);
			// peaks.ts / deck terrain-data.ts form
			expect(box.dLat).toBe(r / M_PER_DEG_LAT);
			expect(box.dLon).toBe(r / (M_PER_DEG_LAT * Math.cos(lat * DEG)));
			// roll-terrain.ts form (lat * PI / 180): last-ulp difference only
			const rollDLon = r / (M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180));
			expect(rel(box.dLon, rollDLon)).toBeLessThan(1e-12);
			expect(box.north - box.south).toBeCloseTo(2 * box.dLat, 9);
			expect(box.east).toBe(lon + box.dLon);
		}
	});
});
