// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { angleDiffDeg } from "#/test/helpers";
import { type Camera, cameraFromAngles, resizeCamera } from "../camera";
import type { HorizonProfile } from "../horizon";
import {
	coarseCost,
	DEFAULT_SIGMA,
	horizonAt,
	planCoarse,
	projectSkylineRows,
	solvePose,
	solvePoseAsync,
	stripAgreement,
} from "../solve";

/** A synthetic 0.5-degree-step panorama: smooth rolling ridge plus two peaks. */
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

const W = 400;
const H = 300;
const truth = cameraFromAngles({
	width: W,
	height: H,
	f: 420,
	yaw: 160,
	pitch: 3,
	roll: 0,
});

function skyFrom(cam: Camera, h = profile()) {
	const rows = projectSkylineRows(cam, h, cam.width);
	const weight = new Float32Array(cam.width).map((_, x) =>
		Number.isFinite(rows[x]) ? 1 : 0,
	);
	return { width: cam.width, height: cam.height, rows, weight };
}

describe("horizonAt", () => {
	const h = profile();
	it("hits the samples exactly and interpolates linearly", () => {
		expect(horizonAt(h, 10)).toBeCloseTo(h.elevation[20], 5);
		expect(horizonAt(h, 10.25)).toBeCloseTo(
			(h.elevation[20] + h.elevation[21]) / 2,
			5,
		);
	});
	it("wraps negative and >360 azimuths, including the last-to-first cell", () => {
		expect(horizonAt(h, -10)).toBeCloseTo(horizonAt(h, 350), 5);
		expect(horizonAt(h, 370)).toBeCloseTo(horizonAt(h, 10), 5);
		expect(horizonAt(h, 359.75)).toBeCloseTo(
			(h.elevation[719] + h.elevation[0]) / 2,
			5,
		);
	});
});

describe("projectSkylineRows", () => {
	it("returns one row per column; a flat horizon projects to a straight row", () => {
		const flat: HorizonProfile = {
			...profile(),
			elevation: new Float32Array(720).fill(2),
		};
		const cam = cameraFromAngles({
			width: W,
			height: H,
			f: 400,
			yaw: 90,
			pitch: 0,
			roll: 0,
		});
		const rows = projectSkylineRows(cam, flat);
		expect(rows).toHaveLength(W);
		// y = cy - f tan(2 deg) at the centre column
		const mid = rows[Math.floor(W / 2)];
		expect(mid).toBeCloseTo(H / 2 - 400 * Math.tan((2 * Math.PI) / 180), 1);
		// all columns finite for a wide horizontal fov
		for (const v of rows) expect(Number.isFinite(v)).toBe(true);
	});
	it("is NaN where the view looks away from the profile data (behind the camera)", () => {
		const narrow: HorizonProfile = {
			...profile(),
			elevation: new Float32Array(720).fill(Number.NaN),
		};
		narrow.elevation.fill(2, 0, 20);
		const cam = cameraFromAngles({
			width: W,
			height: H,
			f: 400,
			yaw: 180,
			pitch: 0,
			roll: 0,
		});
		const rows = projectSkylineRows(cam, narrow);
		expect(rows.every((v) => Number.isNaN(v))).toBe(true);
	});
	it("honours a different output width by resizing the camera", () => {
		const a = projectSkylineRows(truth, profile(), W);
		const b = projectSkylineRows(truth, profile(), W / 2);
		expect(b).toHaveLength(W / 2);
		const mid = Math.floor(W / 4);
		expect(b[mid]).toBeCloseTo(a[mid * 2] / 2, 0);
		const r = resizeCamera(truth, W / 2);
		expect(projectSkylineRows(r, profile())[mid]).toBeCloseTo(b[mid], 6);
	});
	it("pitching up moves the skyline down the image (larger y)", () => {
		const a = projectSkylineRows(truth, profile());
		const up = cameraFromAngles({
			width: W,
			height: H,
			f: 420,
			yaw: 160,
			pitch: 6,
			roll: 0,
		});
		const b = projectSkylineRows(up, profile());
		const x = 200;
		expect(b[x]).toBeGreaterThan(a[x]);
	});
});

describe("planCoarse / coarseCost", () => {
	const sky = skyFrom(truth);
	it("is null when too little skyline is observed", () => {
		const empty = { ...sky, rows: new Float32Array(W).fill(Number.NaN) };
		expect(planCoarse(truth, profile(), empty)).toBeNull();
	});
	it("the cost is minimal at zero offset for a noise-free observation of the true camera", () => {
		const plan = planCoarse(truth, profile(), sky);
		expect(plan).not.toBeNull();
		if (!plan) return;
		const c0 = coarseCost(plan, 0, 0);
		for (const [dy, dp] of [
			[3, 0],
			[-3, 0],
			[0, 1],
			[0, -1],
			[5, 1],
		])
			expect(coarseCost(plan, dy, dp)).toBeGreaterThan(c0);
		expect(plan.dys.some((v) => Math.abs(v) < 1e-9 || Math.abs(v) < 0.2)).toBe(
			true,
		);
		expect(plan.wSum).toBeGreaterThan(0);
		expect(plan.sigmaYaw).toBe(DEFAULT_SIGMA.yaw);
	});
	it("the grid spans the configured ranges", () => {
		const plan = planCoarse(truth, profile(), sky, {
			yawRange: 10,
			pitchRange: 2,
		});
		expect(plan).not.toBeNull();
		expect(plan?.dys[0]).toBeCloseTo(-10, 9);
		expect(plan?.dps[0]).toBeCloseTo(-2, 9);
		expect(Math.max(...(plan?.dys ?? []))).toBeLessThanOrEqual(10 + 1e-6);
	});
});

