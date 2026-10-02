// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { seededRandom, uniform } from "#/test/helpers";
import {
	type CameraX,
	IDENTITY_INTRINSICS,
	projectX,
} from "../../../concord/core";
import {
	cameraXFromState,
	dAngle,
	focalPx1600,
	stateFromCameraX,
} from "../state";
import { IDX, NP } from "../types";

const base: CameraX = {
	pose: { yaw: 40, pitch: 3, roll: -1, vfov: 42 },
	eye: [10, 20, 30],
	aspect: 1.5,
	intr: { ...IDENTITY_INTRINSICS },
};

describe("stateFromCameraX / cameraXFromState", () => {
	it("round-trips a camera through the state vector", () => {
		const rand = seededRandom(5);
		for (let i = 0; i < 20; i++) {
			const x = new Float64Array(NP);
			x[IDX.yaw] = uniform(rand, 0, 360);
			x[IDX.pitch] = uniform(rand, -20, 20);
			x[IDX.roll] = uniform(rand, -5, 5);
			x[IDX.logf] = uniform(rand, -0.1, 0.1);
			x[IDX.E] = uniform(rand, -100, 100);
			x[IDX.N] = uniform(rand, -100, 100);
			x[IDX.U] = uniform(rand, -100, 100);
			const back = stateFromCameraX(cameraXFromState(base, x), base);
			for (let k = 0; k < NP; k++) expect(back[k]).toBeCloseTo(x[k], 10);
		}
	});
	it("reads the base camera as logf = 0 and its own yaw/eye", () => {
		const x = stateFromCameraX(base);
		expect(x[IDX.logf]).toBe(0);
		expect(x[IDX.yaw]).toBe(40);
		expect([x[IDX.E], x[IDX.N], x[IDX.U]]).toEqual([10, 20, 30]);
	});
	it("logf scales fScale by exp(logf) and keeps the base vfov and aspect", () => {
		const x = stateFromCameraX(base);
		x[IDX.logf] = Math.log(1.1);
		const c = cameraXFromState(base, x);
		expect(c.intr.fScale).toBeCloseTo(1.1, 12);
		expect(c.pose.vfov).toBe(42);
		expect(c.aspect).toBe(1.5);
	});
	it("a vfov change is read as the equivalent logf (same projection)", () => {
		const zoomed: CameraX = { ...base, pose: { ...base.pose, vfov: 30 } };
		const x = stateFromCameraX(zoomed, base);
		expect(x[IDX.logf]).toBeGreaterThan(0); // narrower fov = longer focal
		const rebuilt = cameraXFromState(base, x);
		const w = [1010, 5020, 80];
		const a = projectX(zoomed, w) as { u: number; v: number };
		const b = projectX(rebuilt, w) as { u: number; v: number };
		// fScale multiplies the focal exactly like a vfov change at the image centre-ish: small-angle agreement
		expect(a.u).toBeCloseTo(b.u, 3);
		expect(a.v).toBeCloseTo(b.v, 3);
	});
	it("does not mutate the base camera", () => {
		const x = stateFromCameraX(base);
		x[IDX.yaw] = 99;
		cameraXFromState(base, x);
		expect(base.pose.yaw).toBe(40);
		expect(base.intr.fScale).toBe(1);
	});
});

describe("focalPx1600 / dAngle", () => {
	it("scales f0 by exp(logf)", () => {
		const x = new Float64Array(NP);
		x[IDX.logf] = Math.log(2);
		expect(focalPx1600(1500, x)).toBeCloseTo(3000, 9);
		expect(focalPx1600(1500, new Float64Array(NP))).toBe(1500);
	});
	it("wraps angle differences to (-180, 180]", () => {
		expect(dAngle(10, 350)).toBe(20);
		expect(dAngle(350, 10)).toBe(-20);
		expect(dAngle(0, 180)).toBe(180);
		expect(dAngle(180, 0)).toBe(180);
		expect(dAngle(0, 0)).toBe(0);
		expect(dAngle(720 + 5, 3)).toBe(2);
		expect(dAngle(-90, 90)).toBe(180);
	});
});
