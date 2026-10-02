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
import {
	type Pose,
	poseBasis,
	projectPoint as projectRef,
	unprojectDir as unprojectRef,
} from "../../camera";
import {
	azElFromDir,
	basis,
	dirFromAzEl,
	NP,
	PARAM_NAMES,
	poseFromAxes,
	project,
	unproject,
} from "../project";

const randPose = (r: () => number): Pose => ({
	yaw: uniform(r, 0, 360),
	pitch: uniform(r, -60, 60),
	roll: uniform(r, -30, 30),
	vfov: uniform(r, 25, 80),
});

describe("basis", () => {
	it("equals the camera poseBasis", () => {
		const r = seededRandom(1);
		for (let i = 0; i < 30; i++) {
			const p = randPose(r);
			const a = basis(p.yaw, p.pitch, p.roll);
			const b = poseBasis(p);
			expectArrayClose(a.forward, b.forward, 1e-12);
			expectArrayClose(a.right, b.right, 1e-12);
			expectArrayClose(a.up, b.up, 1e-12);
		}
	});
	it("analytic derivatives match central differences (per radian)", () => {
		const r = seededRandom(2);
		const h = 1e-5; // degrees
		for (let i = 0; i < 20; i++) {
			const p = randPose(r);
			const B = basis(p.yaw, p.pitch, p.roll);
			const args = [p.yaw, p.pitch, p.roll];
			for (let a = 0; a < 3; a++) {
				const hi = args.slice();
				const lo = args.slice();
				hi[a] += h;
				lo[a] -= h;
				const bh = basis(hi[0], hi[1], hi[2]);
				const bl = basis(lo[0], lo[1], lo[2]);
				const toRad = 180 / Math.PI / (2 * h);
				const fd = (x: number[], y: number[]) =>
					x.map((v, k) => (v - y[k]) * toRad);
				expectArrayClose(B.dF[a], fd(bh.forward, bl.forward), 1e-6);
				expectArrayClose(B.dR[a], fd(bh.right, bl.right), 1e-6);
				expectArrayClose(B.dU[a], fd(bh.up, bl.up), 1e-6);
			}
		}
	});
});

describe("param constants", () => {
	it("has 7 parameters in the documented order", () => {
		expect(NP).toBe(7);
		expect([...PARAM_NAMES]).toEqual([
			"dx",
			"dy",
			"dz",
			"yaw",
			"pitch",
			"roll",
			"vfov",
		]);
	});
});

