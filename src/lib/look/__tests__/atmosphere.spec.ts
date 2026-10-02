// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { CLASSIC } from "#/lib/style/defaults";
import { mergeStyle } from "#/lib/style/schema";
import type { DeepPartial, ViewStyle } from "#/lib/style/types";
import { expectArrayClose } from "#/test/helpers";
import {
	ATM_CURV,
	atmosphereValues,
	atmPath,
	BETA_M0,
	BETA_R0,
	defaultAtmosphere,
	enuAltitude,
	FIT_MIN_QUALITY,
	H_R,
	nebelTransmittance,
	transmittance,
} from "../atmosphere";
import { nebelRayTransmittance } from "../nebelmeer";

const physical = (extra: object = {}): ViewStyle =>
	mergeStyle(CLASSIC, {
		terrain: { atmosphere: { mode: "physical", ...extra } },
	} as DeepPartial<ViewStyle>);

describe("atmPath", () => {
	it("a level path is density × length", () => {
		expect(atmPath(0, 0, 1000, H_R)).toBeCloseTo(1000, 9);
		expect(atmPath(2000, 2000, 1000, H_R)).toBeCloseTo(
			1000 * Math.exp(-2000 / H_R),
			9,
		);
	});
	it("a vertical path to space integrates to the scale height", () => {
		expect(atmPath(0, 1e6, 1e6, H_R)).toBeCloseTo(H_R, 3);
	});
	it("is symmetric in direction and continuous across the small-slope branch", () => {
		const down = atmPath(3000, 0, 3000, H_R);
		const up = atmPath(0, 3000, 3000, H_R);
		expect(down).toBeCloseTo(up, 9);
		// 1e-3 · H = 8 m rise: both branches agree
		const a = atmPath(0, 7.99, 1000, H_R);
		const b = atmPath(0, 8.01, 1000, H_R);
		expect(Math.abs(a - b)).toBeLessThan(1e-2);
	});
	it("thins out when the path climbs", () => {
		expect(atmPath(0, 4000, 5000, H_R)).toBeLessThan(5000);
		expect(atmPath(0, 4000, 5000, H_R)).toBeGreaterThan(
			atmPath(0, 8000, 5000, H_R),
		);
	});
});

describe("enuAltitude", () => {
	it("is z on the axis and rises with horizontal distance (curvature drop undone)", () => {
		expect(enuAltitude(0, 0, 123)).toBe(123);
		expect(ATM_CURV).toBeGreaterThan(0);
		// ≈ d² (1-k) / 2R: about 6.8 m at 10 km
		expect(enuAltitude(10000, 0, 0)).toBeGreaterThan(6);
		expect(enuAltitude(10000, 0, 0)).toBeLessThan(8);
		expect(enuAltitude(0, 10000, 0)).toBeCloseTo(enuAltitude(10000, 0, 0), 9);
	});
});

describe("defaultAtmosphere", () => {
	it("normalises the sun direction and carries the sea-level constants", () => {
		const a = defaultAtmosphere([0, 0, 10]);
		expect(a.sunDir).toEqual([0, 0, 1]);
		expect(a.betaR).toEqual(BETA_R0);
		expect(a.betaR).not.toBe(BETA_R0);
		expect(a.betaM).toBe(BETA_M0);
		expect(a.airlightMix).toBe(0);
		expect(a.strength).toBe(1);
	});
	it("a zero direction does not produce NaN", () => {
		expect(defaultAtmosphere([0, 0, 0]).sunDir.every(Number.isFinite)).toBe(
			true,
		);
	});
});

describe("transmittance", () => {
	const p = defaultAtmosphere([0, 0, 1]);
	it("is 1 for a zero-length ray and 0..1 otherwise", () => {
		expectArrayClose(transmittance(p, [0, 0, 1000], [0, 0, 1000]), [1, 1, 1]);
		const t = transmittance(p, [0, 0, 1000], [20000, 0, 1500]);
		for (const c of t) {
			expect(c).toBeGreaterThan(0);
			expect(c).toBeLessThan(1);
		}
	});
	it("scatters blue more than red and decreases with distance", () => {
		const near = transmittance(p, [0, 0, 1000], [5000, 0, 1000]);
		const far = transmittance(p, [0, 0, 1000], [50000, 0, 1000]);
		expect(near[2]).toBeLessThan(near[0]);
		for (let i = 0; i < 3; i++) expect(far[i]).toBeLessThan(near[i]);
	});
	it("strength s raises the transmittance to the power s", () => {
		const t1 = transmittance(p, [0, 0, 500], [30000, 0, 800]);
		const t2 = transmittance(
			{ ...p, strength: 2 },
			[0, 0, 500],
			[30000, 0, 800],
		);
		for (let i = 0; i < 3; i++) expect(t2[i]).toBeCloseTo(t1[i] ** 2, 12);
		expectArrayClose(
			transmittance({ ...p, strength: 0 }, [0, 0, 500], [30000, 0, 800]),
			[1, 1, 1],
		);
	});
	it("is reciprocal: eye to point equals point to eye", () => {
		const a = transmittance(p, [0, 0, 500], [30000, 4000, 2500]);
		const b = transmittance(p, [30000, 4000, 2500], [0, 0, 500]);
		expectArrayClose(a, b, 1e-9);
	});
	it("a ray through high thin air loses less than one at the valley floor", () => {
		const low = transmittance(p, [0, 0, 400], [20000, 0, 400]);
		const high = transmittance(p, [0, 0, 3000], [20000, 0, 3000]);
		for (let i = 0; i < 3; i++) expect(high[i]).toBeGreaterThan(low[i]);
	});
});

