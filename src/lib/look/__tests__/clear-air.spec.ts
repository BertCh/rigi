// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { CLASSIC } from "#/lib/style/defaults";
import { mergeStyle } from "#/lib/style/schema";
import type { DeepPartial, ViewStyle } from "#/lib/style/types";
import { expectArrayClose } from "#/test/helpers";
import { defaultAtmosphere, transmittance, type Vec3 } from "../atmosphere";
import {
	CLEAR_AIR_OFF,
	clearAirOn,
	clearAirPixel,
	clearAirValues,
	physAirlight,
	wantsClearAirFit,
} from "../clear-air";

const withClearAir = (
	c: object,
	extra: DeepPartial<ViewStyle> = {},
): ViewStyle =>
	mergeStyle(
		CLASSIC,
		{ world: { clearAir: c } } as DeepPartial<ViewStyle>,
		extra,
	);

const SUN: Vec3 = [0, 0, 1];
const PHOTO = { eyeAlt: 1000, dir: [0, 1, 0] as Vec3 };

describe("clearAirOn / wantsClearAirFit", () => {
	it("is off for mode off or amount 0", () => {
		expect(clearAirOn(withClearAir({ mode: "off" }))).toBe(false);
		expect(clearAirOn(withClearAir({ mode: "consistent", amount: 0 }))).toBe(
			false,
		);
		expect(clearAirOn(withClearAir({ mode: "consistent", amount: 0.5 }))).toBe(
			true,
		);
	});
	it("only the fitted mode with amount asks for a haze fit", () => {
		expect(
			wantsClearAirFit(withClearAir({ mode: "fitted", amount: 0.5 })),
		).toBe(true);
		expect(wantsClearAirFit(withClearAir({ mode: "fitted", amount: 0 }))).toBe(
			false,
		);
		expect(
			wantsClearAirFit(withClearAir({ mode: "consistent", amount: 0.5 })),
		).toBe(false);
	});
});

describe("clearAirValues", () => {
	it("is the off block when disabled", () => {
		expect(
			clearAirValues(withClearAir({ mode: "off" }), null, SUN, PHOTO),
		).toBe(CLEAR_AIR_OFF);
		expect(CLEAR_AIR_OFF.amount).toBe(0);
	});
	it("classic haze: flat layers, no Mie, floor raised to 1 - hazeMax", () => {
		const s = withClearAir({ mode: "consistent", amount: 1, floor: 0.1 });
		const v = clearAirValues(s, null, SUN, PHOTO);
		expect(v.betaR).toEqual([
			s.terrain.hazeDensity,
			s.terrain.hazeDensity,
			s.terrain.hazeDensity,
		]);
		expect(v.betaM).toBe(0);
		expect(v.h[0]).toBeGreaterThan(1e8);
		expect(v.amount).toBe(1);
		expect(v.floor).toBeCloseTo(1 - s.terrain.hazeMax, 12);
		// a higher user floor wins
		expect(
			clearAirValues(
				withClearAir({ mode: "consistent", amount: 1, floor: 0.5 }),
				null,
				SUN,
				PHOTO,
			).floor,
		).toBe(0.5);
	});
	it("a good fit supplies its own airlight and extinction, scaled by its strength", () => {
		const base = defaultAtmosphere(SUN);
		const fit = {
			...base,
			airlight: [0.4, 0.5, 0.6] as Vec3,
			strength: 2,
			quality: 0.9,
		};
		const v = clearAirValues(
			withClearAir({ mode: "fitted", amount: 0.7, floor: 0.2 }),
			fit,
			SUN,
			PHOTO,
		);
		expect(v.airlight).toEqual([0.4, 0.5, 0.6]);
		expectArrayClose(v.betaR, [
			base.betaR[0] * 2,
			base.betaR[1] * 2,
			base.betaR[2] * 2,
		]);
		expect(v.betaM).toBeCloseTo(base.betaM * 2, 15);
		expect(v.h).toEqual([base.hR, base.hM]);
		expect([v.amount, v.floor]).toEqual([0.7, 0.2]);
	});
	it("a weak fit falls back to the render's own model", () => {
		const base = defaultAtmosphere(SUN);
		const fit = { ...base, airlight: [0.4, 0.5, 0.6] as Vec3, quality: 0.1 };
		const v = clearAirValues(
			withClearAir({ mode: "fitted", amount: 1, floor: 0.1 }),
			fit,
			SUN,
			PHOTO,
		);
		expect(v.airlight).not.toEqual([0.4, 0.5, 0.6]);
		expect(v.betaM).toBe(0);
	});
	it("a physical-atmosphere style uses the physical extinction with altitude layers", () => {
		const s = withClearAir(
			{ mode: "consistent", amount: 1, floor: 0.1 },
			{ terrain: { atmosphere: { mode: "physical" } } },
		);
		const v = clearAirValues(s, null, SUN, PHOTO);
		expect(v.h).toEqual([8000, 1200]);
		expect(v.betaM).toBeGreaterThan(0);
		expect(v.airlight.every((x) => x >= 0 && Number.isFinite(x))).toBe(true);
	});
});

