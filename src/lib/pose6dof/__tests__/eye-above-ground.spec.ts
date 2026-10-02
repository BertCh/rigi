// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// CR-15: refineEyeFromSkyline's LM objective carries the above-ground (AGL) prior and a
// below-floor row, so the LM optimises what the grid and the final pick score.

import { describe, expect, it } from "vitest";
import type { Pose } from "../../camera";
import { refineEyeFromSkyline, type SkylineSample, type Vec3 } from "../eye";
import { ridgeHorizon } from "../eye.check";
import { dirFromAzEl, project } from "../project";

const ASPECT = 4 / 3;
const H = 600;
const truth: Pose = { yaw: 2, pitch: 4, roll: 1, vfov: 50 };
const base = { aspect: ASPECT, imageHeight: H, sigmaH: 20 };

/** Skyline of the synthetic ridge seen from `eye`, projected under `pose`. */
function observe(eye: Vec3, pose: Pose): SkylineSample[] {
	const h = ridgeHorizon(eye);
	const out: SkylineSample[] = [];
	for (let az = -40; az <= 40; az += 0.2) {
		const a = (az + 360) % 360;
		const e = h.elevation[Math.round(a / h.step) % h.elevation.length];
		if (e <= -89) continue;
		const p = project(pose, ASPECT, [0, 0, 0], { dir: dirFromAzEl(a, e) });
		if (p && p.u > 0 && p.u < 1 && p.v > 0 && p.v < 1)
			out.push({ u: p.u, v: p.v, w: 1 });
	}
	return out;
}

describe("refineEyeFromSkyline above-ground rows (CR-15)", () => {
	it("a tight AGL prior shapes the LM result instead of only rejecting it", async () => {
		// The eye is truly 40 m up; it starts 1.6 m over flat ground with a σ 0.5 m AGL prior.
		// Before CR-15 the LM ignored the prior, climbed towards 40 m and was rejected, leaving the
		// refined eye at the start; now the LM settles a little above the nominal height.
		const r = await refineEyeFromSkyline(
			observe([0, 0, 41.6], truth),
			truth,
			[0, 0, 1.6],
			ridgeHorizon,
			{
				...base,
				ground: () => 0,
				grid: false,
				aboveGround: { height: 1.6, sigma: 0.5 },
			},
		);
		expect(r.refinedAboveGroundM).toBeGreaterThan(1.8);
		expect(r.refinedAboveGroundM).toBeLessThan(5);
	});

	it("the default prior keeps the eye under the cap without leaning on the clamp", async () => {
		const r = await refineEyeFromSkyline(
			observe([0, 0, 41.6], truth),
			truth,
			[0, 0, 1.6],
			ridgeHorizon,
			{ ...base, ground: () => 0, grid: false },
		);
		expect(r.refinedAboveGroundM).toBeGreaterThan(1.6);
		expect(r.refinedAboveGroundM).toBeLessThan(10);
	});

	it("leaves a run that stays above ground unchanged", async () => {
		// Ground far below the eye: both rows are 0 everywhere, so an inactive AGL prior gives the
		// same eye and rotation as no AGL prior at all.
		const obs = observe([30, -20, 115], truth);
		const start: Pose = { ...truth, yaw: truth.yaw + 0.8 };
		const opts = { ...base, ground: () => -5000 };
		const off = await refineEyeFromSkyline(
			obs,
			start,
			[0, 0, 100],
			ridgeHorizon,
			{
				...opts,
				aboveGround: false,
			},
		);
		const inactive = await refineEyeFromSkyline(
			obs,
			start,
			[0, 0, 100],
			ridgeHorizon,
			{ ...opts, aboveGround: { height: 1e5, max: 1e6 } },
		);
		expect(inactive.refinedEye).toEqual(off.refinedEye);
		expect(inactive.pose).toEqual(off.pose);
		expect(inactive.sigma).toEqual(off.sigma);
		// …and the same eye as a run without a DEM (the rows add no pull).
		const noDem = await refineEyeFromSkyline(
			obs,
			start,
			[0, 0, 100],
			ridgeHorizon,
			base,
		);
		expect(noDem.refinedEye).toEqual(off.refinedEye);
	});

	it("never returns an eye below the floor when the skyline pulls it down", async () => {
		// The skyline was seen from 50 m; the ground is at 90 m, so the data pull through it.
		const r = await refineEyeFromSkyline(
			observe([0, 0, 50], truth),
			truth,
			[0, 0, 100],
			ridgeHorizon,
			{ ...base, ground: () => 90, aboveGround: false, sigmaV: 200 },
		);
		expect(r.refinedEye[2]).toBeGreaterThanOrEqual(90 + 1.5 - 1e-9);
		expect(r.eye[2]).toBeGreaterThanOrEqual(90 + 1.5 - 1e-9);
	});
});
