// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { type Pin, solvePins } from "#/lib/align";
import { type Pose, projectPoint } from "#/lib/camera";
import { angleDiffDeg, seededRandom } from "#/test/helpers";
import { pinResidualsPx } from "../diagnostics";
import {
	seedPinPose,
	solvePinsSeeded,
	VFOV_MAX,
	VFOV_MIN,
	vfovFromPair,
} from "../seed";

const eye = [0, 0, 1200];
const W = 4000;
const H = 3000;
const asp = W / H;

/** summits at fixed bearings / elevations from the eye, 5–25 km out */
const summit = (
	azDeg: number,
	elDeg: number,
	km: number,
): [number, number, number] => {
	const a = (azDeg * Math.PI) / 180;
	const e = (elDeg * Math.PI) / 180;
	const r = km * 1000;
	return [
		eye[0] + r * Math.cos(e) * Math.sin(a),
		eye[1] + r * Math.cos(e) * Math.cos(a),
		eye[2] + r * Math.sin(e),
	];
};
const tapsUnder = (truth: Pose, worlds: [number, number, number][]): Pin[] =>
	worlds.map((w) => {
		const q = projectPoint(truth, asp, eye, w);
		if (!q) throw new Error("test summit behind the camera");
		return { world: w, u: q.u, v: q.v };
	});

const truth: Pose = { yaw: 140, pitch: 3, roll: 1.2, vfov: 45 };
const worlds = [
	summit(128, 4, 12),
	summit(150, 6, 8),
	summit(137, 2.5, 20),
	summit(158, 3.5, 15),
];

describe("vfovFromPair", () => {
	it("recovers the lens from two taps without any rotation", () => {
		const [a, , , d] = tapsUnder(truth, worlds);
		expect(vfovFromPair(a, d, eye, asp, 50)).toBeCloseTo(45, 1);
	});
	it("is null when no lens in range fits (a wrong name behind the eye)", () => {
		const [a, b] = tapsUnder(truth, worlds);
		const wrong = { ...b, world: summit(310, 6, 8) };
		expect(vfovFromPair(a, wrong, eye, asp, 50)).toBeNull();
	});
});

describe("seedPinPose", () => {
	it("TRIAD seed is exact for two noiseless pins at the true lens", () => {
		const s = seedPinPose(
			{ ...truth, yaw: 300, pitch: -20, roll: 10 },
			asp,
			eye,
			tapsUnder(truth, worlds.slice(0, 2)),
		);
		expect(angleDiffDeg(s.yaw, truth.yaw)).toBeLessThan(1e-6);
		expect(s.pitch).toBeCloseTo(truth.pitch, 6);
		expect(s.roll).toBeCloseTo(truth.roll, 6);
		expect(s.vfov).toBe(truth.vfov);
	});
	it("three pins also seed the lens", () => {
		const s = seedPinPose(
			{ ...truth, yaw: 0, vfov: 60 },
			asp,
			eye,
			tapsUnder(truth, worlds.slice(0, 3)),
		);
		expect(s.vfov).toBeCloseTo(45, 1);
		expect(angleDiffDeg(s.yaw, truth.yaw)).toBeLessThan(0.05);
	});
	it("one pin turns yaw / pitch towards the summit and keeps roll and vfov", () => {
		const prior = { ...truth, yaw: truth.yaw + 170 };
		const s = seedPinPose(
			prior,
			asp,
			eye,
			tapsUnder(truth, worlds.slice(0, 1)),
		);
		expect(s.roll).toBe(prior.roll);
		expect(s.vfov).toBe(prior.vfov);
		expect(angleDiffDeg(s.yaw, truth.yaw)).toBeLessThan(0.5);
		// and the tap ray then lands on the summit: inside solvePins' basin
		const r = solvePins(
			s,
			asp,
			eye,
			tapsUnder(truth, worlds.slice(0, 1)),
			W,
			H,
		);
		expect(angleDiffDeg(r.yaw, truth.yaw)).toBeLessThan(0.01);
	});
	it("a degenerate pair (same pixel) falls back to the one-pin seed", () => {
		const [a] = tapsUnder(truth, worlds);
		const s = seedPinPose({ ...truth, yaw: 0 }, asp, eye, [a, { ...a }]);
		for (const v of Object.values(s)) expect(Number.isFinite(v)).toBe(true);
	});
});

describe("solvePinsSeeded", () => {
	it("returns the prior without pins", () => {
		const r = solvePinsSeeded(truth, asp, eye, [], W, H);
		expect(r.pose).toBe(truth);
		expect(r.seeded).toBe(false);
	});
	it("gives solvePins' own answer when the start already converges", () => {
		const pins = tapsUnder(truth, worlds.slice(0, 2));
		const prior = { ...truth, yaw: truth.yaw - 5, roll: 0 };
		const r = solvePinsSeeded(prior, asp, eye, pins, W, H);
		const plain = solvePins(prior, asp, eye, pins, W, H);
		if (!r.seeded) expect(r.pose).toEqual(plain);
		expect(r.rmsPx).toBeLessThan(0.5);
	});
	it("solves from starts where solvePins fails (behind the camera, far off)", () => {
		const rnd = seededRandom(11);
		let plainOk = 0;
		let seededOk = 0;
		const trials = 60;
		for (let k = 0; k < trials; k++) {
			const n = 1 + (k % 3);
			const pins = tapsUnder(truth, worlds.slice(0, n + (n === 3 ? 1 : 0)));
			const prior: Pose = {
				yaw: truth.yaw + 60 + rnd() * 120, // 60–180° off
				pitch: truth.pitch + (rnd() - 0.5) * 10,
				roll: n === 1 ? truth.roll : (rnd() - 0.5) * 6,
				vfov: n >= 3 ? 40 + rnd() * 15 : truth.vfov,
			};
			const plain = solvePins(prior, asp, eye, pins, W, H);
			const s = solvePinsSeeded(prior, asp, eye, pins, W, H);
			const ok = (p: Pose) =>
				Math.max(...pinResidualsPx(p, asp, eye, pins, W, H)) < 2 &&
				angleDiffDeg(p.yaw, truth.yaw) < 0.1;
			if (ok(plain)) plainOk++;
			if (ok(s.pose)) seededOk++;
			expect(s.pose.vfov).toBeGreaterThanOrEqual(VFOV_MIN);
			expect(s.pose.vfov).toBeLessThanOrEqual(VFOV_MAX);
		}
		expect(seededOk).toBe(trials);
		expect(plainOk).toBeLessThan(trials / 2);
	});
	it("never leaves the lens bound, even with a wrong name among three", () => {
		const pins = tapsUnder(truth, worlds.slice(0, 3));
		pins[1] = { ...pins[1], world: summit(175, 1, 9) };
		const r = solvePinsSeeded(
			{ ...truth, yaw: truth.yaw + 70 },
			asp,
			eye,
			pins,
			W,
			H,
		);
		expect(r.pose.vfov).toBeGreaterThanOrEqual(VFOV_MIN);
		expect(r.pose.vfov).toBeLessThanOrEqual(VFOV_MAX);
		expect(r.rmsPx).toBeGreaterThan(20); // the misfit stays visible for the caller
	});
});
