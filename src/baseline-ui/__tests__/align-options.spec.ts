// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { cameraFromAngles } from "#/lib/geo/camera";
import type { HorizonProfile } from "#/lib/geo/horizon";
import { cascade } from "#/lib/geo/pipeline";
import { FULL_SEARCH_CONFIDENCE, projectSkylineRows } from "#/lib/geo/solve";
import { angleDiffDeg } from "#/test/helpers";
import { applyMinConfidence, baselineAlignOptions } from "../align-options";

/** A synthetic 0.5° panorama with two distinct peaks (as in geo/__tests__/solve.spec.ts). */
function profile(): HorizonProfile {
	const step = 0.5;
	const n = 720;
	const elevation = new Float32Array(n);
	for (let i = 0; i < n; i++) {
		const az = i * step;
		elevation[i] =
			3 +
			2 * Math.sin((az * Math.PI) / 37) +
			1.5 * Math.sin((az * Math.PI) / 11 + 1) +
			9 * Math.exp(-(((az - 150) / 4) ** 2)) +
			6 * Math.exp(-(((az - 175) / 3) ** 2));
	}
	return {
		step,
		elevation,
		distance: new Float32Array(n).fill(5000),
		ridges: Array.from({ length: n }, () => []),
	};
}

const known = { yaw: false, gravity: false, focal: false };

describe("baselineAlignOptions", () => {
	it("all sensors known: the default cascade, no extra bar (unchanged behaviour)", () => {
		expect(baselineAlignOptions(known)).toEqual({
			cascade: {},
			minConfidence: 0,
		});
		expect(baselineAlignOptions()).toEqual({ cascade: {}, minConfidence: 0 });
	});

	it("no heading: a direct 360° solve, a 360° refine init and the 0.75 bar", () => {
		const o = baselineAlignOptions({ ...known, yaw: true });
		expect(o.cascade.solve?.headingKnown).toBe(false);
		expect(o.cascade.solve?.fullSearchFallback).toBe(false);
		expect(o.cascade.refine?.init?.yawRange).toBe(180);
		expect(o.minConfidence).toBe(FULL_SEARCH_CONFIDENCE);
	});

	it("no gravity alone widens pitch and roll but keeps the stages' own bars", () => {
		const o = baselineAlignOptions({ ...known, gravity: true });
		expect(o.cascade.solve?.pitchRange).toBe(15);
		expect(o.cascade.solve?.tiltGate).toBe(90);
		expect(o.cascade.solve?.headingKnown).toBeUndefined();
		expect(o.minConfidence).toBe(0);
	});

	it("no focal length demands the 0.75 bar", () => {
		expect(baselineAlignOptions({ ...known, focal: true }).minConfidence).toBe(
			FULL_SEARCH_CONFIDENCE,
		);
	});
});

describe("applyMinConfidence", () => {
	const r = { accepted: true, confidence: 0.6, rejectReason: undefined };
	it("turns an accept below the bar into a low-confidence reject", () => {
		expect(applyMinConfidence(r, 0.75)).toEqual({
			accepted: false,
			confidence: 0.6,
			rejectReason: "low-confidence",
		});
	});
	it("returns the result itself at or above the bar, and for a reject", () => {
		expect(applyMinConfidence(r, 0.6)).toBe(r);
		expect(applyMinConfidence(r, 0)).toBe(r);
		const rejected = { accepted: false, confidence: 0.9, rejectReason: "tilt" };
		expect(applyMinConfidence(rejected, 0.75)).toBe(rejected);
	});
});

describe("no-heading cascade on a synthetic panorama", () => {
	const h = profile();
	const scene = (trueYaw: number) => {
		const truth = cameraFromAngles({
			width: 400,
			height: 300,
			f: 420,
			yaw: trueYaw,
			pitch: 1,
			roll: 0,
		});
		const rows = projectSkylineRows(truth, h, 400);
		const weight = new Float32Array(400).map((_, x) =>
			Number.isFinite(rows[x]) ? 1 : 0,
		);
		// a prior with gravity but a made-up north heading
		const prior = cameraFromAngles({ ...truth, yaw: 0, pitch: 0 });
		return { prior, sky: { width: 400, height: 300, rows, weight } };
	};
	const run = (trueYaw: number) => {
		const { prior, sky } = scene(trueYaw);
		const { cascade: opts, minConfidence } = baselineAlignOptions({
			...known,
			yaw: true,
		});
		return applyMinConfidence(cascade(prior, h, sky, opts), minConfidence);
	};

	it("finds a yaw 160° from the prior and clears the 0.75 bar", () => {
		const r = run(160);
		expect(r.accepted).toBe(true);
		expect(r.confidence).toBeGreaterThanOrEqual(FULL_SEARCH_CONFIDENCE);
		expect(angleDiffDeg(r.camera.yaw, 160)).toBeLessThan(0.2);
	});

	// The trap: the default options (the old /baseline call) accept these 140° off, from refine's ±30°
	// search around north at its 0.5 bar. With the unknown-heading options no accept is wrong.
	it.each([100, 250])("never accepts a wrong yaw (truth %i°)", (trueYaw) => {
		const { prior, sky } = scene(trueYaw);
		const old = cascade(prior, h, sky, {});
		expect(old.accepted && angleDiffDeg(old.camera.yaw, trueYaw) > 90).toBe(
			true,
		);
		const r = run(trueYaw);
		expect(!r.accepted || angleDiffDeg(r.camera.yaw, trueYaw) < 0.5).toBe(true);
	});
});
