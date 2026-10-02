// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { type Pose, projectPoint } from "#/lib/camera";
import {
	type Candidate,
	DEDUPE_DEG,
	indexNear,
	isAutoHigh,
	nearbyPeaks,
	type PoolPeak,
	poseSepDeg,
	rerankWithTaps,
	TAP_MAX_PX,
	tapResidualPx,
	topDistinct,
} from "../candidates";

const pose = (yaw: number, pitch = 0, roll = 0, vfov = 40): Pose => ({
	yaw,
	pitch,
	roll,
	vfov,
});
const cand = (
	p: Pose,
	rank: number,
	score: number | null = null,
): Candidate => ({
	pose: p,
	score,
	source: "align",
	sourceRank: rank,
});

describe("poseSepDeg", () => {
	it("is zero for identical poses and symmetric", () => {
		const a = pose(30, 5, 1, 40);
		const b = pose(33, 5, 1, 40);
		expect(poseSepDeg(a, a)).toBeCloseTo(0, 6);
		expect(poseSepDeg(a, b)).toBeCloseTo(poseSepDeg(b, a), 9);
	});
	it("equals the yaw difference at level pitch", () => {
		expect(poseSepDeg(pose(10), pose(14))).toBeCloseTo(4, 6);
	});
	it("wraps yaw and roll across 360", () => {
		expect(poseSepDeg(pose(359), pose(1))).toBeCloseTo(2, 6);
		expect(poseSepDeg(pose(0, 0, 359), pose(0, 0, 1))).toBeCloseTo(2, 6);
	});
	it("takes the max of axis, roll and vfov separations", () => {
		expect(poseSepDeg(pose(0, 0, 0, 40), pose(0.1, 0, 0.2, 47))).toBeCloseTo(
			7,
			6,
		);
		expect(poseSepDeg(pose(0, 0, 0, 40), pose(0.1, 0, 9, 41))).toBeCloseTo(
			9,
			6,
		);
	});
});

describe("topDistinct / indexNear", () => {
	it("drops later near-duplicates and keeps the higher-ranked", () => {
		const ranked = [
			cand(pose(0), 0),
			cand(pose(0.2), 1),
			cand(pose(10), 2),
			cand(pose(10.4), 3),
			cand(pose(20), 4),
		];
		const out = topDistinct(ranked);
		expect(out.map((c) => c.sourceRank)).toEqual([0, 2, 4]);
	});
	it("caps at n and handles empty input", () => {
		const ranked = [0, 10, 20, 30].map((y, i) => cand(pose(y), i));
		expect(topDistinct(ranked, 2)).toHaveLength(2);
		expect(topDistinct([])).toEqual([]);
	});
	it("treats exactly DEDUPE_DEG apart as a duplicate", () => {
		const out = topDistinct([cand(pose(0), 0), cand(pose(DEDUPE_DEG), 1)]);
		expect(out).toHaveLength(1);
	});
	it("indexNear finds the basin or returns -1", () => {
		const cs = [cand(pose(0), 0), cand(pose(50), 1)];
		expect(indexNear(cs, pose(50.3))).toBe(1);
		expect(indexNear(cs, pose(25))).toBe(-1);
		expect(indexNear([], pose(0))).toBe(-1);
	});
});

describe("nearbyPeaks", () => {
	const eye: [number, number, number] = [0, 0, 0];
	// yaw 0 looks north (+y); a summit 10 km north at the eye height sits at the image centre
	const mk = (
		name: string,
		x: number,
		y: number,
		z: number,
		prominence: number | null = null,
	): PoolPeak => ({
		name,
		ele: null,
		prominence,
		world: [x, y, z],
	});
	it("returns the summit under the tap, nearest first, within the window", () => {
		const pool = [
			mk("near", 0, 10000, 0),
			mk("off", 3000, 10000, 0), // ~16.7 deg right
			mk("behind", 0, -10000, 0),
		];
		const out = nearbyPeaks(pool, eye, 1.5, 0.5, 0.5, [pose(0)]);
		expect(out.map((p) => p.name)).toEqual(["near"]);
		expect(out[0].sepDeg).toBeCloseTo(0, 5);
		expect(out[0].distKm).toBeCloseTo(10, 6);
	});
	it("lets any candidate pose vote and dedupes identical summits", () => {
		const p = mk("east", 10000, 10000, 0); // 45 deg right of north
		const out = nearbyPeaks([p, { ...p }], eye, 1.5, 0.5, 0.5, [
			pose(0),
			pose(45),
		]);
		expect(out).toHaveLength(1);
		expect(out[0].sepDeg).toBeCloseTo(0, 4);
	});
	it("uses prominence to break near-ties and respects max", () => {
		const a = mk("low", 100, 10000, 0, 0); // 0.57 deg off
		const b = mk("high", -100, 10000, 0, 4000); // bonus capped at 1 deg
		const out = nearbyPeaks([a, b], eye, 1.5, 0.5, 0.5, [pose(0)]);
		expect(out[0].name).toBe("high");
		expect(
			nearbyPeaks([a, b], eye, 1.5, 0.5, 0.5, [pose(0)], { max: 1 }),
		).toHaveLength(1);
	});
	it("skips summits at the eye and empty pools", () => {
		expect(
			nearbyPeaks([mk("here", 0, 0, 0)], eye, 1.5, 0.5, 0.5, [pose(0)]),
		).toEqual([]);
		expect(nearbyPeaks([], eye, 1.5, 0.5, 0.5, [pose(0)])).toEqual([]);
	});
});

