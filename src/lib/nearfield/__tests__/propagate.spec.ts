// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { angleDiffDeg, seededRandom, uniform } from "#/test/helpers";
import type { Pose } from "../../camera";
import {
	type Mat3,
	mul3,
	overlapFraction,
	PROPAGATE_GATE,
	poseToR,
	proposePose,
	relRFromPoses,
	rotAngleDeg,
	rToPose,
	transpose3,
} from "../propagate";

const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const pose = (yaw: number, pitch = 0, roll = 0, vfov = 60): Pose => ({
	yaw,
	pitch,
	roll,
	vfov,
});

describe("pose <-> rotation", () => {
	it("round-trips random poses", () => {
		const r = seededRandom(3);
		for (let i = 0; i < 100; i++) {
			const p = pose(
				uniform(r, 0, 360),
				uniform(r, -80, 80),
				uniform(r, -60, 60),
				55,
			);
			const back = rToPose(poseToR(p), 55);
			expect(angleDiffDeg(back.yaw, p.yaw)).toBeCloseTo(0, 6);
			expect(back.pitch).toBeCloseTo(p.pitch, 6);
			expect(back.roll).toBeCloseTo(p.roll, 6);
			expect(back.vfov).toBe(55);
		}
	});
	it("poseToR yields a proper rotation (R R^T = I, det = 1)", () => {
		const R = poseToR(pose(123, 17, -9));
		const I = mul3(R, transpose3(R));
		for (const [k, v] of I.entries()) expect(v).toBeCloseTo(IDENTITY[k], 12);
		const det =
			R[0] * (R[4] * R[8] - R[5] * R[7]) -
			R[1] * (R[3] * R[8] - R[5] * R[6]) +
			R[2] * (R[3] * R[7] - R[4] * R[6]);
		expect(det).toBeCloseTo(1, 12);
	});
	it("a camera facing north has the forward row on +y (ENU)", () => {
		const R = poseToR(pose(0));
		expect(R[6]).toBeCloseTo(0, 12);
		expect(R[7]).toBeCloseTo(1, 12);
		expect(R[0]).toBeCloseTo(1, 12); // right = +east
	});
	it("rotAngleDeg of a pure yaw difference equals the yaw difference", () => {
		expect(rotAngleDeg(relRFromPoses(pose(10), pose(40)))).toBeCloseTo(30, 9);
		expect(rotAngleDeg(IDENTITY)).toBe(0);
		expect(rotAngleDeg(relRFromPoses(pose(350), pose(10)))).toBeCloseTo(20, 9);
	});
});

describe("overlapFraction", () => {
	const cam = { vfov: 60, aspect: 4 / 3 };
	it("is 1 for identical cameras and 0 when facing away", () => {
		expect(overlapFraction(IDENTITY, cam, cam)).toBe(1);
		expect(overlapFraction(relRFromPoses(pose(0), pose(180)), cam, cam)).toBe(
			0,
		);
	});
	it("falls monotonically as the yaw offset grows", () => {
		let prev = 2;
		for (const dy of [0, 10, 25, 40, 60, 90]) {
			const f = overlapFraction(relRFromPoses(pose(0), pose(dy)), cam, cam);
			expect(f).toBeLessThanOrEqual(prev);
			prev = f;
		}
		expect(prev).toBe(0);
	});
	it("a wider target sees all of a narrower anchor", () => {
		expect(
			overlapFraction(
				IDENTITY,
				{ vfov: 40, aspect: 1.5 },
				{ vfov: 90, aspect: 1.5 },
			),
		).toBe(1);
	});
});

describe("proposePose + gate", () => {
	const anchor = pose(100, 5, 0, 60);
	const good = { method: "rot" as const, inliers: 200, rmsPx: 1.2 };
	const aspects = { a: 4 / 3, b: 4 / 3 };
	// target is the anchor yawed by +20 degrees
	const target = pose(120, 5, 0, 60);
	const relR = relRFromPoses(anchor, target);

	it("recovers the target pose and passes the gate on clean evidence", () => {
		const s = proposePose(anchor, relR, 60, aspects, good);
		expect(s.kind).toBe("suggestion");
		expect(angleDiffDeg(s.pose.yaw, 120)).toBeCloseTo(0, 6);
		expect(s.pose.pitch).toBeCloseTo(5, 6);
		expect(s.gated).toBe(true);
		expect(s.reasons).toEqual([]);
		expect(s.seedRadiusDeg).toBe(PROPAGATE_GATE.seedRadiusDeg);
	});
	it("fails closed when inliers / rms are missing", () => {
		const s = proposePose(anchor, relR, 60, aspects, { method: "rot" });
		expect(s.gated).toBe(false);
		expect(s.reasons.join(" ")).toMatch(/inliers \? < 40/);
		expect(s.reasons.join(" ")).toMatch(/rms \? >/);
	});
	it.each([
		["low inliers", { inliers: 39 }, /inliers 39/],
		["high rms", { rmsPx: 3.6 }, /rms 3\.60/],
		["fwd/bwd", { fwdBwdDeg: 1.6 }, /fwd\/bwd/],
		["cycle", { cycleDeg: 2 }, /cycle/],
		["baseline", { baselineM: 300 }, /baseline 300 m/],
		[
			"untrusted method",
			{ method: "homography" as never },
			/method homography/,
		],
		["gravity pitch", { gravity: { pitch: 15, roll: 0 } }, /gravity pitch/],
		["gravity roll", { gravity: { pitch: 5, roll: 10 } }, /gravity roll/],
	])("rejects on %s", (_name, extra, re) => {
		const s = proposePose(anchor, relR, 60, aspects, { ...good, ...extra });
		expect(s.gated).toBe(false);
		expect(s.reasons.join(" ")).toMatch(re);
	});
	it("accepts values exactly at the thresholds", () => {
		const s = proposePose(anchor, relR, 60, aspects, {
			method: "rot",
			inliers: PROPAGATE_GATE.minInliers,
			rmsPx: PROPAGATE_GATE.maxRmsPx,
			fwdBwdDeg: PROPAGATE_GATE.maxFwdBwdDeg,
			cycleDeg: PROPAGATE_GATE.maxCycleDeg,
			baselineM: PROPAGATE_GATE.maxBaselineM,
		});
		expect(s.gated).toBe(true);
	});
	it("rejects a non-overlapping pair", () => {
		const far = relRFromPoses(anchor, pose(280, 5, 0, 60));
		const s = proposePose(anchor, far, 60, aspects, good);
		expect(s.overlap).toBe(0);
		expect(s.gated).toBe(false);
		expect(s.reasons.join(" ")).toMatch(/overlap 0\.00/);
	});
	it("gravity roll compares across the +-180 wrap", () => {
		const t = pose(120, 5, 179, 60);
		const r = relRFromPoses(anchor, t);
		const s = proposePose(anchor, r, 60, aspects, {
			...good,
			gravity: { pitch: 5, roll: -179 },
		});
		expect(s.reasons.join(" ")).not.toMatch(/gravity roll/);
	});
});
