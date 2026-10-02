// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import {
	altitudeContourCost,
	concordEye,
	EYE_ABOVE_GROUND,
	EYE_PRIOR_DEFAULTS,
	eyePriorFromExif,
	floorEye,
	isoBandSeeds,
	refineEyeOptions,
} from "../altitude";
import type { GroundFn } from "../ground";

// A hill rising 0.3 m per metre east: ground = 1000 + 0.3 * dE
const slope: GroundFn = (dE) => 1000 + 0.3 * dE;
const flat: GroundFn = () => 1000;
const noData: GroundFn = () => Number.NaN;
const meta = (o: Partial<Parameters<typeof eyePriorFromExif>[0]> = {}) => ({
	lat: 46.7,
	lon: 7.8,
	alt: 1000 + 1.6 + EYE_PRIOR_DEFAULTS.altBias, // the bias-corrected alt = ground + 1.6 at dE = 0
	hAcc: 20,
	...o,
});

describe("floorEye", () => {
	it("is max(alt, ground + h) and uses the ground when there is no altitude", () => {
		expect(floorEye(1100, 1000)).toBe(1100);
		expect(floorEye(900, 1000)).toBe(1001.6);
		expect(floorEye(null, 1000)).toBe(1001.6);
		expect(floorEye(undefined, 1000, 2)).toBe(1002);
	});
});

describe("eyePriorFromExif fallbacks", () => {
	it("pins keep the floor rule and never an iso-band", () => {
		const p = eyePriorFromExif(meta({ fromPin: true }), slope);
		expect(p.source).toBe("pin");
		expect(p.isoBand).toBeUndefined();
		expect(p.eye0[2]).toBeCloseTo(floorEye(meta().alt, 1000), 9);
	});

	it("falls back without an altitude", () => {
		for (const alt of [null, Number.NaN]) {
			const p = eyePriorFromExif(meta({ alt }), slope);
			expect(p.source).toBe("gps+dem-floor");
			expect(p.reason).toBe("no GPS altitude");
		}
		expect(eyePriorFromExif(meta({ alt: null }), slope).eye0[2]).toBeCloseTo(
			1001.6,
			9,
		);
	});

	it("falls back with no DEM at the fix, carrying the raw altitude", () => {
		const p = eyePriorFromExif(meta({ alt: 1234 }), noData);
		expect(p.source).toBe("gps+dem-floor");
		expect(p.reason).toBe("no DEM at fix");
		expect(p.eye0[2]).toBe(1234);
		expect(Number.isNaN(p.g0)).toBe(true);
	});

	it("falls back when the iso-band is empty within 2 sigma-H", () => {
		const p = eyePriorFromExif(meta({ alt: 3000, hAcc: 10 }), slope);
		expect(p.source).toBe("gps+dem-floor");
		expect(p.reason).toMatch(/iso-band empty/);
		expect(p.bandFrac).toBe(0);
		expect(p.mapEye).toBeUndefined();
	});

	it("clamps sigma-H to [hAccMin, hAccMax] and defaults it when unknown", () => {
		expect(eyePriorFromExif(meta({ hAcc: 1, alt: null }), flat).sigmaH).toBe(
			EYE_PRIOR_DEFAULTS.hAccMin,
		);
		expect(eyePriorFromExif(meta({ hAcc: 900, alt: null }), flat).sigmaH).toBe(
			EYE_PRIOR_DEFAULTS.hAccMax,
		);
		expect(eyePriorFromExif(meta({ hAcc: null, alt: null }), flat).sigmaH).toBe(
			EYE_PRIOR_DEFAULTS.hAccDefault,
		);
	});
});

describe("eyePriorFromExif iso-band", () => {
	it("on flat ground the MAP sits at the fix and the band covers the whole disk", () => {
		const p = eyePriorFromExif(meta(), flat);
		expect(p.source).toBe("gps+alt-contour");
		expect(p.bandFrac).toBeCloseTo(1, 6);
		expect(p.mapEye?.[2]).toBeCloseTo(1001.6, 6);
		expect(Math.hypot(p.mapEye?.[0] ?? 99, p.mapEye?.[1] ?? 99)).toBeLessThan(
			1.5,
		);
		expect(p.eye0).toEqual([0, 0, 1001.6]);
		expect(p.sigmaV).toBe(EYE_PRIOR_DEFAULTS.sigmaA);
	});

	it("on a slope the MAP moves toward the point whose ground matches the altitude", () => {
		// alt reads 12 m higher than the fix ground + 1.6 -> the eye should be ~40 m east (0.3 m/m)
		const p = eyePriorFromExif(
			meta({ alt: 1000 + 1.6 + EYE_PRIOR_DEFAULTS.altBias + 6, hAcc: 60 }),
			slope,
		);
		expect(p.source).toBe("gps+alt-contour");
		const [dE, , z] = p.mapEye as [number, number, number];
		expect(dE).toBeGreaterThan(5);
		expect(dE).toBeLessThan(25);
		// the MAP eye stands 1.6 m above the DEM there
		expect(z).toBeCloseTo(slope(dE, 0) + 1.6, 6);
	});

	it("altBias shifts the interpretation of the altitude", () => {
		const m = meta({ alt: 1001.6 });
		const biased = eyePriorFromExif(m, flat, { altBias: 0 });
		expect(biased.source).toBe("gps+alt-contour");
		expect(biased.isoBand?.alt).toBe(1001.6);
		const def = eyePriorFromExif(m, flat); // default bias -7: reads 1008.6, outside sigmaA of 1001.6
		expect(def.source).toBe("gps+dem-floor");
	});
});

