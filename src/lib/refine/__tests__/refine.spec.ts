// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { angleDiffDeg } from "#/test/helpers";
import { cameraFromAngles } from "../../geo/camera";
import type { HorizonProfile } from "../../geo/horizon";
import { projectSkylineRows } from "../../geo/solve";
import { refinePose } from "../index";

/** Rolling 0.25-degree profile with distinctive peaks so yaw is well observable. */
function profile(): HorizonProfile {
	const step = 0.25;
	const n = 1440;
	const elevation = new Float32Array(n);
	const distance = new Float32Array(n);
	for (let i = 0; i < n; i++) {
		const az = i * step;
		elevation[i] =
			2 +
			1.5 * Math.sin((az * Math.PI) / 23) +
			1.0 * Math.sin((az * Math.PI) / 7 + 2) +
			5 * Math.exp(-(((az - 150) / 3) ** 2)) +
			3 * Math.exp(-(((az - 172) / 2) ** 2)) +
			4 * Math.exp(-(((az - 125) / 2.5) ** 2));
		distance[i] = 6000 + 4000 * Math.sin((az * Math.PI) / 61) ** 2;
	}
	return {
		step,
		elevation,
		distance,
		ridges: Array.from({ length: n }, () => []),
	};
}

const W = 800;
const H = 600;
const truth = cameraFromAngles({
	width: W,
	height: H,
	f: 900,
	yaw: 150,
	pitch: 2,
	roll: 0.5,
});
const rows = projectSkylineRows(truth, profile(), W);
const skyline = {
	width: W,
	height: H,
	rows,
	weight: Float32Array.from(rows, (r) => (Number.isFinite(r) ? 1 : 0)),
};

describe("refinePose", () => {
	it("recovers the true pose from a perturbed prior on a noise-free skyline", () => {
		const prior = cameraFromAngles({
			width: W,
			height: H,
			f: 900,
			yaw: 147,
			pitch: 1.2,
			roll: 0,
		});
		const r = refinePose({
			camera: prior,
			horizon: profile(),
			skyline,
			options: { localOnly: true },
		});
		expect(angleDiffDeg(r.camera.yaw, 150)).toBeLessThan(0.15);
		expect(Math.abs(r.camera.pitch - 2)).toBeLessThan(0.15);
		expect(Math.abs(r.camera.roll - 0.5)).toBeLessThan(0.3);
		expect(r.camera.width).toBe(W);
		expect(r.modes.length).toBeGreaterThan(0);
		expect(r.confidence.metrics.rmsPx1600).toBeLessThan(3);
		expect(r.ms).toBeGreaterThanOrEqual(0);
	});
	it("the global search finds the yaw when the compass is off by 20 degrees", () => {
		const prior = cameraFromAngles({
			width: W,
			height: H,
			f: 900,
			yaw: 130,
			pitch: 2,
			roll: 0.5,
		});
		const r = refinePose({ camera: prior, horizon: profile(), skyline });
		expect(angleDiffDeg(r.camera.yaw, 150)).toBeLessThan(0.5);
		expect(r.init.seeds).toBeGreaterThan(0);
	});
	it("returns the prior and a rejecting confidence when there is no skyline", () => {
		const prior = cameraFromAngles({
			width: W,
			height: H,
			f: 900,
			yaw: 10,
			pitch: 0,
			roll: 0,
		});
		const empty = { ...skyline, rows: new Float32Array(W).fill(Number.NaN) };
		const r = refinePose({ camera: prior, horizon: profile(), skyline: empty });
		expect(r.camera).toBe(prior);
		expect(r.confidence.accept).toBe(false);
		expect(r.confidence.score).toBe(0);
		expect(r.confidence.reasons).toContain("no usable skyline");
		expect(r.modes).toEqual([]);
		expect(r.iterations).toBe(0);
	});
	it("works at a different prior resolution than the skyline and returns the prior's resolution", () => {
		const prior = cameraFromAngles({
			width: 1600,
			height: 1200,
			f: 1800,
			yaw: 148,
			pitch: 1.5,
			roll: 0.5,
		});
		const r = refinePose({
			camera: prior,
			horizon: profile(),
			skyline,
			options: { localOnly: true },
		});
		expect(r.camera.width).toBe(1600);
		expect(r.camera.f).toBeGreaterThan(1500);
		expect(r.camera.f).toBeLessThan(2100);
		expect(angleDiffDeg(r.camera.yaw, 150)).toBeLessThan(0.3);
	});
	it("is deterministic", () => {
		const prior = cameraFromAngles({
			width: W,
			height: H,
			f: 900,
			yaw: 146,
			pitch: 1,
			roll: 0,
		});
		const a = refinePose({
			camera: prior,
			horizon: profile(),
			skyline,
			options: { localOnly: true },
		});
		const b = refinePose({
			camera: prior,
			horizon: profile(),
			skyline,
			options: { localOnly: true },
		});
		expect(a.camera.yaw).toBe(b.camera.yaw);
		expect(a.confidence.score).toBe(b.confidence.score);
	});
});
