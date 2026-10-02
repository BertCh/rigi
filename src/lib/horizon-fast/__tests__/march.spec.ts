// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { beforeAll, describe, expect, it } from "vitest";
import { angleDiffDeg } from "#/test/helpers";
import { DEG, destination, EARTH_R, REFRACTION_K } from "../../geodesy";
import { computeHorizonFast, peakVisibilityFast } from "../march";
import { loadMosaics, type Mosaic, TileStore } from "../mosaic";
import { classifyPeak, mosaicHeightAt, snapPeaks } from "../visibility";
import { fakeSource, gaussianPeak } from "./demFixture";

const LAT = 10;
const LON = 10;
const EYE = { lat: LAT, lon: LON, h: 10 };
const PEAK_D = 10_000;
const PEAK_H = 1000;
const SIGMA = 1500;
const summit = destination(LAT, LON, 0, PEAK_D);
const surface = gaussianPeak(summit.lat, summit.lon, PEAK_H, SIGMA);
const inv2R = (1 - REFRACTION_K) / (2 * EARTH_R);
const STEP = 1;

let mosaics: Mosaic[];
beforeAll(async () => {
	mosaics = await loadMosaics(LAT, LON, new TileStore(fakeSource(surface)), {
		rings: [{ z: 12, maxDistance: 30_000 }],
		maxDistance: 30_000,
	});
});

/** The apparent elevation of the surface along an azimuth, by brute force on the analytic DEM. */
function bruteElevation(az: number, maxD = 30_000) {
	let best = Number.NEGATIVE_INFINITY;
	for (let d = 50; d <= maxD; d += 10) {
		const p = destination(LAT, LON, az, d);
		const t = (surface(p.lon, p.lat) - EYE.h) / d - d * inv2R;
		if (t > best) best = t;
	}
	return Math.atan(best) / DEG;
}