describe("altitudeContourCost", () => {
	const p = eyePriorFromExif(meta(), slope);

	it("is zero on the iso-band and quadratic in the residual", () => {
		expect(altitudeContourCost([0, 0, 1001.6], p)).toBeCloseTo(0, 9);
		// moving 10 m east lifts the ground 3 m = exactly one sigmaA -> cost 1
		expect(altitudeContourCost([10, 0, 0], p)).toBeCloseTo(1, 6);
		expect(altitudeContourCost([20, 0, 0], p)).toBeCloseTo(4, 6);
	});

	it("is zero without an iso-band or where the DEM has no data", () => {
		const fb = eyePriorFromExif(meta({ alt: null }), slope);
		expect(altitudeContourCost([50, 0, 0], fb)).toBe(0);
		const holey = {
			...p,
			isoBand: {
				...(p.isoBand as NonNullable<typeof p.isoBand>),
				ground: noData,
			},
		};
		expect(altitudeContourCost([0, 0, 0], holey)).toBe(0);
	});
});

describe("isoBandSeeds", () => {
	it("returns spread, band-satisfying seeds, best first, capped at n", () => {
		const p = eyePriorFromExif(meta({ hAcc: 40 }), slope);
		const seeds = isoBandSeeds(p, 6);
		expect(seeds.length).toBeGreaterThan(1);
		expect(seeds.length).toBeLessThanOrEqual(6);
		for (const [x, y, z] of seeds) {
			expect(Math.hypot(x, y)).toBeLessThanOrEqual(2 * p.sigmaH + 1e-6);
			expect(
				Math.abs(slope(x, y) + EYE_ABOVE_GROUND - (p.isoBand?.alt ?? 0)),
			).toBeLessThanOrEqual(p.isoBand?.sigmaA ?? 0);
			expect(z).toBeCloseTo(slope(x, y) + 1.6, 9);
		}
		for (let i = 0; i < seeds.length; i++)
			for (let j = i + 1; j < seeds.length; j++)
				expect(
					Math.hypot(seeds[i][0] - seeds[j][0], seeds[i][1] - seeds[j][1]),
				).toBeGreaterThanOrEqual(p.sigmaH / 4 - 1e-9);
	});

	it("is empty without an iso-band", () => {
		expect(isoBandSeeds(eyePriorFromExif(meta({ alt: null }), flat))).toEqual(
			[],
		);
	});
});

describe("refineEyeOptions", () => {
	it("derives the search grid from sigma-H and exposes the ground clamp", () => {
		const p = eyePriorFromExif(meta({ hAcc: 30 }), flat);
		const o = refineEyeOptions(p);
		expect(o.sigmaH).toBe(30);
		expect(o.sigmaV).toBe(p.sigmaV);
		expect(o.ground).toBe(flat);
		expect(o.grid).toEqual({ radius: 60, step: 10, dz: [0] });
		const fb = refineEyeOptions(
			eyePriorFromExif(meta({ alt: null, hAcc: 6 }), flat),
		);
		expect(fb.ground).toBeUndefined();
		expect(fb.grid.radius).toBe(12);
		expect(fb.grid.step).toBe(5);
	});
});

describe("concordEye", () => {
	it("is null when the flag is off", () => {
		expect(concordEye(meta(), flat, { eye: false })).toBeNull();
	});

	it("is null on every fallback source", () => {
		expect(concordEye(meta({ alt: null }), flat, { eye: true })).toBeNull();
		expect(concordEye(meta({ fromPin: true }), flat, { eye: true })).toBeNull();
		expect(concordEye(meta({ alt: 5000 }), flat, { eye: true })).toBeNull();
	});

	it("returns the MAP eye with a lat/lon shifted by the east/north offset", () => {
		const m = meta({
			alt: 1000 + 1.6 + EYE_PRIOR_DEFAULTS.altBias + 6,
			hAcc: 60,
		});
		const r = concordEye(m, slope, { eye: true });
		expect(r).not.toBeNull();
		if (!r) return;
		expect(r.dE).toBeGreaterThan(0);
		expect(r.lon).toBeGreaterThan(m.lon);
		expect(r.shiftM).toBeCloseTo(Math.hypot(r.dE, r.dN), 9);
		expect(r.alt).toBeCloseTo(slope(r.dE, r.dN) + 1.6, 6);
		expect(r.prior.source).toBe("gps+alt-contour");
	});

	it("passes tuning options through", () => {
		expect(concordEye(meta({ alt: 1001.6 }), flat, { eye: true })).toBeNull();
		expect(
			concordEye(meta({ alt: 1001.6 }), flat, {
				eye: true,
				opts: { altBias: 0 },
			}),
		).not.toBeNull();
	});
});
