// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { cameraFromAngles } from "../../geo/camera";
import type { HorizonProfile } from "../../geo/horizon";
import { projectSkylineRows } from "../../geo/solve";
import { DEFAULT_INIT, globalInit } from "../init";
import { columnsFromSkyline, type Geometry, paramsFromCamera } from "../model";

function profile(): HorizonProfile {
	const step = 0.25;
	const n = 1440;
	const elevation = new Float32Array(n);
	for (let i = 0; i < n; i++) {
		const az = i * step;
		elevation[i] =
			2 +
			1.5 * Math.sin((az * Math.PI) / 23) +
			1.0 * Math.sin((az * Math.PI) / 7 + 2) +
			5 * Math.exp(-(((az - 150) / 3) ** 2)) +
			3 * Math.exp(-(((az - 172) / 2) ** 2));
	}
	return {
		step,
		elevation,
		distance: new Float32Array(n).fill(8000),
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
	roll: 0,
});
const rows = projectSkylineRows(truth, profile(), W);
const cols = columnsFromSkyline({
	width: W,
	rows,
	weight: Float32Array.from(rows, (r) => (Number.isFinite(r) ? 1 : 0)),
});
const geom = (cam: typeof truth): Geometry => ({
	width: W,
	height: H,
	cx: cam.cx,
	cy: cam.cy,
	f0: cam.f,
});

describe("globalInit", () => {
	it("finds the yaw shift of a compass error as its best mode", () => {
		const prior = cameraFromAngles({
			width: W,
			height: H,
			f: 900,
			yaw: 138,
			pitch: 2,
			roll: 0,
		});
		const r = globalInit(paramsFromCamera(prior), geom(prior), cols, profile());
		expect(r.modes.length).toBeGreaterThan(0);
		expect(r.modes.length).toBeLessThanOrEqual(DEFAULT_INIT.modes);
		expect(Math.abs(r.modes[0].dYaw - 12)).toBeLessThan(1);
		expect(r.psr).toBeGreaterThan(1);
		expect(r.shifts).toHaveLength(r.score.length);
		expect(Number.isFinite(r.ms)).toBe(true);
	});
	it("a correct prior gives a best mode near zero shift", () => {
		const r = globalInit(paramsFromCamera(truth), geom(truth), cols, profile());
		expect(Math.abs(r.modes[0].dYaw)).toBeLessThan(0.7);
	});
	it("modes are separated by at least minSeparation", () => {
		const prior = cameraFromAngles({
			width: W,
			height: H,
			f: 900,
			yaw: 140,
			pitch: 2,
			roll: 0,
		});
		const r = globalInit(paramsFromCamera(prior), geom(prior), cols, profile());
		for (let i = 0; i < r.modes.length; i++)
			for (let j = i + 1; j < r.modes.length; j++)
				expect(
					Math.abs(r.modes[i].dYaw - r.modes[j].dYaw),
				).toBeGreaterThanOrEqual(DEFAULT_INIT.minSeparation - 1e-9);
	});
	it("shifts stay within the configured yaw range", () => {
		const prior = cameraFromAngles({
			width: W,
			height: H,
			f: 900,
			yaw: 140,
			pitch: 2,
			roll: 0,
		});
		const r = globalInit(
			paramsFromCamera(prior),
			geom(prior),
			cols,
			profile(),
			{ ...DEFAULT_INIT, yawRange: 8, modes: 2 },
		);
		expect(r.modes.length).toBeLessThanOrEqual(2);
		for (const m of r.modes)
			expect(Math.abs(m.dYaw)).toBeLessThanOrEqual(8 + 0.1);
	});
});
