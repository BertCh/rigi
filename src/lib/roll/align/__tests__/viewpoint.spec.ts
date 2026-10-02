// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { setFlagOverride } from "#/lib/flags";
import { headingDeclination } from "#/lib/geocam/priors/heading";
import type { PhotoMeta } from "../../../photos";
import {
	type Anchor,
	anchorOf,
	angDiff,
	BIAS_WINDOW_S,
	biasedPrior,
	biasWindowS,
	compassHeading,
	hasCompass,
	MAX_BIAS_DEG,
	MIN_BIAS_DEG,
	viewpointBias,
} from "../viewpoint";

const meta = (heading: number | null, local?: object) =>
	({ id: "p", heading, ...(local ? { local } : {}) }) as unknown as PhotoMeta;
const anchor = (
	id: string,
	viewpoint: number,
	t: number,
	yawOffset: number,
): Anchor => ({
	id,
	viewpoint,
	t,
	yawOffset,
});

describe("angDiff", () => {
	it.each([
		[10, 350, 20],
		[350, 10, -20],
		[90, 90, 0],
		[720 + 5, 3, 2],
		[-170, 170, 20],
	])("%f - %f = %f", (a, b, d) => {
		expect(angDiff(a, b)).toBeCloseTo(d, 9);
	});
	// BUG: the doc comment promises (-180, 180] but a half turn comes out as -180
	it.fails("returns +180 for a half turn, as documented", () => {
		expect(angDiff(180, 0)).toBe(180);
		expect(angDiff(0, 180)).toBe(180);
	});
	it("stays inside [-180, 180]", () => {
		for (let a = -400; a <= 400; a += 37)
			for (let b = -400; b <= 400; b += 41) {
				const d = angDiff(a, b);
				expect(d).toBeGreaterThanOrEqual(-180);
				expect(d).toBeLessThanOrEqual(180);
			}
	});
});

describe("hasCompass and anchorOf", () => {
	it("needs a heading that is not flagged yawUnknown", () => {
		expect(hasCompass(meta(90))).toBe(true);
		expect(hasCompass(meta(0))).toBe(true);
		expect(hasCompass(meta(null))).toBe(false);
		expect(hasCompass(meta(90, { yawUnknown: true }))).toBe(false);
		expect(hasCompass(meta(90, { yawUnknown: false }))).toBe(true);
	});
	it("records the pose-minus-compass offset, wrapped", () => {
		const a = anchorOf(meta(350), 2, 100, {
			yaw: 10,
			pitch: 0,
			roll: 0,
			vfov: 50,
		});
		expect(a).toEqual({ id: "p", viewpoint: 2, t: 100, yawOffset: 20 });
		expect(
			anchorOf(meta(null), 0, 0, { yaw: 1, pitch: 0, roll: 0, vfov: 50 }),
		).toBeNull();
	});
});

describe("compassHeading", () => {
	const magnetic = {
		id: "m",
		heading: 100,
		lat: 46.7,
		lon: 7.7,
		alt: 1500,
		takenAt: "2025-08-01T10:00:00Z",
		local: { headingRef: "M" },
	} as unknown as PhotoMeta;
	it("is the stored heading with geoDecl off, and NaN without one", () => {
		expect(compassHeading(magnetic)).toBe(100);
		expect(compassHeading(meta(null))).toBeNaN();
	});
	it("measures anchors against the declination-corrected heading under geoDecl", () => {
		const d = headingDeclination(magnetic) as number;
		try {
			setFlagOverride("geoDecl", "on");
			expect(compassHeading(magnetic)).toBeCloseTo(100 + d, 9);
			const pose = { yaw: 100 + d + 5, pitch: 0, roll: 0, vfov: 50 };
			// the offset is the true compass error (5°), not error + declination
			expect(anchorOf(magnetic, 0, 0, pose)?.yawOffset).toBeCloseTo(5, 9);
		} finally {
			setFlagOverride("geoDecl", undefined);
		}
	});
});

describe("viewpointBias", () => {
	const anchors = [
		anchor("a", 0, 0, 10),
		anchor("b", 0, 60, 12),
		anchor("c", 0, 120, 40), // an outlier
		anchor("d", 1, 0, -30),
		anchor("far", 0, BIAS_WINDOW_S * 3, 80),
	];
	it("takes the median of the anchors at the viewpoint within the time window", () => {
		expect(viewpointBias(anchors, 0, 30)).toEqual({ biasDeg: 12, n: 3 });
		expect(viewpointBias(anchors, 1, 30)).toEqual({ biasDeg: -30, n: 1 });
	});
	it("averages the middle pair for an even count", () => {
		expect(
			viewpointBias([anchor("a", 0, 0, 10), anchor("b", 0, 0, 20)], 0, 0)
				?.biasDeg,
		).toBe(15);
	});
	it("excludes the photo itself and anchors outside the window", () => {
		expect(viewpointBias(anchors, 0, 30, "b")).toEqual({ biasDeg: 25, n: 2 });
		expect(viewpointBias(anchors, 0, BIAS_WINDOW_S * 3 + 10)?.n).toBe(1);
		expect(viewpointBias(anchors, 2, 0)).toBeNull();
		expect(viewpointBias([], 0, 0)).toBeNull();
	});
	it("refuses a bias beyond MAX_BIAS_DEG", () => {
		expect(
			viewpointBias([anchor("a", 0, 0, MAX_BIAS_DEG + 1)], 0, 0),
		).toBeNull();
		expect(
			viewpointBias([anchor("a", 0, 0, -MAX_BIAS_DEG)], 0, 0)?.biasDeg,
		).toBe(-MAX_BIAS_DEG);
	});
});

describe("bias window", () => {
	const at = [anchor("a", 0, 0, 10), anchor("b", 0, 600, 30)];
	it("narrows the anchors a photo learns from when given a window", () => {
		expect(viewpointBias(at, 0, 590)?.biasDeg).toBe(20); // both within 45 min
		expect(viewpointBias(at, 0, 590, undefined, 60)).toEqual({
			biasDeg: 30,
			n: 1,
		});
		expect(viewpointBias(at, 0, 300, undefined, 60)).toBeNull();
	});
	it("reads ?rollBiasWindow when positive, else BIAS_WINDOW_S", () => {
		try {
			expect(biasWindowS()).toBe(BIAS_WINDOW_S);
			setFlagOverride("rollBiasWindow", "60");
			expect(biasWindowS()).toBe(60);
			for (const bad of ["0", "-5", "abc"]) {
				setFlagOverride("rollBiasWindow", bad);
				expect(biasWindowS()).toBe(BIAS_WINDOW_S);
			}
		} finally {
			setFlagOverride("rollBiasWindow", undefined);
		}
	});
});

describe("biasedPrior", () => {
	const prior = { yaw: 350, pitch: 3, roll: 1, vfov: 55 };
	it("leaves the prior alone for null or tiny biases", () => {
		expect(biasedPrior(prior, null)).toBe(prior);
		expect(biasedPrior(prior, MIN_BIAS_DEG - 0.1)).toBe(prior);
		expect(biasedPrior(prior, -(MIN_BIAS_DEG - 0.1))).toBe(prior);
	});
	it("shifts only the yaw and wraps it into 0..360", () => {
		expect(biasedPrior(prior, 25)).toEqual({ ...prior, yaw: 15 });
		expect(biasedPrior({ ...prior, yaw: 5 }, -20)).toEqual({
			...prior,
			yaw: 345,
		});
	});
});
