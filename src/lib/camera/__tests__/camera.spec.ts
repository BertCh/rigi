// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import {
	angleDiffDeg,
	expectArrayClose,
	seededRandom,
	uniform,
} from "#/test/helpers";
import { dot3, norm3 } from "../../linalg";
import {
	CROP_ASPECT_TOL,
	cameraToPose,
	FF35_DIAGONAL_MM,
	focalFromVfov,
	focalPxFromF35,
	hfovFromAspect,
	hfovFromVfov,
	isCropped,
	type Pose,
	poseBasis,
	poseToCamera,
	poseToOpenCV,
	projectPoint,
	unprojectDir,
	vfovFromFocal,
	vfovFromHfov,
} from "../index";

const pose = (yaw = 0, pitch = 0, roll = 0, vfov = 40): Pose => ({
	yaw,
	pitch,
	roll,
	vfov,
});

describe("poseBasis", () => {
	it("yaw 0 looks north, yaw 90 looks east", () => {
		expectArrayClose(poseBasis(pose(0)).forward, [0, 1, 0], 1e-12);
		expectArrayClose(poseBasis(pose(90)).forward, [1, 0, 0], 1e-12);
		expectArrayClose(poseBasis(pose(0)).right, [1, 0, 0], 1e-12);
		expectArrayClose(poseBasis(pose(0)).up, [0, 0, 1], 1e-12);
	});
	it("positive pitch tilts forward up", () => {
		expect(poseBasis(pose(0, 30)).forward[2]).toBeCloseTo(0.5, 12);
	});
	it("positive roll puts the right axis down", () => {
		expect(poseBasis(pose(0, 0, 10)).right[2]).toBeLessThan(0);
	});
	it("is orthonormal and right-handed for random poses", () => {
		const rand = seededRandom(2);
		for (let i = 0; i < 50; i++) {
			const p = pose(
				uniform(rand, 0, 360),
				uniform(rand, -80, 80),
				uniform(rand, -45, 45),
			);
			const { forward: f, right: r, up: u } = poseBasis(p);
			for (const v of [f, r, u]) expect(norm3(v)).toBeCloseTo(1, 12);
			expect(dot3(f, r)).toBeCloseTo(0, 12);
			expect(dot3(f, u)).toBeCloseTo(0, 12);
			expect(dot3(r, u)).toBeCloseTo(0, 12);
			// right x up = -forward for (right, up, back) basis => right x up = forward * -1? check handedness
			const c = [
				r[1] * u[2] - r[2] * u[1],
				r[2] * u[0] - r[0] * u[2],
				r[0] * u[1] - r[1] * u[0],
			];
			expectArrayClose(c, [-f[0], -f[1], -f[2]], 1e-12);
		}
	});
});

describe("projectPoint / unprojectDir", () => {
	it("a point straight ahead lands at the image centre", () => {
		const r = projectPoint(
			pose(30, 10),
			1.5,
			[0, 0, 0],
			poseBasis(pose(30, 10)).forward.map((x) => x * 100),
		);
		expect(r?.u).toBeCloseTo(0.5, 12);
		expect(r?.v).toBeCloseTo(0.5, 12);
		expect(r?.depth).toBeCloseTo(100, 9);
	});
	it("returns null behind the camera and at depth 0", () => {
		expect(projectPoint(pose(0), 1.5, [0, 0, 0], [0, -5, 0])).toBeNull();
		expect(projectPoint(pose(0), 1.5, [0, 0, 0], [1, 0, 0])).toBeNull();
	});
	it("vfov edge: a point at +vfov/2 above axis lands at v = 0", () => {
		const a = (20 * Math.PI) / 180;
		const r = projectPoint(
			pose(0, 0, 0, 40),
			1.5,
			[0, 0, 0],
			[0, Math.cos(a), Math.sin(a)],
		);
		expect(r?.v).toBeCloseTo(0, 12);
	});
	it("horizontal extent scales with aspect", () => {
		const t = Math.tan((20 * Math.PI) / 180) * 1.5;
		const r = projectPoint(pose(0, 0, 0, 40), 1.5, [0, 0, 0], [t, 1, 0]);
		expect(r?.u).toBeCloseTo(1, 12);
	});
	it("unproject inverts project (random poses) and yields unit vectors", () => {
		const rand = seededRandom(4);
		for (let i = 0; i < 50; i++) {
			const p = pose(
				uniform(rand, 0, 360),
				uniform(rand, -60, 60),
				uniform(rand, -30, 30),
				uniform(rand, 20, 90),
			);
			const aspect = uniform(rand, 0.6, 2);
			const u = uniform(rand, 0, 1);
			const v = uniform(rand, 0, 1);
			const d = unprojectDir(p, aspect, u, v);
			expect(norm3(d)).toBeCloseTo(1, 12);
			const eye = [
				uniform(rand, -50, 50),
				uniform(rand, -50, 50),
				uniform(rand, 0, 10),
			];
			const dist = uniform(rand, 10, 1000);
			const r = projectPoint(p, aspect, eye, [
				eye[0] + d[0] * dist,
				eye[1] + d[1] * dist,
				eye[2] + d[2] * dist,
			]);
			expect(r).not.toBeNull();
			expect(r?.u).toBeCloseTo(u, 9);
			expect(r?.v).toBeCloseTo(v, 9);
		}
	});
});