describe("clearAirPixel", () => {
	const eye: Vec3 = [0, 0, 800];
	const far: Vec3 = [25000, 6000, 1500];
	const params = {
		...defaultAtmosphere(SUN),
		betaR: [2e-5, 3e-5, 5e-5] as Vec3,
		airlight: [0.6, 0.68, 0.8] as Vec3,
	};
	const values = (amount: number, floor = 0.05) => ({
		airlight: params.airlight,
		betaR: params.betaR,
		h: [params.hR, params.hM] as [number, number],
		betaM: params.betaM,
		amount,
		floor,
	});

	it("amount 0 returns the input untouched", () => {
		const pc: Vec3 = [0.3, 0.4, 0.5];
		expect(clearAirPixel(CLEAR_AIR_OFF, pc, far, eye)).toBe(pc);
		expect(clearAirPixel(values(0), pc, far, eye)).toBe(pc);
	});
	it("inverts Koschmieder's law: hazing a ground colour then clearing it recovers it", () => {
		const t = transmittance(params, eye, far);
		const J: Vec3 = [0.2, 0.35, 0.1];
		const I = J.map(
			(j, i) => j * t[i] + params.airlight[i] * (1 - t[i]),
		) as Vec3;
		// the veiled colour is lighter than the ground colour towards the airlight
		expect(I[0]).toBeGreaterThan(J[0]);
		expectArrayClose(clearAirPixel(values(1), I, far, eye), J, 1e-6);
	});
	it("amount blends linearly between the photo sample and the corrected one", () => {
		const pc: Vec3 = [0.55, 0.6, 0.7];
		const full = clearAirPixel(values(1), pc, far, eye);
		const half = clearAirPixel(values(0.5), pc, far, eye);
		for (let i = 0; i < 3; i++)
			expect(half[i]).toBeCloseTo((pc[i] + full[i]) / 2, 12);
	});
	it("output is clamped to [0, 1] and the floor caps the gain", () => {
		const out = clearAirPixel(values(1), [0, 0, 0], far, eye);
		for (const c of out) {
			expect(c).toBeGreaterThanOrEqual(0);
			expect(c).toBeLessThanOrEqual(1);
		}
		// at a nearby point (t≈1) clearing is nearly the identity
		const near: Vec3 = [50, 0, 800];
		expectArrayClose(
			clearAirPixel(values(1), [0.3, 0.4, 0.5], near, eye),
			[0.3, 0.4, 0.5],
			1e-3,
		);
		// a huge floor limits how far a far sample is pushed from its input
		const strict = clearAirPixel(values(1, 1), [0.55, 0.6, 0.7], far, eye);
		const loose = clearAirPixel(values(1, 0.01), [0.55, 0.6, 0.7], far, eye);
		const d = (o: Vec3) => Math.abs(o[0] - 0.55);
		expect(d(strict)).toBeLessThanOrEqual(d(loose) + 1e-12);
	});
});

describe("physAirlight", () => {
	const p = {
		...defaultAtmosphere(SUN),
		h: [8000, 1200] as [number, number],
	};
	it("is finite and non-negative in every direction and altitude", () => {
		for (const alt of [0, 800, 3000, 9000])
			for (const dir of [
				[0, 1, 0],
				[0, 0, 1],
				[1, 0, 0],
				[0, -1, 0],
				[0, 0, -1],
			] as Vec3[])
				for (const c of physAirlight(p, alt, dir)) {
					expect(Number.isFinite(c)).toBe(true);
					expect(c).toBeGreaterThanOrEqual(0);
				}
	});
	it("a night sun leaves only the dim sky ambient (no single-scatter sun term)", () => {
		const night = { ...p, sunDir: [0, 0, -1] as Vec3 };
		const noon = physAirlight(p, 1000, [0, 1, 0]);
		const dark = physAirlight(night, 1000, [0, 1, 0]);
		for (let i = 0; i < 3; i++) expect(dark[i]).toBeLessThan(noon[i]);
	});
	it("looking towards the sun is brighter than away from it (forward Mie lobe)", () => {
		const sunLow = { ...p, sunDir: [0, 1, 0.3] as Vec3 };
		const toward = physAirlight(sunLow, 500, [0, 1, 0.3]);
		const away = physAirlight(sunLow, 500, [0, -1, 0.3]);
		expect(toward[1]).toBeGreaterThan(away[1]);
	});
});