describe("tapResidualPx", () => {
	const eye: [number, number, number] = [0, 0, 0];
	it("is 0 with no taps and ~0 when the taps are exact projections", () => {
		const p = pose(10, 2);
		expect(tapResidualPx(p, 1.5, eye, [], 1000)).toBe(0);
		const world: [number, number, number] = [2000, 9000, 300];
		const q = projectPoint(p, 1.5, eye, world);
		if (!q) throw new Error("expected in front");
		expect(
			tapResidualPx(p, 1.5, eye, [{ world, u: q.u, v: q.v }], 1000),
		).toBeCloseTo(0, 6);
	});
	it("measures a known pixel offset on a w-wide image and is Infinity when behind", () => {
		const p = pose(0);
		const world: [number, number, number] = [0, 5000, 0];
		const off = tapResidualPx(
			p,
			2,
			eye,
			[{ world, u: 0.5 + 0.01, v: 0.5 }],
			1000,
		);
		expect(off).toBeCloseTo(10, 6);
		const behind: [number, number, number] = [0, -5000, 0];
		expect(
			tapResidualPx(p, 2, eye, [{ world: behind, u: 0.5, v: 0.5 }], 1000),
		).toBe(Number.POSITIVE_INFINITY);
	});
});

describe("rerankWithTaps", () => {
	const eye: [number, number, number] = [0, 0, 0];
	const world: [number, number, number] = [0, 10000, 0];
	const taps = [{ world, u: 0.5, v: 0.5 }];
	// a pin solver that snaps yaw/pitch so the tapped world point is at the image centre
	const solve = (from: Pose): Pose => ({ ...from, yaw: 0, pitch: 0 });
	it("ranks tap-consistent solutions first and collapses solutions onto one basin", () => {
		const starts = [cand(pose(20), 0), cand(pose(-15), 1)];
		const out = rerankWithTaps(starts, taps, solve, { aspect: 1.5, eye });
		// both solve to yaw 0/pitch 0 with the same roll/vfov: one distinct solution
		expect(out).toHaveLength(1);
		expect(out[0].tapPx).toBeLessThan(TAP_MAX_PX);
		expect(out[0].source).toBe("tap");
		expect(out[0].from).toBe("align");
	});
	it("puts tap-inconsistent solutions after consistent ones regardless of skyline", () => {
		const starts = [cand(pose(0, 0, 0, 40), 0), cand(pose(0, 0, 0, 60), 1)];
		const bad = (from: Pose) =>
			from.vfov === 40 ? pose(30, 0, 0, 40) : pose(0, 0, 0, 60);
		const out = rerankWithTaps(starts, taps, bad, {
			aspect: 1.5,
			eye,
			skyline: (p) => (p.yaw === 30 ? 100 : 1),
		});
		expect(out[0].pose.yaw).toBe(0);
		expect(out[0].tapPx).toBeLessThan(TAP_MAX_PX);
		expect(out[1].tapPx).toBeGreaterThan(TAP_MAX_PX);
	});
	it("orders consistent ties by skyline score, higher first", () => {
		const starts = [cand(pose(0, 0, 0, 40), 0), cand(pose(0, 0, 0, 60), 1)];
		const out = rerankWithTaps(starts, taps, (p) => p, {
			aspect: 1.5,
			eye,
			skyline: (p) => (p.vfov === 60 ? 5 : 2),
		});
		expect(out.map((o) => o.pose.vfov)).toEqual([60, 40]);
		expect(out[0].skyline).toBe(5);
	});
	it("returns [] for no starts", () => {
		expect(rerankWithTaps([], taps, solve, { aspect: 1, eye })).toEqual([]);
	});
});

describe("isAutoHigh", () => {
	it("accepts only automatic verified states", () => {
		expect(isAutoHigh("accepted", undefined)).toBe(true);
		expect(isAutoHigh("auto", "verified")).toBe(true);
		expect(isAutoHigh("auto", "refined")).toBe(true);
		expect(isAutoHigh("auto", "matched")).toBe(true);
	});
	it("fails closed for user states and missing input", () => {
		expect(isAutoHigh("manual", "verified")).toBe(false);
		expect(isAutoHigh(null, "verified")).toBe(false);
		expect(isAutoHigh(undefined, undefined)).toBe(false);
		expect(isAutoHigh("auto", undefined)).toBe(false);
	});
});
