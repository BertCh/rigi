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
import type { Pose } from "../../camera";
import { dot3, norm3, type Vec3 } from "../../linalg";
import {
	absoluteOrientation,
	bearing,
	dlt,
	p3p,
	poseFromRotation,
	rigidFromPoints,
	rotationFromBearings,
	vfovFromPair,
	yawFromOnePoint,
} from "../minimal";
import { basis, dirFromAzEl, project, unproject } from "../project";

const ASPECT = 1.5;
const truth: Pose = { yaw: 212, pitch: 7, roll: -3, vfov: 48 };

function worldPointInFront(
	r: () => number,
	eye: Vec3,
	p: Pose,
	dist: number,
): Vec3 {
	const u = uniform(r, 0.1, 0.9);
	const v = uniform(r, 0.1, 0.9);
	const d = unproject(p, ASPECT, u, v);
	return [eye[0] + d[0] * dist, eye[1] + d[1] * dist, eye[2] + d[2] * dist];
}

describe("bearing", () => {
	it("the image centre looks along -z (right, up, back frame)", () => {
		expectArrayClose(bearing(0.5, 0.5, 40, 1.5), [0, 0, -1], 1e-12);
	});
	it("is unit length and tilts toward +x for pixels on the right, +y for pixels above", () => {
		const b = bearing(0.9, 0.2, 40, 1.5);
		expect(norm3(b)).toBeCloseTo(1, 12);
		expect(b[0]).toBeGreaterThan(0);
		expect(b[1]).toBeGreaterThan(0);
	});
});

describe("absoluteOrientation / poseFromRotation", () => {
	it("recovers a known rotation from random vector pairs", () => {
		const r = seededRandom(1);
		const B = basis(truth.yaw, truth.pitch, truth.roll);
		// camera->world: columns (right, up, back)
		const R: [Vec3, Vec3, Vec3] = [
			B.right,
			B.up,
			[-B.forward[0], -B.forward[1], -B.forward[2]],
		];
		const cam: Vec3[] = [];
		const world: Vec3[] = [];
		for (let i = 0; i < 6; i++) {
			const c: Vec3 = [uniform(r, -1, 1), uniform(r, -1, 1), uniform(r, -1, 1)];
			cam.push(c);
			world.push([
				R[0][0] * c[0] + R[1][0] * c[1] + R[2][0] * c[2],
				R[0][1] * c[0] + R[1][1] * c[1] + R[2][1] * c[2],
				R[0][2] * c[0] + R[1][2] * c[1] + R[2][2] * c[2],
			]);
		}
		const est = absoluteOrientation(cam, world);
		for (let k = 0; k < 3; k++) expectArrayClose(est[k], R[k], 1e-9);
		const p = poseFromRotation(est, 48);
		expect(angleDiffDeg(p.yaw, truth.yaw)).toBeLessThan(1e-6);
		expect(p.pitch).toBeCloseTo(truth.pitch, 6);
		expect(p.roll).toBeCloseTo(truth.roll, 6);
		expect(p.vfov).toBe(48);
	});
	it("returns an orthonormal proper rotation even for noisy input", () => {
		const r = seededRandom(2);
		const cam: Vec3[] = [];
		const world: Vec3[] = [];
		for (let i = 0; i < 8; i++) {
			cam.push([uniform(r, -1, 1), uniform(r, -1, 1), uniform(r, -1, 1)]);
			world.push([uniform(r, -1, 1), uniform(r, -1, 1), uniform(r, -1, 1)]);
		}
		const R = absoluteOrientation(cam, world);
		for (let a = 0; a < 3; a++) {
			expect(norm3(R[a])).toBeCloseTo(1, 9);
			for (let b = a + 1; b < 3; b++)
				expect(dot3(R[a], R[b])).toBeCloseTo(0, 9);
		}
		// det = +1
		const c01 = [
			R[0][1] * R[1][2] - R[0][2] * R[1][1],
			R[0][2] * R[1][0] - R[0][0] * R[1][2],
			R[0][0] * R[1][1] - R[0][1] * R[1][0],
		];
		expect(dot3(c01, R[2])).toBeCloseTo(1, 9);
	});
	it("weights bias the fit toward heavy points", () => {
		const cam: Vec3[] = [
			[1, 0, 0],
			[0, 1, 0],
			[0, 0, 1],
			[1, 1, 0],
		];
		const world: Vec3[] = [
			[1, 0, 0],
			[0, 1, 0],
			[0, 0, 1],
			[1, -1, 0],
		];
		const light = absoluteOrientation(cam, world, [1, 1, 1, 0.001]);
		for (let k = 0; k < 3; k++) {
			const id = [0, 0, 0];
			id[k] = 1;
			expectArrayClose(light[k], id, 1e-2);
		}
	});
});

