// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { angleDiffDeg } from "#/test/helpers";
import { cameraFromAngles, directionENU, project } from "../camera";
import { type ControlPoint, solveFromControlPoints } from "../control-points";

const truth = cameraFromAngles({
	width: 4000,
	height: 3000,
	f: 3200,
	yaw: 140,
	pitch: 4,
	roll: 1.5,
});
const pts: [number, number][] = [
	[120, 6],
	[150, 9],
	[162, 3],
	[131, 11],
	[145, -2],
];
const control = (list = pts): ControlPoint[] =>
	list.map(([azimuth, elevation]) => {
		const p = project(truth, directionENU(azimuth, elevation)) as number[];
		return { x: p[0], y: p[1], azimuth, elevation };
	});

describe("solveFromControlPoints", () => {
	it("returns the initial camera for no points", () => {
		const init = cameraFromAngles({
			width: 4000,
			height: 3000,
			f: 3000,
			yaw: 0,
			pitch: 0,
			roll: 0,
		});
		const r = solveFromControlPoints(init, []);
		expect(r.camera).toBe(init);
		expect(r.rmsPx).toBe(0);
		expect(r.solvedFocal).toBe(false);
	});
	it("one point recovers yaw and pitch, keeps roll and f", () => {
		const init = cameraFromAngles({
			width: 4000,
			height: 3000,
			f: 3200,
			yaw: 130,
			pitch: 0,
			roll: 1.5,
		});
		const r = solveFromControlPoints(init, control([[150, 9]]));
		expect(r.solvedFocal).toBe(false);
		expect(r.camera.roll).toBeCloseTo(1.5, 6);
		expect(r.camera.f).toBe(3200);
		expect(r.rmsPx).toBeLessThan(0.05);
		const p = project(r.camera, directionENU(150, 9)) as number[];
		const t = project(truth, directionENU(150, 9)) as number[];
		expect(Math.hypot(p[0] - t[0], p[1] - t[1])).toBeLessThan(0.1);
	});
	it("two points also solve roll", () => {
		const init = cameraFromAngles({
			width: 4000,
			height: 3000,
			f: 3200,
			yaw: 135,
			pitch: 2,
			roll: 0,
		});
		const r = solveFromControlPoints(init, control(pts.slice(0, 2)));
		expect(r.solvedFocal).toBe(false);
		expect(angleDiffDeg(r.camera.yaw, 140)).toBeLessThan(0.02);
		expect(r.camera.pitch).toBeCloseTo(4, 2);
		expect(r.camera.roll).toBeCloseTo(1.5, 2);
		expect(r.residualsPx).toHaveLength(2);
	});
	it("three or more points also solve the focal length (unless disabled)", () => {
		const init = cameraFromAngles({
			width: 4000,
			height: 3000,
			f: 3000,
			yaw: 135,
			pitch: 2,
			roll: 0,
		});
		const r = solveFromControlPoints(init, control());
		expect(r.solvedFocal).toBe(true);
		expect(r.camera.f).toBeGreaterThan(3150);
		expect(r.camera.f).toBeLessThan(3250);
		expect(r.rmsPx).toBeLessThan(1);
		const off = solveFromControlPoints(init, control(), { solveFocal: false });
		expect(off.solvedFocal).toBe(false);
		expect(off.camera.f).toBe(3000);
	});
	it("level points count as half points and add a residual each", () => {
		const init = cameraFromAngles({
			width: 4000,
			height: 3000,
			f: 3200,
			yaw: 135,
			pitch: 2,
			roll: 0,
		});
		const [a, b] = control(pts.slice(0, 2));
		const levelPx = project(truth, directionENU(140, 0)) as number[];
		const r = solveFromControlPoints(init, [a, b], {
			levels: [{ x: levelPx[0], y: levelPx[1], elevation: 0 }],
		});
		expect(r.residualsPx).toHaveLength(3);
		// 2 + 0.5 < 3: focal stays fixed
		expect(r.solvedFocal).toBe(false);
	});
	it("a point behind the camera gives a huge residual rather than NaN", () => {
		const init = cameraFromAngles({
			width: 4000,
			height: 3000,
			f: 3200,
			yaw: 0,
			pitch: 0,
			roll: 0,
		});
		const r = solveFromControlPoints(init, [
			{ x: 100, y: 100, azimuth: 180, elevation: 0 },
		]);
		expect(Number.isFinite(r.rmsPx)).toBe(true);
	});
});