describe("computeHorizonFast", () => {
	it("returns 360/step samples with matching metadata", () => {
		const p = computeHorizonFast(mosaics, EYE, {
			step: STEP,
			maxDistance: 30_000,
		});
		expect(p.step).toBe(STEP);
		expect(p.elevation).toHaveLength(360);
		expect(p.distance).toHaveLength(360);
		expect(p.ridges).toHaveLength(360);
		expect(p.i0).toBe(0);
		expect(p.stats.azimuths).toBe(360);
		expect(p.stats.samples).toBeGreaterThan(0);
	});
	it("matches a brute-force skyline of the analytic DEM towards the mountain", () => {
		const p = computeHorizonFast(mosaics, EYE, {
			step: STEP,
			maxDistance: 30_000,
		});
		for (const az of [0, 1, 2, 5, 358]) {
			expect(Math.abs(p.elevation[az] - bruteElevation(az))).toBeLessThan(0.08);
		}
	});
	it("the highest skyline point is due north, at about the summit's distance", () => {
		const p = computeHorizonFast(mosaics, EYE, {
			step: STEP,
			maxDistance: 30_000,
		});
		let imax = 0;
		for (let i = 1; i < 360; i++)
			if (p.elevation[i] > p.elevation[imax]) imax = i;
		expect(angleDiffDeg(imax * STEP, 0)).toBeLessThanOrEqual(1);
		expect(Math.abs(p.distance[imax] - PEAK_D)).toBeLessThan(1500);
		// atan(~990 / 10000 - curvature) ~ 5.5 degrees
		expect(p.elevation[imax]).toBeGreaterThan(5);
		expect(p.elevation[imax]).toBeLessThan(6);
	});
	it("the skyline falls away from the mountain and is symmetric about north", () => {
		const p = computeHorizonFast(mosaics, EYE, {
			step: STEP,
			maxDistance: 30_000,
		});
		for (let k = 1; k < 20; k++)
			expect(Math.abs(p.elevation[k] - p.elevation[360 - k])).toBeLessThan(
				0.05,
			);
		expect(p.elevation[0]).toBeGreaterThan(p.elevation[10]);
		expect(p.elevation[10]).toBeGreaterThan(p.elevation[40]);
	});
	it("flat ground has a slightly negative skyline (curvature dip)", () => {
		const p = computeHorizonFast(mosaics, EYE, {
			step: STEP,
			maxDistance: 30_000,
		});
		expect(p.elevation[180]).toBeLessThan(0);
		expect(p.elevation[180]).toBeGreaterThan(-1);
	});
	it("mip skipping does not change the result", () => {
		const a = computeHorizonFast(mosaics, EYE, {
			step: 5,
			maxDistance: 30_000,
			mipSkip: true,
		});
		const b = computeHorizonFast(mosaics, EYE, {
			step: 5,
			maxDistance: 30_000,
			mipSkip: false,
		});
		for (let i = 0; i < a.elevation.length; i++)
			expect(Math.abs(a.elevation[i] - b.elevation[i])).toBeLessThan(0.02);
		expect(a.stats.samples).toBeLessThanOrEqual(b.stats.samples);
	});
	it("a sector run equals the same slice of the full run", () => {
		const full = computeHorizonFast(mosaics, EYE, {
			step: 2,
			maxDistance: 30_000,
		});
		const sector = computeHorizonFast(mosaics, EYE, {
			step: 2,
			maxDistance: 30_000,
			i0: 10,
			i1: 20,
		});
		expect(sector.i0).toBe(10);
		expect(sector.elevation).toHaveLength(10);
		for (let i = 0; i < 10; i++)
			expect(sector.elevation[i]).toBe(full.elevation[10 + i]);
	});
	it("raising the eye lowers the elevation angle of a fixed mountain", () => {
		const low = computeHorizonFast(
			mosaics,
			{ ...EYE, h: 10 },
			{ step: 90, maxDistance: 30_000 },
		);
		const high = computeHorizonFast(
			mosaics,
			{ ...EYE, h: 500 },
			{ step: 90, maxDistance: 30_000 },
		);
		expect(high.elevation[0]).toBeLessThan(low.elevation[0]);
	});
	it("a larger refraction coefficient raises the skyline", () => {
		const k0 = computeHorizonFast(mosaics, EYE, {
			step: 90,
			maxDistance: 30_000,
			k: 0,
		});
		const k2 = computeHorizonFast(mosaics, EYE, {
			step: 90,
			maxDistance: 30_000,
			k: 0.3,
		});
		expect(k2.elevation[0]).toBeGreaterThan(k0.elevation[0]);
	});
	it("records the mountain as a ridge only when asked", () => {
		const some = computeHorizonFast(mosaics, EYE, {
			step: 90,
			maxDistance: 30_000,
		});
		const none = computeHorizonFast(mosaics, EYE, {
			step: 90,
			maxDistance: 30_000,
			noRidges: true,
		});
		expect(none.ridges.every((r) => r.length === 0)).toBe(true);
		expect(some.ridges).toHaveLength(4);
	});
	it("maxDistance limits the march: a nearer cap cannot see the farther summit", () => {
		const near = computeHorizonFast(mosaics, EYE, {
			step: 90,
			maxDistance: 3_000,
		});
		const far = computeHorizonFast(mosaics, EYE, {
			step: 90,
			maxDistance: 30_000,
		});
		expect(near.elevation[0]).toBeLessThan(far.elevation[0]);
		expect(near.distance[0]).toBeLessThanOrEqual(3_000 + 1);
	});
});