describe("rotationFromBearings", () => {
	it("recovers the true pose from exact directions", () => {
		const r = seededRandom(3);
		const uv: [number, number][] = [];
		const dirs: Vec3[] = [];
		for (let i = 0; i < 4; i++) {
			const u = uniform(r, 0.05, 0.95);
			const v = uniform(r, 0.05, 0.95);
			uv.push([u, v]);
			dirs.push(unproject(truth, ASPECT, u, v));
		}
		const p = rotationFromBearings(uv, dirs, truth.vfov, ASPECT);
		expect(angleDiffDeg(p.yaw, truth.yaw)).toBeLessThan(1e-6);
		expect(p.pitch).toBeCloseTo(truth.pitch, 6);
		expect(p.roll).toBeCloseTo(truth.roll, 6);
	});
});

describe("vfovFromPair", () => {
	it("finds the true vfov from two correspondences", () => {
		const uv: [number, number][] = [
			[0.15, 0.4],
			[0.85, 0.6],
		];
		const dirs = uv.map(([u, v]) => unproject(truth, ASPECT, u, v));
		const vf = vfovFromPair(uv, dirs, ASPECT, 10, 120);
		expect(vf).not.toBeNull();
		expect(vf).toBeCloseTo(48, 6);
	});
	it("returns null when the bracket has no sign change", () => {
		const uv: [number, number][] = [
			[0.15, 0.4],
			[0.85, 0.6],
		];
		const dirs = uv.map(([u, v]) => unproject(truth, ASPECT, u, v));
		expect(vfovFromPair(uv, dirs, ASPECT, 60, 120)).toBeNull();
	});
});

describe("yawFromOnePoint", () => {
	it("recovers yaw given pitch, roll and vfov", () => {
		for (const [u, v] of [
			[0.5, 0.5],
			[0.2, 0.7],
			[0.9, 0.3],
		]) {
			const d = unproject(truth, ASPECT, u, v);
			const yaw = yawFromOnePoint(u, v, d, { ...truth, yaw: 0 }, ASPECT);
			expect(angleDiffDeg(yaw, truth.yaw)).toBeLessThan(1e-6);
			expect(yaw).toBeGreaterThanOrEqual(0);
			expect(yaw).toBeLessThan(360);
		}
	});
	it("a point straight ahead with a level camera gives the bearing's azimuth", () => {
		const yaw = yawFromOnePoint(
			0.5,
			0.5,
			dirFromAzEl(123, 0),
			{ yaw: 0, pitch: 0, roll: 0, vfov: 40 },
			1.5,
		);
		expect(yaw).toBeCloseTo(123, 9);
	});
});

describe("rigidFromPoints", () => {
	it("recovers R and t of a rigid transform", () => {
		const r = seededRandom(4);
		const B = basis(70, 20, 5);
		const R: [Vec3, Vec3, Vec3] = [
			B.right,
			B.up,
			[-B.forward[0], -B.forward[1], -B.forward[2]],
		];
		const t: Vec3 = [100, -50, 7];
		const cam: Vec3[] = Array.from({ length: 5 }, () => [
			uniform(r, -10, 10),
			uniform(r, -10, 10),
			uniform(r, -10, 10),
		]);
		const world = cam.map(
			(c) =>
				[
					R[0][0] * c[0] + R[1][0] * c[1] + R[2][0] * c[2] + t[0],
					R[0][1] * c[0] + R[1][1] * c[1] + R[2][1] * c[2] + t[1],
					R[0][2] * c[0] + R[1][2] * c[1] + R[2][2] * c[2] + t[2],
				] as Vec3,
		);
		const est = rigidFromPoints(cam, world);
		expect(est).not.toBeNull();
		expectArrayClose(est?.t as number[], t, 1e-8);
		for (let k = 0; k < 3; k++)
			expectArrayClose((est?.R as Vec3[])[k], R[k], 1e-8);
	});
	it("returns null for non-finite input", () => {
		expect(
			rigidFromPoints(
				[
					[0, 0, 0],
					[1, 0, 0],
					[0, 1, 0],
				],
				[
					[Number.NaN, 0, 0],
					[1, 0, 0],
					[0, 1, 0],
				],
			),
		).toBeNull();
	});
});

