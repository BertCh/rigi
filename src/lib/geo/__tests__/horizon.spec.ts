// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { destination, EARTH_R, REFRACTION_K } from "../../geodesy";
import type { Ridge } from "../horizon";
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
	it("is bit-identical to the plain destination() march it unrolls", () => {
		// A height field whose value changes with every bit of (lon, lat), plus a hole and ridges.
		const t = stub((lon, lat, d) => {
			if (d > 3000 && d < 3400) return Number.NaN;
			return (
				1500 +
				900 * Math.sin(lon * 4000) * Math.cos(lat * 3100) +
				d * 0.01 +
				(lon * 1e7 - Math.floor(lon * 1e7))
			);
		});
		const opts = { step: 7.5, maxDistance: 40_000 };
		const got = computeHorizon(t, 46.61, 7.93, 1650.3, opts);
		const want = referenceHorizon(t, 46.61, 7.93, 1650.3, opts);
		expect([...got.elevation]).toEqual([...want.elevation]);
		expect([...got.distance]).toEqual([...want.distance]);
		expect(got.ridges).toEqual(want.ridges);
		expect(got.ridges.some((r) => r.length > 0)).toBe(true);
	});
});

/** The pre-unrolling computeHorizon (destination() per sample), kept as the bit-identity reference. */
function referenceHorizon(
	terrain: TerrainSampler,
	lat: number,
	lon: number,
	eyeHeight: number,
	opts: { step: number; maxDistance: number },
) {
	const rEff = EARTH_R / (1 - REFRACTION_K);
	const distances: number[] = [];
	for (let d = 20; d <= opts.maxDistance; d += Math.max(10, d * 0.004))
		distances.push(d);
	const n = Math.round(360 / opts.step);
	const elevation = new Float32Array(n);
	const distance = new Float32Array(n);
	const ridges: Ridge[][] = [];
	for (let i = 0; i < n; i++) {
		const az = i * opts.step;
		let best = -90;
		let bestD = 0;
		let crest: Ridge | null = null;
		let prevVisible = false;
		const found: Ridge[] = [];
		for (const d of distances) {
			const p = destination(lat, lon, az, d);
			const h = terrain.sampleAt(p.lon, p.lat, d);
			if (Number.isNaN(h)) continue;
			const angle =
				Math.atan2(h - eyeHeight - (d * d) / (2 * rEff), d) * (180 / Math.PI);
			if (angle > best) {
				best = angle;
				bestD = d;
				if (!prevVisible && crest && d - crest.distance > 0.08 * crest.distance)
					found.push(crest);
				crest = { elevation: angle, distance: d };
				prevVisible = true;
			} else prevVisible = false;
		}
		elevation[i] = best;
		distance[i] = bestD;
		ridges.push(found);
	}
	return { elevation, distance, ridges };
}
