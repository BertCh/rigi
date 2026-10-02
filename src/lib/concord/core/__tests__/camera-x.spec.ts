// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { projectPoint, unprojectDir } from "#/lib/camera";
import { seededRandom, uniform } from "#/test/helpers";
import {
	distortUV,
	isIdentity,
	projectX,
	undistortUV,
	unprojectDirX,
} from "../camera-x";
import { type CameraX, IDENTITY_INTRINSICS, type Intrinsics } from "../types";

const aspect = 1.5;
const vfov = 50;
const pose = { yaw: 30, pitch: 4, roll: 2, vfov };
const cam = (intr: Intrinsics): CameraX => ({
	pose,
	eye: [0, 0, 0],
	aspect,
	intr,
});

describe("isIdentity", () => {
	it("is true only for exact identity intrinsics", () => {
		expect(isIdentity(IDENTITY_INTRINSICS)).toBe(true);
		expect(isIdentity({ fScale: 1.001, k1: 0, cx: 0, cy: 0 })).toBe(false);
		expect(isIdentity({ fScale: 1, k1: 0.01, cx: 0, cy: 0 })).toBe(false);
		expect(isIdentity({ fScale: 1, k1: 0, cx: 0.01, cy: 0 })).toBe(false);
	});
});

describe("distortUV / undistortUV", () => {
	it("identity intrinsics pass through exactly", () => {
		expect(distortUV(0.3, 0.8, IDENTITY_INTRINSICS, aspect, vfov)).toEqual([
			0.3, 0.8,
		]);
		expect(undistortUV(0.3, 0.8, IDENTITY_INTRINSICS, aspect, vfov)).toEqual([
			0.3, 0.8,
		]);
	});
	it("leaves the image centre fixed without a principal-point offset", () => {
		const [u, v] = distortUV(
			0.5,
			0.5,
			{ fScale: 1.05, k1: 0.04, cx: 0, cy: 0 },
			aspect,
			vfov,
		);
		expect(u).toBeCloseTo(0.5, 12);
		expect(v).toBeCloseTo(0.5, 12);
	});
	it("a pure principal-point offset translates by (cx, cy)", () => {
		const [u, v] = distortUV(
			0.3,
			0.6,
			{ fScale: 1, k1: 0, cx: 0.01, cy: -0.02 },
			aspect,
			vfov,
		);
		expect(u).toBeCloseTo(0.31, 12);
		expect(v).toBeCloseTo(0.58, 12);
	});
	it("fScale scales radially about the centre by exactly fScale", () => {
		const [u, v] = distortUV(
			0.9,
			0.5,
			{ fScale: 1.1, k1: 0, cx: 0, cy: 0 },
			aspect,
			vfov,
		);
		expect(u - 0.5).toBeCloseTo(0.4 * 1.1, 12);
		expect(v).toBeCloseTo(0.5, 12);
	});
	it("positive k1 pushes off-centre points outward more at larger radius", () => {
		const intr = { fScale: 1, k1: 0.05, cx: 0, cy: 0 };
		const near = distortUV(0.6, 0.5, intr, aspect, vfov)[0] - 0.6;
		const far = distortUV(0.95, 0.5, intr, aspect, vfov)[0] - 0.95;
		expect(near).toBeGreaterThan(0);
		expect(far).toBeGreaterThan(near);
	});
	it("undistort inverts distort across the frame, corners included", () => {
		const rand = seededRandom(11);
		const intr = { fScale: 1.03, k1: 0.04, cx: 0.004, cy: -0.003 };
		for (let i = 0; i < 200; i++) {
			const u = uniform(rand, 0, 1);
			const v = uniform(rand, 0, 1);
			const [du, dv] = distortUV(u, v, intr, aspect, vfov);
			const [ru, rv] = undistortUV(du, dv, intr, aspect, vfov);
			expect(Math.abs(ru - u)).toBeLessThan(1e-7);
			expect(Math.abs(rv - v)).toBeLessThan(1e-7);
		}
	});
});

describe("projectX / unprojectDirX", () => {
	it("is bitwise the pinhole under identity intrinsics", () => {
		const w = [1000, 5000, 200];
		expect(projectX(cam(IDENTITY_INTRINSICS), w)).toEqual(
			projectPoint(pose, aspect, [0, 0, 0], w),
		);
		expect(unprojectDirX(cam(IDENTITY_INTRINSICS), 0.3, 0.4)).toEqual(
			unprojectDir(pose, aspect, 0.3, 0.4),
		);
	});
	it("returns null behind the camera under any intrinsics", () => {
		expect(
			projectX(cam({ fScale: 1.1, k1: 0.03, cx: 0, cy: 0 }), [0, -1000, 0]),
		).toBeNull();
	});
	it("round-trips a world ray through distortion", () => {
		const c = cam({ fScale: 0.97, k1: 0.05, cx: 0.002, cy: 0.001 });
		const world = [3000, 8000, 500];
		const q = projectX(c, world);
		expect(q).not.toBeNull();
		const d = unprojectDirX(c, (q as { u: number }).u, (q as { v: number }).v);
		const r = Math.hypot(...world);
		const dot = (d[0] * world[0] + d[1] * world[1] + d[2] * world[2]) / r;
		expect(dot).toBeCloseTo(1, 9);
	});
	it("fScale > 1 magnifies about the centre (zoom)", () => {
		const w = [4000, 9000, 800];
		const a = projectX(cam(IDENTITY_INTRINSICS), w) as { u: number; v: number };
		const b = projectX(cam({ fScale: 1.2, k1: 0, cx: 0, cy: 0 }), w) as {
			u: number;
			v: number;
		};
		expect(b.u - 0.5).toBeCloseTo((a.u - 0.5) * 1.2, 9);
		expect(b.v - 0.5).toBeCloseTo((a.v - 0.5) * 1.2, 9);
	});
});
