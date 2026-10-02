// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Invariants that tie the three pose representations together: the normalised Pose (camera/index),
// the solvers' pixel Camera (geo/camera) and the export's OpenCV R (poseToOpenCV). Each is checked
// over random poses, including near-gimbal pitch and roll past ±180, so a sign or wrap change in any
// one of them fails here.

import { describe, expect, it } from "vitest";
import { angleDiffDeg, seededRandom, uniform } from "#/test/helpers";
import {
	project as projectPx,
	unproject as unprojectPx,
} from "../../geo/camera";
import {
	cameraToPose,
	isPose,
	type Pose,
	poseBasis,
	poseToCamera,
	poseToOpenCV,
	projectPoint,
	unprojectDir,
} from "../index";

const W = 4032;
const H = 3024;

function randomPose(rand: () => number, pitchMax = 85): Pose {
	return {
		yaw: uniform(rand, -720, 720),
		pitch: uniform(rand, -pitchMax, pitchMax),
		roll: uniform(rand, -179, 179),
		vfov: uniform(rand, 8, 110),
	};
}

describe("isPose", () => {
	it("accepts finite angles with a real lens", () => {
		expect(isPose({ yaw: 400, pitch: -3, roll: 2, vfov: 50 })).toBe(true);
		expect(isPose({ yaw: 0, pitch: 0, roll: 0, vfov: 179.9 })).toBe(true);
	});
	it("rejects NaN, null, strings, sentinels and non-objects", () => {
		const bad: unknown[] = [
			null,
			undefined,
			42,
			"pose",
			{},
			{ yaw: Number.NaN, pitch: 0, roll: 0, vfov: 50 },
			{ yaw: 0, pitch: Number.POSITIVE_INFINITY, roll: 0, vfov: 50 },
			{ yaw: 0, pitch: 0, roll: null, vfov: 50 },
			{ yaw: "10", pitch: 0, roll: 0, vfov: 50 },
			{ yaw: null, pitch: null, roll: null, vfov: 180 },
			{ yaw: 0, pitch: 0, roll: 0, vfov: 0 },
			{ yaw: 0, pitch: 0, roll: 0, vfov: -5 },
		];
		for (const b of bad) expect(isPose(b)).toBe(false);
	});
	it("a JSON round trip of NaN (which becomes null) is rejected", () => {
		const p = JSON.parse(
			JSON.stringify({ yaw: Number.NaN, pitch: 0, roll: 0, vfov: 50 }),
		);
		expect(isPose(p)).toBe(false);
	});
});

describe("Pose ↔ pixel Camera", () => {
	it("round trips for random poses, near-gimbal pitch included", () => {
		const rand = seededRandom(11);
		for (let i = 0; i < 300; i++) {
			const p = randomPose(rand, i < 50 ? 89.5 : 85);
			const back = cameraToPose(poseToCamera(p, W, H));
			expect(back.yaw).toBeGreaterThanOrEqual(0);
			expect(back.yaw).toBeLessThan(360);
			// yaw and roll are ill-conditioned together near the zenith; the basis is what must agree
			if (Math.abs(p.pitch) < 85) {
				expect(angleDiffDeg(back.yaw, p.yaw)).toBeLessThan(1e-7);
				expect(angleDiffDeg(back.roll, p.roll)).toBeLessThan(1e-7);
			}
			expect(back.pitch).toBeCloseTo(p.pitch, 7);
			expect(back.vfov).toBeCloseTo(p.vfov, 9);
			const a = poseBasis(p);
			const b = poseBasis(back);
			for (const k of ["forward", "right", "up"] as const)
				for (let j = 0; j < 3; j++) expect(b[k][j]).toBeCloseTo(a[k][j], 7);
		}
	});
	it("positive roll lifts the horizon on the right of the image (counterclockwise scene)", () => {
		const p: Pose = { yaw: 0, pitch: 0, roll: 10, vfov: 40 };
		const left = projectPoint(p, W / H, [0, 0, 0], [-1000, 10000, 0]);
		const right = projectPoint(p, W / H, [0, 0, 0], [1000, 10000, 0]);
		expect(right?.v).toBeLessThan(0.5);
		expect(left?.v).toBeGreaterThan(0.5);
		const px = projectPx(poseToCamera(p, W, H), [0.1, 1, 0]);
		expect((px as [number, number])[1]).toBeLessThan(H / 2);
	});
	it("roll past ±180 comes back wrapped to (-180, 180]", () => {
		const back = cameraToPose(
			poseToCamera({ yaw: 10, pitch: 5, roll: 190, vfov: 40 }, W, H),
		);
		expect(back.roll).toBeCloseTo(-170, 9);
	});
	it("projects every world direction to the same pixel in both models", () => {
		const rand = seededRandom(23);
		for (let i = 0; i < 200; i++) {
			const p = randomPose(rand);
			const cam = poseToCamera(p, W, H);
			const u = uniform(rand, 0.02, 0.98);
			const v = uniform(rand, 0.02, 0.98);
			const d = unprojectDir(p, W / H, u, v);
			const px = projectPx(cam, d);
			expect(px).not.toBeNull();
			expect((px as [number, number])[0]).toBeCloseTo(u * W, 6);
			expect((px as [number, number])[1]).toBeCloseTo(v * H, 6);
			const back = unprojectPx(cam, u * W, v * H);
			for (let j = 0; j < 3; j++) expect(back[j]).toBeCloseTo(d[j], 9);
		}
	});
});

describe("Pose → OpenCV R (export)", () => {
	it("is a proper rotation that reprojects like projectPoint", () => {
		const rand = seededRandom(5);
		for (let i = 0; i < 200; i++) {
			const p = randomPose(rand);
			const { K, R_cam2enu: R } = poseToOpenCV(p, W, H);
			// det(R) = +1 (a mirrored export would load in COLMAP but put the scene behind the camera)
			const det =
				R[0] * (R[4] * R[8] - R[5] * R[7]) -
				R[1] * (R[3] * R[8] - R[5] * R[6]) +
				R[2] * (R[3] * R[7] - R[4] * R[6]);
			expect(det).toBeCloseTo(1, 12);
			const world = [
				uniform(rand, -5000, 5000),
				uniform(rand, -5000, 5000),
				uniform(rand, -500, 1500),
			];
			const ref = projectPoint(p, W / H, [0, 0, 0], world);
			// camera coords = Rᵀ · world (R maps camera → ENU)
			const c = [0, 1, 2].map(
				(k) => R[k] * world[0] + R[3 + k] * world[1] + R[6 + k] * world[2],
			);
			if (!ref) {
				expect(c[2]).toBeLessThanOrEqual(1e-9);
				continue;
			}
			expect(c[2]).toBeCloseTo(ref.depth, 6);
			expect(K[0] * (c[0] / c[2]) + K[2]).toBeCloseTo(ref.u * W, 5);
			expect(K[4] * (c[1] / c[2]) + K[5]).toBeCloseTo(ref.v * H, 5);
		}
	});
});