describe("solvePose", () => {
	const sky = skyFrom(truth);
	it("rejects with no-skyline when nothing was observed", () => {
		const empty = { ...sky, rows: new Float32Array(W).fill(Number.NaN) };
		const r = solvePose(truth, profile(), empty);
		expect(r.accepted).toBe(false);
		expect(r.rejectReason).toBe("no-skyline");
		expect(r.confidence).toBe(0);
		expect(r.camera).toBe(truth);
	});
	it("recovers the true yaw/pitch from a perturbed prior", () => {
		const prior = cameraFromAngles({
			width: W,
			height: H,
			f: 420,
			yaw: 154,
			pitch: 1.5,
			roll: 0,
		});
		const r = solvePose(prior, profile(), sky, { solveFocal: false });
		expect(angleDiffDeg(r.camera.yaw, 160)).toBeLessThan(0.4);
		expect(Math.abs(r.camera.pitch - 3)).toBeLessThan(0.4);
		expect(r.coverage).toBeGreaterThan(0.9);
		expect(r.residualPx).toBeLessThan(1.5);
		expect(r.search).toBe("local");
		expect(r.accepted).toBe(true);
		expect(r.confidence).toBeGreaterThan(0.5);
	});
	it("solvePoseAsync agrees with solvePose when no coarse provider is given", async () => {
		const prior = cameraFromAngles({
			width: W,
			height: H,
			f: 420,
			yaw: 154,
			pitch: 1.5,
			roll: 0,
		});
		const a = solvePose(prior, profile(), sky, { solveFocal: false });
		const b = await solvePoseAsync(prior, profile(), sky, {
			solveFocal: false,
		});
		expect(b.camera.yaw).toBeCloseTo(a.camera.yaw, 9);
		expect(b.confidence).toBeCloseTo(a.confidence, 9);
	});
	it("headingKnown=false triggers the full 360 search and still finds the yaw", () => {
		const prior = cameraFromAngles({
			width: W,
			height: H,
			f: 420,
			yaw: 20,
			pitch: 3,
			roll: 0,
		});
		const r = solvePose(prior, profile(), sky, {
			headingKnown: false,
			solveFocal: false,
		});
		expect(r.search).toBe("full");
		expect(angleDiffDeg(r.camera.yaw, 160)).toBeLessThan(1);
	});
});

describe("stripAgreement", () => {
	const prior = cameraFromAngles({
		width: W,
		height: H,
		f: 420,
		yaw: 151,
		pitch: 3,
		roll: 0,
	});
	const opts = { solveFocal: false };
	it("clean skyline: all three strips agree with the solve", () => {
		const sky = skyFrom(truth);
		const r = solvePose(prior, profile(), sky, opts);
		const a = stripAgreement(prior, profile(), sky, r, opts);
		expect(a.strips).toBe(3);
		expect(a.agree).toBe(3);
	});
	it("a middle third from a camera 30 deg off in yaw disagrees", () => {
		const sky = skyFrom(truth);
		const off = skyFrom(
			cameraFromAngles({
				width: W,
				height: H,
				f: 420,
				yaw: 190,
				pitch: 3,
				roll: 0,
			}),
		);
		const lo = Math.floor(W / 3);
		const hi = Math.floor((2 * W) / 3);
		for (let x = lo; x < hi; x++) sky.rows[x] = off.rows[x];
		const r = solvePose(prior, profile(), sky, opts);
		const a = stripAgreement(prior, profile(), sky, r, opts);
		expect(a.agree).toBe(2);
	});
	it("an empty skyline gives agree 0 and NaN yaws", () => {
		const sky = skyFrom(truth);
		const empty = { ...sky, rows: new Float32Array(W).fill(Number.NaN) };
		const r = solvePose(prior, profile(), empty, opts);
		const a = stripAgreement(prior, profile(), empty, r, opts);
		expect(a.agree).toBe(0);
		expect(a.yaws.every(Number.isNaN)).toBe(true);
	});
	it("does not mutate the solve result", () => {
		const sky = skyFrom(truth);
		const r = solvePose(prior, profile(), sky, opts);
		const before = structuredClone(r);
		stripAgreement(prior, profile(), sky, r, opts);
		expect(r).toEqual(before);
	});
});