describe("fov / focal conversions", () => {
	it("focal <-> vfov round trip", () => {
		for (const v of [10, 40, 90, 120])
			expect(vfovFromFocal(focalFromVfov(v, 1000), 1000)).toBeCloseTo(v, 10);
	});
	it("90 degree vfov has focal H/2", () => {
		expect(focalFromVfov(90, 800)).toBeCloseTo(400, 10);
	});
	it("hfov <-> vfov round trip and square image identity", () => {
		expect(hfovFromVfov(50, 500, 500)).toBeCloseTo(50, 10);
		expect(vfovFromHfov(hfovFromVfov(50, 4000, 3000), 4000, 3000)).toBeCloseTo(
			50,
			10,
		);
		expect(hfovFromVfov(40, 1500, 1000)).toBeGreaterThan(40);
	});
	it("hfovFromAspect agrees with hfovFromVfov to rounding", () => {
		expect(hfovFromAspect(40, 1.5)).toBeCloseTo(
			hfovFromVfov(40, 1500, 1000),
			9,
		);
	});
});

describe("poseToCamera / cameraToPose", () => {
	it("round trips a pose, wrapping yaw to [0,360)", () => {
		const p = pose(-30, 12, -3, 47);
		const back = cameraToPose(poseToCamera(p, 4000, 3000));
		expect(angleDiffDeg(back.yaw, 330)).toBeLessThan(1e-9);
		expect(back.yaw).toBeGreaterThanOrEqual(0);
		expect(back.pitch).toBeCloseTo(12, 9);
		expect(back.roll).toBeCloseTo(-3, 9);
		expect(back.vfov).toBeCloseTo(47, 9);
	});
	it("camera focal matches focalFromVfov", () => {
		expect(poseToCamera(pose(0, 0, 0, 40), 400, 300).f).toBeCloseTo(
			focalFromVfov(40, 300),
			12,
		);
	});
});

describe("poseToOpenCV", () => {
	it("K has f on the diagonal and the principal point at the centre", () => {
		const { f, K } = poseToOpenCV(pose(0, 0, 0, 60), 1600, 900);
		expect(f).toBeCloseTo(450 / Math.tan(Math.PI / 6), 9);
		expect(K).toEqual([f, 0, 800, 0, f, 450, 0, 0, 1]);
	});
	it("R_cam2enu maps camera z to forward, x to right, y to -up", () => {
		const p = pose(70, 15, 5);
		const { R_cam2enu: R } = poseToOpenCV(p, 100, 100);
		const { forward, right, up } = poseBasis(p);
		expectArrayClose([R[2], R[5], R[8]], forward);
		expectArrayClose([R[0], R[3], R[6]], right);
		expectArrayClose(
			[R[1], R[4], R[7]],
			up.map((x) => -x),
		);
	});
});

describe("focal.ts (35 mm equivalent)", () => {
	const image = { width: 4000, height: 3000 };
	it("diagonal constant", () => {
		expect(FF35_DIAGONAL_MM).toBeCloseTo(Math.hypot(36, 24), 3);
	});
	it("isCropped ignores rotation, tolerates rounding, flags real aspect changes", () => {
		const sensor = { width: 4032, height: 3024 };
		expect(isCropped(sensor, { width: 3024, height: 4032 })).toBe(false);
		expect(isCropped(sensor, { width: 2016, height: 1512 })).toBe(false);
		expect(isCropped(sensor, { width: 4032, height: 2268 })).toBe(true);
		expect(
			isCropped(sensor, {
				width: 4032,
				height: 3024 * (1 + CROP_ASPECT_TOL / 2),
			}),
		).toBe(false);
	});
	it("isCropped is false for missing or invalid sensors", () => {
		expect(isCropped(null, image)).toBe(false);
		expect(isCropped(undefined, image)).toBe(false);
		expect(isCropped({ width: 0, height: 10 }, image)).toBe(false);
		expect(isCropped({ width: Number.NaN, height: 10 }, image)).toBe(false);
		expect(isCropped({ width: 10 }, image)).toBe(false);
	});
	it("uncropped: f = f35 * diag(image) / 43.27", () => {
		const f = focalPxFromF35(26, image);
		expect(f).toBeCloseTo((26 * 5000) / FF35_DIAGONAL_MM, 9);
		expect(
			focalPxFromF35(26, image, { width: 4032, height: 3024 }),
		).toBeCloseTo(f, 9);
	});
	it("a 26 mm equivalent on a 4:3 frame has hfov ~ 69 deg", () => {
		const f = focalPxFromF35(26, image);
		const h = (2 * Math.atan(2000 / f) * 180) / Math.PI;
		expect(h).toBeGreaterThan(65);
		expect(h).toBeLessThan(75);
	});
	it("cropped: uses the sensor pitch, scaled by the resize", () => {
		const sensor = { width: 4032, height: 3024 };
		const source = { width: 4032, height: 2268 };
		const full = focalPxFromF35(26, source, sensor);
		expect(full).toBeCloseTo(
			(26 * Math.hypot(4032, 3024)) / FF35_DIAGONAL_MM,
			9,
		);
		const half = focalPxFromF35(
			26,
			{ width: 2016, height: 1134 },
			sensor,
			source,
		);
		expect(half).toBeCloseTo(full / 2, 9);
	});
	it("is proportional to f35", () => {
		expect(focalPxFromF35(52, image)).toBeCloseTo(
			2 * focalPxFromF35(26, image),
			9,
		);
	});
});
