// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { EARTH_R, REFRACTION_K } from "../../geodesy";
import { computeHorizon } from "../horizon";
import type { TerrainSampler } from "../terrain";

const stub = (f: (lon: number, lat: number, d: number) => number) =>
	({ sampleAt: f }) as unknown as TerrainSampler;

describe("computeHorizon", () => {
	it("flat ground at eye level: skyline is the curvature drop, tiny and negative", () => {
		const t = stub(() => 100);
		const h = computeHorizon(t, 46, 8, 100, { step: 90, maxDistance: 10_000 });
		expect(h.elevation).toHaveLength(4);
		expect(h.step).toBe(90);
		// angle = atan2(-d^2/(2 rEff), d) is monotonically decreasing, so the best is the nearest sample
		const rEff = EARTH_R / (1 - REFRACTION_K);
		const expected = Math.atan2(-(20 * 20) / (2 * rEff), 20) * (180 / Math.PI);
		for (const e of h.elevation) expect(e).toBeCloseTo(expected, 6);
		for (const d of h.distance) expect(d).toBe(20);
	});
	it("a wall of constant height H at distance D gives atan(H / D) in that azimuth only", () => {
		const D = 5000;
		const t = stub((_lon, _lat, d) => (d >= D ? 1100 : 0));
		const h = computeHorizon(t, 46, 8, 100, { step: 120, maxDistance: 20_000 });
		const rEff = EARTH_R / (1 - REFRACTION_K);
		// first sampled distance >= D
		const dist = h.distance[0];
		expect(dist).toBeGreaterThanOrEqual(D);
		const expected =
			Math.atan2(1000 - (dist * dist) / (2 * rEff), dist) * (180 / Math.PI);
		expect(h.elevation[0]).toBeCloseTo(expected, 4);
	});
	it("azimuth sampling: sample i is at i * step, 360/step samples", () => {
		let seen = -1;
		const t = stub((lon, lat) => {
			seen = Math.atan2(lon - 8, lat - 46);
			return 0;
		});
		const h = computeHorizon(t, 46, 8, 0, { step: 0.5, maxDistance: 100 });
		expect(h.elevation.length).toBe(720);
		expect(h.distance.length).toBe(720);
		expect(h.ridges.length).toBe(720);
		expect(seen).not.toBe(-1);
	});
	it("directional terrain: only the azimuth facing the hill sees it", () => {
		// hill to the east (lon larger than camera)
		const t = stub((lon, _lat, d) => (lon > 8 + 0.01 && d > 1000 ? 3000 : 0));
		const h = computeHorizon(t, 46, 8, 0, { step: 90, maxDistance: 8000 });
		expect(h.elevation[1]).toBeGreaterThan(10); // east
		expect(h.elevation[3]).toBeLessThan(1); // west
		expect(h.elevation[1]).toBeGreaterThan(h.elevation[0]);
	});
	it("NaN samples are skipped", () => {
		const t = stub(() => Number.NaN);
		const h = computeHorizon(t, 46, 8, 0, { step: 180, maxDistance: 1000 });
		expect([...h.elevation]).toEqual([-90, -90]);
		expect([...h.distance]).toEqual([0, 0]);
	});
	it("reports an occluding crest when terrain re-emerges behind a dip", () => {
		// near ridge 1000-1200 m, valley 1200-4000, taller far ridge from 4000
		const t = stub((_lon, _lat, d) => {
			if (d >= 1000 && d < 1200) return 400;
			if (d >= 4000) return 1800;
			return 0;
		});
		// force the sampler to see all azimuths the same
		const h = computeHorizon(t, 46, 8, 0, { step: 180, maxDistance: 8000 });
		const near = h.ridges[0].find(
			(r) => r.distance >= 1000 && r.distance < 1300,
		);
		expect(near).toBeDefined();
		expect(h.distance[0]).toBeGreaterThanOrEqual(4000);
		expect((near?.elevation ?? 99) < h.elevation[0]).toBe(true);
	});
});