describe("peak snapping and visibility", () => {
	const cellAt = () => 150;
	it("snaps an offset OSM node to the DEM summit and takes the max height", () => {
		const h = mosaicHeightAt(mosaics);
		const off = destination(summit.lat, summit.lon, 90, 250);
		const [s] = snapPeaks(
			[{ name: "P", lat: off.lat, lon: off.lon, ele: 990 }],
			h,
			cellAt,
			EYE,
		);
		expect(s.snapped).toBe(true);
		expect(s.snapDistance).toBeGreaterThan(0);
		expect(s.snapDistance).toBeLessThanOrEqual(300);
		expect(s.height).toBeGreaterThanOrEqual(990);
		expect(s.index).toBe(0);
		expect(Math.abs(s.distance - PEAK_D)).toBeLessThan(500);
	});
	it("does not snap when the node already sits on the summit", () => {
		const h = mosaicHeightAt(mosaics);
		const [s] = snapPeaks(
			[{ lat: summit.lat, lon: summit.lon }],
			h,
			cellAt,
			EYE,
		);
		expect(s.snapped).toBe(false);
		expect(s.snapDistance).toBe(0);
	});
	it("drops peaks outside [minDistance, maxDistance]", () => {
		const h = mosaicHeightAt(mosaics);
		const near = destination(LAT, LON, 0, 20);
		const out = snapPeaks(
			[
				{ lat: near.lat, lon: near.lon, ele: 100 },
				{ lat: summit.lat, lon: summit.lon, ele: 1000 },
			],
			h,
			cellAt,
			EYE,
			{ maxDistance: 5000 },
		);
		expect(out).toHaveLength(0);
	});
	it("a peak with no DEM data but an ele is kept at its ele", () => {
		const far = destination(LAT, LON, 90, 80_000); // outside the 30 km mosaic -> NaN
		const [s] = snapPeaks(
			[{ lat: far.lat, lon: far.lon, ele: 2500 }],
			mosaicHeightAt(mosaics),
			cellAt,
			EYE,
		);
		expect(s.height).toBe(2500);
		expect(s.snapped).toBe(false);
	});
	it("a peak with neither DEM nor ele is dropped", () => {
		const far = destination(LAT, LON, 90, 80_000);
		expect(
			snapPeaks(
				[{ lat: far.lat, lon: far.lon }],
				mosaicHeightAt(mosaics),
				cellAt,
				EYE,
			),
		).toHaveLength(0);
	});
	it("rejects a snap that would change the height by more than maxHeightChange", () => {
		const h = mosaicHeightAt(mosaics);
		const off = destination(summit.lat, summit.lon, 90, 250);
		const [s] = snapPeaks(
			[{ lat: off.lat, lon: off.lon, ele: 400 }],
			h,
			cellAt,
			EYE,
		);
		expect(s.snapped).toBe(false);
		expect(s.height).toBe(Math.max(400, s.demHeight));
	});
	it("the mountain's own summit is visible and on the skyline", () => {
		const h = mosaicHeightAt(mosaics);
		const snapped = snapPeaks(
			[{ lat: summit.lat, lon: summit.lon, ele: 1000 }],
			h,
			cellAt,
			EYE,
		);
		// the Gaussian's skyline max lies slightly in front of the summit, ~0.05 deg higher: widen the band
		const [v] = peakVisibilityFast(mosaics, EYE, snapped, {
			maxDistance: 30_000,
			classify: { skylineTolerance: 0.2 },
		});
		expect(v.visible).toBe(true);
		expect(v.onSkyline).toBe(true);
		expect(v.elevation).toBeGreaterThan(5);
		expect(Math.abs(v.elevation - v.skylineElevation)).toBeLessThan(0.1);
	});
	it("a peak behind the mountain is hidden", () => {
		// a 400 m summit 5 km behind the 1000 m mountain, as seen from the eye
		const behind = destination(LAT, LON, 0, 15_000);
		const [p] = snapPeaks(
			[{ lat: behind.lat, lon: behind.lon, ele: 400 }],
			() => 400,
			cellAt,
			EYE,
		);
		const [v] = peakVisibilityFast(mosaics, EYE, [p], { maxDistance: 30_000 });
		expect(v.visible).toBe(false);
		expect(v.occluderElevation).toBeGreaterThan(v.elevation);
		expect(v.occluderDistance).toBeGreaterThan(0);
		expect(v.onSkyline).toBe(false);
	});
	it("computeHorizonFast classifies given peaks like peakVisibilityFast", () => {
		const behind = destination(LAT, LON, 0, 15_000);
		const peaks = snapPeaks(
			[{ lat: behind.lat, lon: behind.lon, ele: 400 }],
			() => 400,
			cellAt,
			EYE,
		);
		const a = computeHorizonFast(mosaics, EYE, {
			step: 90,
			maxDistance: 30_000,
			peaks,
		});
		const b = peakVisibilityFast(mosaics, EYE, peaks, { maxDistance: 30_000 });
		expect(a.peaks?.[0].visible).toBe(b[0].visible);
		expect(a.peaks?.[0].elevation).toBe(b[0].elevation);
	});
});