describe("p3p", () => {
	const eye: Vec3 = [30, -20, 12];
	it("one of the candidates is the true pose and eye (exact data)", () => {
		const r = seededRandom(5);
		let found = 0;
		for (let trial = 0; trial < 10; trial++) {
			const pts = [0, 1, 2].map(() =>
				worldPointInFront(r, eye, truth, uniform(r, 500, 5000)),
			);
			// the solver is fed bearing() rays (right, up, back), as solvePose6dof does
			const bears = pts.map((P) => {
				const B = basis(truth.yaw, truth.pitch, truth.roll);
				const v = [P[0] - eye[0], P[1] - eye[1], P[2] - eye[2]];
				const n = norm3(v);
				return [
					dot3(v, B.right) / n,
					dot3(v, B.up) / n,
					-dot3(v, B.forward) / n,
				] as Vec3;
			});
			const sols = p3p(bears, pts, truth.vfov);
			expect(sols.length).toBeGreaterThan(0);
			const hit = sols.find(
				(s) =>
					norm3([s.eye[0] - eye[0], s.eye[1] - eye[1], s.eye[2] - eye[2]]) <
						1e-3 &&
					angleDiffDeg(s.pose.yaw, truth.yaw) < 1e-3 &&
					Math.abs(s.pose.pitch - truth.pitch) < 1e-3,
			);
			if (hit) found++;
		}
		expect(found).toBe(10);
	});
	it("returns [] for coincident world points", () => {
		const P: Vec3 = [1, 2, 3];
		expect(
			p3p(
				[
					[0, 0, 1],
					[0.1, 0, 0.99],
					[0, 0.1, 0.99],
				],
				[P, P, P],
				40,
			),
		).toEqual([]);
	});
});

describe("dlt", () => {
	it("returns null with too few correspondences or too few finite points", () => {
		expect(dlt([], 1.5)).toBeNull();
		const dirs = Array.from({ length: 8 }, (_, i) => ({
			u: 0.1 * i,
			v: 0.5,
			dir: dirFromAzEl(i, 0),
		}));
		expect(dlt(dirs, 1.5)).toBeNull();
	});
	it("recovers pose, eye and vfov from exact finite points", () => {
		const r = seededRandom(6);
		const eye: Vec3 = [120, -80, 30];
		const corrs: { u: number; v: number; world: Vec3 }[] = [];
		for (let i = 0; i < 10; i++) {
			const u = uniform(r, 0.05, 0.95);
			const v = uniform(r, 0.05, 0.95);
			const d = unproject(truth, ASPECT, u, v);
			const dist = uniform(r, 300, 6000);
			const world: Vec3 = [
				eye[0] + d[0] * dist,
				eye[1] + d[1] * dist,
				eye[2] + d[2] * dist,
			];
			corrs.push({ u, v, world });
		}
		const res = dlt(corrs, ASPECT);
		expect(res).not.toBeNull();
		if (!res) return;
		expect(
			norm3([res.eye[0] - eye[0], res.eye[1] - eye[1], res.eye[2] - eye[2]]),
		).toBeLessThan(5);
		expect(angleDiffDeg(res.pose.yaw, truth.yaw)).toBeLessThan(0.1);
		expect(res.pose.vfov).toBeCloseTo(48, 0);
		// reprojection
		for (const c of corrs) {
			const pr = project(res.pose, ASPECT, res.eye, { world: c.world });
			expect(
				Math.hypot(
					((pr?.u ?? 9) - c.u) * 1000,
					(((pr?.v ?? 9) - c.v) * 1000) / ASPECT,
				),
			).toBeLessThan(2);
		}
	});
});
