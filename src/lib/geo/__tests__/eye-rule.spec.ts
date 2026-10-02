// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { seededRandom } from "#/test/helpers";
import {
	ALTITUDE_CHECK,
	checkAltitude,
	EYE_ABOVE_GROUND,
	EYE_NO_ALTITUDE_ABOVE_GROUND,
	eyeAltitude,
} from "../eye-rule";

describe("eyeAltitude", () => {
	it("keeps a GPS altitude above standing height", () => {
		expect(eyeAltitude(1250, 1200)).toBe(1250);
	});

	it("lifts an underground altitude to ground + 1.6 m", () => {
		expect(eyeAltitude(1180, 1200)).toBe(1200 + EYE_ABOVE_GROUND);
		// a 0 m "no fix" sentinel and a below-sea-level ref stay harmless
		expect(eyeAltitude(0, 1200)).toBe(1201.6);
		expect(eyeAltitude(-50, 1200)).toBe(1201.6);
	});

	it("stands 1.8 m on the DEM without an altitude, or the given height", () => {
		expect(eyeAltitude(null, 1000)).toBe(1000 + EYE_NO_ALTITUDE_ABOVE_GROUND);
		expect(eyeAltitude(undefined, 1000)).toBe(1001.8);
		expect(eyeAltitude(null, 1000, EYE_ABOVE_GROUND)).toBe(1001.6);
	});

	it("never puts the eye below ground + 1.6 m", () => {
		const rnd = seededRandom(7);
		for (let i = 0; i < 500; i++) {
			const g = rnd() * 4000;
			const alt = rnd() < 0.1 ? null : g + (rnd() - 0.5) * 400;
			expect(eyeAltitude(alt, g)).toBeGreaterThanOrEqual(g + EYE_ABOVE_GROUND);
		}
	});

	it("is bit-identical to the removed inline copies and to loadScene", () => {
		const rnd = seededRandom(11);
		for (let i = 0; i < 500; i++) {
			const g = rnd() * 4000;
			const alt = rnd() < 0.2 ? null : g + (rnd() - 0.5) * 100;
			// deck/scene.ts, gpu/eye/suggest.ts, roll/mosaic/ridgelines.worker.ts before 2026-10-02
			const old = alt != null ? Math.max(alt, g + 1.6) : g + 1.8;
			expect(eyeAltitude(alt, g)).toBe(old);
			// geo/pipeline.ts loadScene
			const scene = Math.max(alt ?? g, g + 1.6);
			expect(eyeAltitude(alt, g, EYE_ABOVE_GROUND)).toBe(scene);
		}
	});

	it("passes a missing DEM through as NaN", () => {
		expect(eyeAltitude(1200, Number.NaN)).toBeNaN();
	});
});

describe("checkAltitude", () => {
	const g = 1950;
	it("reports a missing altitude", () => {
		const c = checkAltitude(null, g);
		expect(c.verdict).toBe("missing");
		expect(c.excessM).toBeNaN();
		expect(c.eye).toBe(g + 1.8);
	});

	it("reports the floor winning", () => {
		const c = checkAltitude(g - 20, g);
		expect(c.verdict).toBe("underground");
		expect(c.excessM).toBeCloseTo(-21.6, 9);
		expect(c.eye).toBe(g + 1.6);
	});

	it("calls GPS noise standing and a big lift raised or high", () => {
		expect(checkAltitude(g + 1.6 + 10, g).verdict).toBe("standing");
		expect(
			checkAltitude(g + 1.6 + ALTITUDE_CHECK.standingM + 5, g).verdict,
		).toBe("raised");
		expect(checkAltitude(g + 1.6 + ALTITUDE_CHECK.highM + 1, g).verdict).toBe(
			"high",
		);
	});

	it("flags a geoid-sized lift on an Android model only", () => {
		const alt = g + 1.6 + 49;
		const o = { geoidN: 48.5 };
		expect(checkAltitude(alt, g, { ...o, model: "Pixel 8" }).verdict).toBe(
			"ellipsoid-suspect",
		);
		expect(
			checkAltitude(alt, g, { ...o, model: "iPhone 15 Pro" }).verdict,
		).toBe("raised");
		expect(checkAltitude(alt, g, o).verdict).toBe("raised");
		expect(
			checkAltitude(g + 1.6 + 120, g, { ...o, model: "SM-S918B" }).verdict,
		).toBe("raised");
	});

	it("returns the eye the rule uses", () => {
		expect(checkAltitude(g + 30, g).eye).toBe(g + 30);
	});
});