describe("classifyPeak", () => {
	const p = {
		peak: { lat: 0, lon: 0 },
		index: 0,
		lat: 0,
		lon: 0,
		height: 1000,
		demHeight: 1000,
		snapped: false,
		snapDistance: 0,
		distance: 10_000,
		azimuth: 0,
		cell: 100,
	};
	const tanDeg = (d: number) => Math.tan(d * DEG);
	it("computes the apparent elevation with curvature/refraction", () => {
		const v = classifyPeak(
			p,
			0,
			inv2R,
			Number.NEGATIVE_INFINITY,
			0,
			Number.NEGATIVE_INFINITY,
			0,
		);
		expect(v.elevation).toBeCloseTo(
			Math.atan(1000 / 10_000 - 10_000 * inv2R) / DEG,
			9,
		);
	});
	it("no occluder / skyline (t = -inf) report -90 deg and a visible peak", () => {
		const v = classifyPeak(
			p,
			0,
			inv2R,
			Number.NEGATIVE_INFINITY,
			0,
			Number.NEGATIVE_INFINITY,
			0,
		);
		expect(v.occluderElevation).toBe(-90);
		expect(v.skylineElevation).toBe(-90);
		expect(v.visible).toBe(true);
		expect(v.marginal).toBe(false);
		expect(v.onSkyline).toBe(true);
	});
	it("hidden when the occluder is well above the peak", () => {
		const elev = classifyPeak(p, 0, inv2R, -1e9, 0, -1e9, 0).elevation;
		const v = classifyPeak(
			p,
			0,
			inv2R,
			tanDeg(elev + 1),
			5000,
			tanDeg(elev + 1),
			5000,
		);
		expect(v.visible).toBe(false);
		expect(v.marginal).toBe(false);
		expect(v.occluderDistance).toBe(5000);
	});
	it("marginal inside the tolerance band either side of the occluder", () => {
		const elev = classifyPeak(p, 0, inv2R, -1e9, 0, -1e9, 0).elevation;
		const tolDeg = 0.02 + ((5 / 10_000) * 180) / Math.PI;
		const justBelow = classifyPeak(
			p,
			0,
			inv2R,
			tanDeg(elev + tolDeg / 2),
			1,
			-1e9,
			0,
		);
		expect(justBelow.visible).toBe(true);
		expect(justBelow.marginal).toBe(true);
		const justAbove = classifyPeak(
			p,
			0,
			inv2R,
			tanDeg(elev - tolDeg / 2),
			1,
			-1e9,
			0,
		);
		expect(justAbove.marginal).toBe(true);
	});
	it("a larger sigmaZ widens the tolerance", () => {
		const elev = classifyPeak(p, 0, inv2R, -1e9, 0, -1e9, 0).elevation;
		const t = tanDeg(elev + 0.1);
		expect(
			classifyPeak(p, 0, inv2R, t, 1, -1e9, 0, { sigmaZ: 5 }).visible,
		).toBe(false);
		expect(
			classifyPeak(p, 0, inv2R, t, 1, -1e9, 0, { sigmaZ: 100 }).visible,
		).toBe(true);
	});
	it("onSkyline needs the peak within skylineTolerance of the skyline", () => {
		const elev = classifyPeak(p, 0, inv2R, -1e9, 0, -1e9, 0).elevation;
		const v1 = classifyPeak(p, 0, inv2R, -1e9, 0, tanDeg(elev + 0.01), 1);
		expect(v1.onSkyline).toBe(true);
		const v2 = classifyPeak(p, 0, inv2R, -1e9, 0, tanDeg(elev + 1), 1);
		expect(v2.visible).toBe(true);
		expect(v2.onSkyline).toBe(false);
	});
});
