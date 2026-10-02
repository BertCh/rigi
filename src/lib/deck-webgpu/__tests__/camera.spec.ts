// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { poseBasis, projectPoint } from "#/lib/camera";
import { seededRandom, uniform } from "#/test/helpers";
import {
	type CameraState,
	cameraUniforms,
	depthAtViewDepth,
	photoCamera,
	projectToPixel,
	sphereInView,
	worldCamera,
} from "../camera";

const pose = { yaw: 30, pitch: 5, roll: 0, vfov: 40 };
const state = (extra: Partial<CameraState> = {}): CameraState =>
	photoCamera({ pose, eye: [0, 0, 0], width: 400, height: 300, ...extra });

describe("photoCamera / worldCamera", () => {
	it("photoCamera carries the pose basis and size", () => {
		const s = state();
		const b = poseBasis(pose);
		expect(s.forward).toEqual(b.forward);
		expect(s.up).toEqual(b.up);
		expect(s.vfov).toBe(40);
		expect([s.width, s.height]).toEqual([400, 300]);
	});
	it("worldCamera re-orthogonalises up and defaults near to 5", () => {
		const c = worldCamera({
			eye: [0, 0, 0],
			forward: [0, 2, 0],
			up: [0, 1, 1],
			camFov: 50,
			width: 10,
			height: 10,
		});
		expect(c.forward).toEqual([0, 1, 0]);
		expect(c.up[1]).toBeCloseTo(0, 12);
		expect(Math.hypot(...c.up)).toBeCloseTo(1, 12);
		expect(c.near).toBe(5);
		expect(worldCamera({ ...c, camFov: 50, near: 2 }).near).toBe(2);
	});
});

describe("cameraUniforms", () => {
	it("derives aspect, tangents and an orthonormal basis", () => {
		const u = cameraUniforms(state());
		expect(u.aspect).toBeCloseTo(400 / 300, 12);
		expect(u.tanHalfY).toBeCloseTo(Math.tan((20 * Math.PI) / 180), 12);
		expect(u.tanHalfX).toBeCloseTo(u.tanHalfY * u.aspect, 12);
		const dot = (a: number[], b: number[]) =>
			a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
		expect(dot(u.right, u.up)).toBeCloseTo(0, 12);
		expect(dot(u.right, u.forward)).toBeCloseTo(0, 12);
		expect(dot(u.up, u.forward)).toBeCloseTo(0, 12);
	});
	it("defaults near to 1 and guards a zero height", () => {
		expect(cameraUniforms(state()).near).toBe(1);
		expect(cameraUniforms(state({ height: 0 })).aspect).toBe(400);
	});
	it("copies the eye", () => {
		const eye: [number, number, number] = [1, 2, 3];
		const u = cameraUniforms(state({ eye }));
		eye[0] = 99;
		expect(u.eye[0]).toBe(1);
	});
});

describe("projectToPixel", () => {
	it("agrees with the pose projection (camera/projectPoint)", () => {
		const rand = seededRandom(11);
		const u = cameraUniforms(state());
		let checked = 0;
		for (let i = 0; i < 200; i++) {
			const p: [number, number, number] = [
				uniform(rand, -500, 500),
				uniform(rand, 100, 3000),
				uniform(rand, -300, 300),
			];
			const ref = projectPoint(pose, 400 / 300, [0, 0, 0], p);
			const got = projectToPixel(u, p);
			if (!ref) {
				expect(got).toBeNull();
				continue;
			}
			expect(got).not.toBeNull();
			expect(got?.x).toBeCloseTo(ref.u * 400, 6);
			expect(got?.y).toBeCloseTo(ref.v * 300, 6);
			expect(got?.range).toBeCloseTo(Math.hypot(...p), 9);
			checked++;
		}
		expect(checked).toBeGreaterThan(20);
	});
	it("puts a point straight ahead at the centre with reversed-Z depth near/z", () => {
		const s = state({ near: 2 });
		const u = cameraUniforms(s);
		const p = s.forward.map((c) => c * 100) as [number, number, number];
		const r = projectToPixel(u, p);
		expect(r?.x).toBeCloseTo(200, 9);
		expect(r?.y).toBeCloseTo(150, 9);
		expect(r?.depth).toBeCloseTo(depthAtViewDepth(2, 100), 12);
		expect(depthAtViewDepth(2, 1)).toBe(1); // inside near clamps to 1
	});
	it("returns null behind the camera", () => {
		const s = state();
		const p = s.forward.map((c) => -c * 10) as [number, number, number];
		expect(projectToPixel(cameraUniforms(s), p)).toBeNull();
	});
	it("shifts the image by the principal point offset", () => {
		const s = state();
		const p = s.forward.map((c) => c * 50) as [number, number, number];
		const base = projectToPixel(cameraUniforms(s), p);
		const shifted = projectToPixel(
			cameraUniforms({ ...s, offset: [0.5, 0] }),
			p,
		);
		expect((shifted?.x ?? 0) - (base?.x ?? 0)).toBeCloseTo(0.25 * 400, 9);
		expect(shifted?.y).toBeCloseTo(base?.y ?? 0, 9);
	});
});

describe("sphereInView", () => {
	const u = cameraUniforms(state());
	const ahead = (d: number) => state().forward.map((c) => c * d);
	it("accepts a sphere on the axis and rejects one behind or past a side plane", () => {
		const [x, y, z] = ahead(100);
		expect(sphereInView(u, [x, y, z, 1])).toBe(true);
		const [bx, by, bz] = ahead(-100);
		expect(sphereInView(u, [bx, by, bz, 1])).toBe(false);
		const right = u.right;
		const far = [
			x + right[0] * 500,
			y + right[1] * 500,
			z + right[2] * 500,
		] as const;
		expect(sphereInView(u, [far[0], far[1], far[2], 1])).toBe(false);
		expect(sphereInView(u, [far[0], far[1], far[2], 600])).toBe(true);
	});
	it("keeps a sphere straddling the near plane", () => {
		const [x, y, z] = ahead(0.5);
		expect(sphereInView(u, [x, y, z, 2])).toBe(true);
	});
	it("is conservative: every projected visible point's sphere passes", () => {
		const rand = seededRandom(3);
		for (let i = 0; i < 300; i++) {
			const p: [number, number, number] = [
				uniform(rand, -800, 800),
				uniform(rand, 10, 2000),
				uniform(rand, -500, 500),
			];
			const px = projectToPixel(u, p);
			const onScreen =
				!!px &&
				px.x >= 0 &&
				px.x <= 400 &&
				px.y >= 0 &&
				px.y <= 300 &&
				px.range > 1;
			if (onScreen) expect(sphereInView(u, [...p, 0])).toBe(true);
		}
	});
});
