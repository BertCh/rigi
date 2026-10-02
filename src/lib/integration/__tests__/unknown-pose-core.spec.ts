// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import type { UnknownPosePrepare, UnknownPoseRequest } from "../unknown-pose";
import { fusedFor, options, UNKNOWN_POSE_DEM } from "../unknown-pose-core";

describe("options (which unknowns are freed)", () => {
	it("keeps tight priors and no overrides when yaw and gravity are known", () => {
		const o = options(true, true);
		expect(o.solve.sigma).toEqual({
			yaw: 15,
			pitch: 1.5,
			roll: 1.5,
			focal: 0.06,
		});
		expect(o.solve.headingKnown).toBeUndefined();
		expect(o.solve.pitchRange).toBeUndefined();
		expect(o.solve.yawRange).toBeUndefined();
	});
	it("unknown gravity widens pitch/roll everywhere and leaves yaw alone", () => {
		const o = options(true, false);
		expect(o.solve.pitchRange).toBe(15);
		expect(o.solve.tiltGate).toBe(90);
		expect(o.solve.sigma?.pitch).toBe(10);
		expect(o.solve.sigma?.roll).toBe(10);
		expect(o.refine.init?.pitchSigmaDeg).toBe(10);
		expect(o.refine.init?.rollSigmaDeg).toBe(10);
		expect(o.refine.robust?.priorSigma?.pitchDeg).toBe(10);
		expect(o.solve.headingKnown).toBeUndefined();
		expect(o.solve.sigma?.yaw).toBe(15);
	});
	it("unknown yaw searches the full circle with an uninformative yaw prior", () => {
		const o = options(false, true);
		expect(o.solve.headingKnown).toBe(false);
		expect(o.solve.yawRange).toBe(180);
		expect(o.solve.fullSearchFallback).toBe(false);
		expect(o.solve.sigma?.yaw).toBe(1e6);
		expect(o.refine.init?.yawRange).toBe(180);
		expect(o.refine.init?.yawSigmaDeg).toBe(1e6);
		expect(o.refine.robust?.priorSigma?.yawDeg).toBe(1e6);
		expect(o.solve.pitchRange).toBeUndefined();
	});
	it("frees both when both are unknown", () => {
		const o = options(false, false);
		expect(o.solve.yawRange).toBe(180);
		expect(o.solve.pitchRange).toBe(15);
	});
	it("does not mutate the shared default prior sigmas between calls", () => {
		options(false, false);
		const clean = options(true, true);
		expect(clean.refine.robust?.priorSigma?.yawDeg).not.toBe(1e6);
		expect(clean.refine.robust?.priorSigma?.pitchDeg).not.toBe(10);
	});
	it("returns an independent object per call", () => {
		expect(options(true, true)).not.toBe(options(true, true));
		expect(options(true, true).solve.sigma).not.toBe(
			options(true, true).solve.sigma,
		);
	});
});

describe("fusedFor", () => {
	const m = (over: Record<string, unknown>) =>
		over as unknown as UnknownPosePrepare & UnknownPoseRequest;
	it("needs both the GPU horizon and the GPU coarse grid", () => {
		expect(fusedFor(m({ gpu: true, solveGpu: true }))).toBe(true);
		expect(fusedFor(m({ gpu: true }))).toBe(false);
		expect(fusedFor(m({ solveGpu: true }))).toBe(false);
		expect(fusedFor(m({}))).toBe(false);
	});
	it("gpuFused: false opts out, anything else keeps it on", () => {
		expect(fusedFor(m({ gpu: true, solveGpu: true, gpuFused: false }))).toBe(
			false,
		);
		expect(fusedFor(m({ gpu: true, solveGpu: true, gpuFused: true }))).toBe(
			true,
		);
	});
});

describe("UNKNOWN_POSE_DEM", () => {
	it("is the DEM the app draws with (Mapterhorn)", () => {
		expect(UNKNOWN_POSE_DEM.name.toLowerCase()).toContain("mapterhorn");
	});
});