describe("nebelTransmittance", () => {
	it("is 1 when absent or off", () => {
		expect(nebelTransmittance({}, [0, 0, 0], [1000, 0, 0])).toBe(1);
		expect(
			nebelTransmittance({ nebel: [1400, 0, 0.01] }, [0, 0, 0], [1000, 0, 0]),
		).toBe(1);
	});
	it("matches the ray transmittance with curvature-corrected altitudes", () => {
		const v = { nebel: [1400, 0.002, 0.01] as [number, number, number] };
		const t = nebelTransmittance(v, [0, 0, 800], [4000, 0, 900]);
		const ref = nebelRayTransmittance(
			Math.hypot(4000, 0, 100),
			enuAltitude(0, 0, 800),
			enuAltitude(4000, 0, 900),
			0.002,
			1400,
			0.01,
		);
		expect(t).toBe(ref);
		expect(t).toBeLessThan(1);
	});
});

describe("nebelRayTransmittance", () => {
	it("is exp(-density · L) inside a uniform layer (falloff 0)", () => {
		expect(nebelRayTransmittance(1000, 0, 0, 0.001, 5000, 0)).toBeCloseTo(
			Math.exp(-1),
			9,
		);
	});
	it("a ray entirely far above the top is nearly clear", () => {
		expect(
			nebelRayTransmittance(1000, 5000, 5000, 0.01, 1400, 0.01),
		).toBeGreaterThan(0.999);
	});
	it("is symmetric in the endpoints and shrinks with density and length", () => {
		const a = nebelRayTransmittance(2000, 500, 1800, 0.002, 1400, 0.01);
		const b = nebelRayTransmittance(2000, 1800, 500, 0.002, 1400, 0.01);
		expect(a).toBeCloseTo(b, 12);
		expect(
			nebelRayTransmittance(4000, 500, 1800, 0.002, 1400, 0.01),
		).toBeLessThan(a);
		expect(
			nebelRayTransmittance(2000, 500, 1800, 0.004, 1400, 0.01),
		).toBeLessThan(a);
	});
	it("negative density counts as none", () => {
		expect(nebelRayTransmittance(1000, 0, 0, -1, 1400, 0.01)).toBe(1);
	});
});

describe("atmosphereValues", () => {
	const sun: [number, number, number] = [0, 0, 1];
	it("always emits an off nebel for the classic mode (density 0)", () => {
		const v = atmosphereValues(CLASSIC, "overlay", sun, [0, 0, 0]);
		expect(v.nebel?.[1]).toBe(0);
		expect(v.nebelColor).toEqual([0, 0, 0]);
		expect(v.strength).toBe(1);
	});
	it("multiplies the style strength by the view's haze multiplier", () => {
		const s = physical({ strength: 1.5 });
		expect(atmosphereValues(s, "overlay", sun, [0, 0, 0]).strength).toBeCloseTo(
			1.5,
			12,
		);
		expect(atmosphereValues(s, "replace", sun, [0, 0, 0]).strength).toBeCloseTo(
			1.5 * s.replace.haze,
			12,
		);
		expect(atmosphereValues(s, "world", sun, [0, 0, 0]).strength).toBeCloseTo(
			1.5 * s.world.haze,
			12,
		);
	});
	it("uses the physical airlight (mix 0) unless a fit is asked for", () => {
		const v = atmosphereValues(physical(), "overlay", sun, [0, 0, 0]);
		expect(v.airlightMix).toBe(0);
	});
	it("a good fit replaces the whole atmosphere; a poor one lends only its airlight", () => {
		const s = physical({ airlight: "fitted" });
		const base = defaultAtmosphere(sun);
		const fitted = (quality: number) => ({
			...base,
			betaR: [1e-5, 1e-5, 1e-5] as [number, number, number],
			betaM: 5e-5,
			airlight: [0.1, 0.2, 0.3] as [number, number, number],
			airlightMix: 1,
			strength: 2,
			quality,
		});
		const good = atmosphereValues(
			s,
			"overlay",
			sun,
			[0, 0, 0],
			fitted(FIT_MIN_QUALITY),
		);
		expect(good.betaR).toEqual([1e-5, 1e-5, 1e-5]);
		expect(good.betaM).toBe(5e-5);
		expect(good.strength).toBe(2);
		const poor = atmosphereValues(
			s,
			"overlay",
			sun,
			[0, 0, 0],
			fitted(FIT_MIN_QUALITY - 0.01),
		);
		expect(poor.betaR).toEqual(BETA_R0);
		expect(poor.betaM).toBe(BETA_M0);
		expect(poor.airlight).toEqual([0.1, 0.2, 0.3]);
		expect(poor.airlightMix).toBe(1);
	});
	it("ignores a fit unless the style asks for fitted airlight", () => {
		const base = defaultAtmosphere(sun);
		const v = atmosphereValues(physical(), "overlay", sun, [0, 0, 0], {
			...base,
			airlight: [0.1, 0.2, 0.3],
			quality: 1,
		});
		expect(v.airlight).toEqual(base.airlight);
	});
	it("linearises the nebelmeer colour when the layer is on", () => {
		const v = atmosphereValues(
			physical({
				nebelmeer: {
					top: 1500,
					density: 0.003,
					falloff: 0.02,
					color: "#ffffff",
				},
			}),
			"overlay",
			sun,
			[0, 0, 0],
		);
		expect(v.nebel).toEqual([1500, 0.003, 0.02]);
		expectArrayClose(v.nebelColor ?? [], [1, 1, 1], 1e-9);
	});
});
