// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// CR-50: solvePose6dof's adaptive RANSAC stop uses the inlier ratio of the pool a sampler draws
// from (bearings for rot2 / DLT, finite points for P3P), not of every correspondence kind.

import { describe, expect, it } from "vitest";
import type { Pose } from "../../camera";
import { dirFromAzEl, project } from "../project";
import { solvePose6dof } from "../solve";
import type { Correspondence, Priors, SolveOptions } from "../types";

/** mulberry32, as in src/test/helpers.ts (inlined until that module is committed). */
function seededRandom(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const ASPECT = 1.5;
const W = 1500;
const truth: Pose = { yaw: 40, pitch: 4, roll: 1.5, vfov: 45 };
const priors: Priors = {
	position: { value: [0, 0, 0], sigmaH: 0, sigmaV: 0 },
	yaw: { value: 30, sigma: 30 },
	pitch: { value: 2, sigma: 5 },
	roll: { value: 0, sigma: 5 },
	vfov: { value: 45, sigma: 0 },
};

/** `nDir` direction correspondences (the first `nIn` exact, the rest random pixels) + `nAz` exact azimuths. */
function scene(
	seed: number,
	nDir: number,
	nIn: number,
	nAz: number,
): Correspondence[] {
	const rnd = seededRandom(seed);
	const at = (az: number, el: number) => {
		const d = dirFromAzEl(az, el);
		const p = project(truth, ASPECT, [0, 0, 0], { dir: d });
		if (!p) throw new Error("test scene point behind the camera");
		return { d, p };
	};
	const cs: Correspondence[] = [];
	for (let i = 0; i < nDir; i++) {
		const { d, p } = at(25 + rnd() * 30, rnd() * 12);
		const inlier = i < nIn;
		cs.push({
			kind: "dir",
			u: inlier ? p.u : rnd(),
			v: inlier ? p.v : rnd(),
			dir: [d[0], d[1], d[2]],
		});
	}
	for (let i = 0; i < nAz; i++) {
		const az = 25 + rnd() * 30;
		const { p } = at(az, rnd() * 12);
		cs.push({ kind: "azimuth", u: p.u, v: p.v, az });
	}
	return cs;
}

/** Number of rot2 / rot2f hypotheses the solve generated. */
function rot2Count(cs: Correspondence[], seed: number) {
	let n = 0;
	const opts: SolveOptions = {
		aspect: ASPECT,
		imageWidth: W,
		sigmaPx: 1,
		seed,
		debug: (stage, data) => {
			if (stage === "hypotheses")
				n = (data as { init: string }[]).filter((h) =>
					h.init.startsWith("rot2"),
				).length;
		},
	};
	const r = solvePose6dof(cs, priors, opts);
	return { n, r };
}

describe("solvePose6dof adaptive RANSAC stop (CR-50)", () => {
	it("azimuth inliers do not stop the bearing sampler early", () => {
		// 3 of 10 bearings are inliers (ratio 0.3 → ~73 pairs needed), but 40 exact azimuths would
		// lift an all-kinds ratio to 0.86 and stop at the 12-sample floor. All 45 pairs must be tried.
		for (const seed of [1, 2, 3]) {
			const { n, r } = rot2Count(scene(seed, 10, 3, 40), seed);
			expect(n).toBe(45);
			expect(Math.abs(r.pose.yaw - truth.yaw)).toBeLessThan(0.5);
		}
	});

	it("still stops early when the bearings themselves are clean", () => {
		// 12 exact bearings: C(12,2) = 66 pairs, the stop fires at the 12-sample floor.
		const { n, r } = rot2Count(scene(4, 12, 12, 0), 4);
		expect(n).toBe(12);
		expect(Math.abs(r.pose.yaw - truth.yaw)).toBeLessThan(0.05);
	});
});
