// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { poseBasis } from "../../camera";
import { DEG, evalColumn, horizonTable, newEval } from "../../refine/model";
import { scanColumnsCpu } from "../skyline-cpu";
import {
	horizonAt,
	makeRidgeProfile,
	makeSensor,
	makeTrajectory,
	renderFrame,
	rng,
	rotationErrorDeg,
} from "../synthetic";

describe("synthetic sequences", () => {
	it("makes a deterministic, bounded ridge profile", () => {
		const a = makeRidgeProfile(3);
		const b = makeRidgeProfile(3);
		expect(a.elevation).toEqual(b.elevation);
		expect(a.elevation.length).toBe(3600);
		expect(Math.min(...a.elevation)).toBeGreaterThan(-8);
		expect(Math.max(...a.elevation)).toBeLessThan(25);
		expect(horizonAt(a, 359.99)).toBeCloseTo(horizonAt(a, -0.01), 6);
	});

	it("rotationErrorDeg is zero for equal poses and the angle for a pure yaw", () => {
		const p = { yaw: 10, pitch: 3, roll: 1, vfov: 50 };
		expect(rotationErrorDeg(p, p)).toBeCloseTo(0, 4);
		expect(rotationErrorDeg(p, { ...p, yaw: 12 })).toBeGreaterThan(1.9);
	});

	it("rendered skylines agree with the model's projection (conventions match)", () => {
		const profile = makeRidgeProfile(1);
		const pose = { yaw: 140, pitch: 4, roll: -3, vfov: 50 };
		const img = renderFrame(
			profile,
			pose,
			320,
			180,
			{ noise: 0, clouds: false, occluders: false },
			rng(1),
		);
		const scan = scanColumnsCpu(img, 320);
		const geom = {
			width: 320,
			height: scan.height,
			cx: 160,
			cy: scan.height / 2,
			f0: scan.height / 2 / Math.tan((50 * DEG) / 2),
		};
		const table = horizonTable(profile, 0);
		const p = new Float64Array(6);
		p[0] = pose.yaw * DEG;
		p[1] = pose.pitch * DEG;
		p[2] = pose.roll * DEG;
		p[4] = 0.13;
		const ev = newEval();
		const res: number[] = [];
		for (let x = 0; x < 320; x++) {
			if (!(scan.weights[x] > 0.5)) continue;
			evalColumn(p, geom, table, { x: x + 0.5, y: scan.rows[x], w: 1 }, ev);
			res.push(Math.abs(ev.r));
		}
		res.sort((a, b) => a - b);
		expect(res.length).toBeGreaterThan(250);
		expect(res[res.length >> 1]).toBeLessThan(0.6);
		// the camera basis used for rendering is the contract's
		expect(poseBasis(pose).forward[2]).toBeCloseTo(Math.sin(4 * DEG), 9);
	});

	it("sensor readings carry the configured bias and stay near the truth otherwise", () => {
		const truth = makeTrajectory();
		const sensor = makeSensor({
			yawBias: 10,
			yawWalk: 0,
			noise: 0,
			pitchBias: 1,
			rollBias: 0,
			pitchRollWalk: 0,
		});
		const t = truth(1);
		const s = sensor(t, 1);
		expect(s.time).toBe(1000);
		expect((((s.yaw as number) - t.yaw + 540) % 360) - 180).toBeCloseTo(10, 6);
		expect(s.pitch - t.pitch).toBeCloseTo(1, 6);
		expect(makeSensor({ noCompass: true })(t, 0).yaw).toBeNull();
	});
});