describe("project", () => {
	it("matches camera projectPoint for finite points", () => {
		const r = seededRandom(3);
		for (let i = 0; i < 30; i++) {
			const p = randPose(r);
			const eye = [uniform(r, -20, 20), uniform(r, -20, 20), uniform(r, 0, 5)];
			const world = [
				uniform(r, -3000, 3000),
				uniform(r, -3000, 3000),
				uniform(r, 0, 2000),
			];
			const a = project(p, 1.5, eye, { world });
			const b = projectRef(p, 1.5, eye, world);
			if (!b) expect(a).toBeNull();
			else {
				expect(a?.u).toBeCloseTo(b.u, 10);
				expect(a?.v).toBeCloseTo(b.v, 10);
				expect(a?.depth).toBeCloseTo(b.depth, 6);
			}
		}
	});
	it("a direction is unaffected by the eye offset", () => {
		const p: Pose = { yaw: 30, pitch: 5, roll: 1, vfov: 40 };
		const d = dirFromAzEl(32, 6);
		const a = project(p, 1.5, [0, 0, 0], { dir: d });
		const b = project(p, 1.5, [500, -200, 40], { dir: d });
		expect(a).toEqual(b);
		expect(a).not.toBeNull();
	});
	it("returns null behind the camera and at depth 0 (also NaN)", () => {
		const p: Pose = { yaw: 0, pitch: 0, roll: 0, vfov: 40 };
		expect(project(p, 1, [0, 0, 0], { dir: [0, -1, 0] })).toBeNull();
		expect(project(p, 1, [0, 0, 0], { dir: [1, 0, 0] })).toBeNull();
		expect(project(p, 1, [0, 0, 0], { world: [Number.NaN, 1, 0] })).toBeNull();
	});
	it("Jacobian is null unless requested", () => {
		const p: Pose = { yaw: 0, pitch: 0, roll: 0, vfov: 40 };
		const a = project(p, 1, [0, 0, 0], { dir: [0, 1, 0] });
		expect(a?.Ju).toBeNull();
		expect(a?.Jv).toBeNull();
	});
	it("analytic Jacobian matches finite differences for all 7 parameters", () => {
		const r = seededRandom(4);
		for (let t = 0; t < 20; t++) {
			const p = randPose(r);
			const eye = [uniform(r, -5, 5), uniform(r, -5, 5), uniform(r, -5, 5)];
			const d = unproject(p, 1.5, uniform(r, 0.1, 0.9), uniform(r, 0.1, 0.9));
			const dist = uniform(r, 200, 3000);
			const world = [
				eye[0] + d[0] * dist,
				eye[1] + d[1] * dist,
				eye[2] + d[2] * dist,
			];
			const aspect = 1.5;
			const at = (q: number[]) =>
				project({ yaw: q[3], pitch: q[4], roll: q[5], vfov: q[6] }, aspect, q, {
					world,
				});
			const q0 = [eye[0], eye[1], eye[2], p.yaw, p.pitch, p.roll, p.vfov];
			const base = project(p, aspect, eye, { world }, true);
			expect(base).not.toBeNull();
			if (!base || !base.Ju || !base.Jv) continue;
			for (let k = 0; k < NP; k++) {
				const h = k < 3 ? 1e-3 : 1e-5;
				const hi = q0.slice();
				const lo = q0.slice();
				hi[k] += h;
				lo[k] -= h;
				const a = at(hi);
				const b = at(lo);
				if (!a || !b) continue;
				expect(base.Ju[k]).toBeCloseTo((a.u - b.u) / (2 * h), 5);
				expect(base.Jv[k]).toBeCloseTo((a.v - b.v) / (2 * h), 5);
			}
		}
	});
	it("direction targets have zero position derivatives", () => {
		const p: Pose = { yaw: 10, pitch: 2, roll: 0, vfov: 50 };
		const pr = project(p, 1.5, [0, 0, 0], { dir: dirFromAzEl(12, 3) }, true);
		expect(pr?.Ju?.slice(0, 3)).toEqual([0, 0, 0]);
		expect(pr?.Jv?.slice(0, 3)).toEqual([0, 0, 0]);
	});
});

describe("unproject", () => {
	it("matches camera unprojectDir and inverts project", () => {
		const r = seededRandom(5);
		for (let i = 0; i < 30; i++) {
			const p = randPose(r);
			const u = uniform(r, 0, 1);
			const v = uniform(r, 0, 1);
			expectArrayClose(
				unproject(p, 1.3, u, v),
				unprojectRef(p, 1.3, u, v),
				1e-12,
			);
			const back = project(p, 1.3, [0, 0, 0], { dir: unproject(p, 1.3, u, v) });
			expect(back?.u).toBeCloseTo(u, 10);
			expect(back?.v).toBeCloseTo(v, 10);
		}
	});
});

describe("dirFromAzEl / azElFromDir / poseFromAxes", () => {
	it("round trip az/el, azimuth wrapped to [0, 360)", () => {
		const r = seededRandom(6);
		for (let i = 0; i < 40; i++) {
			const az = uniform(r, 0, 360);
			const el = uniform(r, -88, 88);
			const [a, e] = azElFromDir(dirFromAzEl(az, el));
			expect(angleDiffDeg(a, az)).toBeLessThan(1e-9);
			expect(e).toBeCloseTo(el, 9);
		}
		expect(azElFromDir([-1, 0, 0])[0]).toBeCloseTo(270, 9);
		expect(azElFromDir([0, 0, 5])[1]).toBeCloseTo(90, 9);
	});
	it("poseFromAxes inverts basis (yaw wrapped to [0,360))", () => {
		const r = seededRandom(7);
		for (let i = 0; i < 40; i++) {
			const p = randPose(r);
			const B = basis(p.yaw, p.pitch, p.roll);
			const q = poseFromAxes(B.right, B.up, B.forward, p.vfov);
			expect(angleDiffDeg(q.yaw, p.yaw)).toBeLessThan(1e-8);
			expect(q.pitch).toBeCloseTo(p.pitch, 8);
			expect(q.roll).toBeCloseTo(p.roll, 8);
			expect(q.vfov).toBe(p.vfov);
			expect(q.yaw).toBeGreaterThanOrEqual(0);
			expect(q.yaw).toBeLessThan(360);
		}
	});
});
