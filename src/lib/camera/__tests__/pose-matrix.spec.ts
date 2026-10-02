// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Before/after equivalence of the pose <-> R consolidation: the OLD per-module implementations are
// copied here as references and compared with camera/{poseToR, rToPose, camToEnu, anglesFromAxes}
// and with the modules that now delegate to them (all <= 1e-12).

import { describe, expect, it } from "vitest";
import { viewOfPose } from "#/components/site/lineArt";
import { poseFromBasis } from "#/lib/deck-webgpu/hosts/deck";
import * as matcher from "../../matcher/geometry";
import { camToEnuMatrix } from "../../nearfield/lift";
import {
	poseToR as propPoseToR,
	rToPose as propRToPose,
} from "../../nearfield/propagate";
import {
	anglesFromAxes,
	camToEnu,
	type Pose,
	poseToOpenCV,
	poseToR,
	rToPose,
} from "../index";

const D = Math.PI / 180;
const TOL = 1e-12;

// ---- OLD implementations (verbatim logic) ----
const cross = (a: number[], b: number[]) => [
	a[1] * b[2] - a[2] * b[1],
	a[2] * b[0] - a[0] * b[2],
	a[0] * b[1] - a[1] * b[0],
];
const dot = (a: number[], b: number[]) =>
	a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
function oldBasis(p: Pose) {
	const y = p.yaw * D;
	const pt = p.pitch * D;
	const r = p.roll * D;
	const f = [
		Math.sin(y) * Math.cos(pt),
		Math.cos(y) * Math.cos(pt),
		Math.sin(pt),
	];
	const r0 = [Math.cos(y), -Math.sin(y), 0];
	const u0 = cross(r0, f);
	const cr = Math.cos(r);
	const sr = Math.sin(r);
	return {
		f,
		right: [0, 1, 2].map((i) => r0[i] * cr - u0[i] * sr),
		up: [0, 1, 2].map((i) => u0[i] * cr + r0[i] * sr),
	};
}
const oldPoseToR = (p: Pose) => {
	const { f, right, up } = oldBasis(p);
	return [...right, -up[0], -up[1], -up[2], ...f];
};
/** matcher/geometry.ts rToPose (degrees round trip) */
function oldMatcherRToPose(R: ArrayLike<number>, vfov: number): Pose {
	const right = [R[0], R[1], R[2]];
	const f = [R[6], R[7], R[8]];
	const yaw = Math.atan2(f[0], f[1]) / D;
	const pitch = Math.asin(Math.max(-1, Math.min(1, f[2]))) / D;
	const y = yaw * D;
	const r0 = [Math.cos(y), -Math.sin(y), 0];
	const u0 = cross(r0, f);
	const roll = Math.atan2(-dot(right, u0), dot(right, r0)) / D;
	return { yaw: ((yaw % 360) + 360) % 360, pitch, roll, vfov };
}
/** nearfield/propagate.ts rToPose (radians) */
function oldPropRToPose(R: ArrayLike<number>, vfov: number): Pose {
	const right = [R[0], R[1], R[2]];
	const f = [R[6], R[7], R[8]];
	const yaw = Math.atan2(f[0], f[1]);
	const pitch = Math.asin(Math.max(-1, Math.min(1, f[2])));
	const r0 = [Math.cos(yaw), -Math.sin(yaw), 0];
	const u0 = cross(r0, f);
	const roll = Math.atan2(-dot(right, u0), dot(right, r0));
	return {
		yaw: (((yaw / D) % 360) + 360) % 360,
		pitch: pitch / D,
		roll: roll / D,
		vfov,
	};
}
/** deck-webgpu/hosts/deck.ts poseFromBasis (forward + up) */
function oldPoseFromBasis(
	f: readonly number[],
	up: readonly number[],
	vfov: number,
): Pose {
	const yaw = Math.atan2(f[0], f[1]);
	const pitch = Math.asin(Math.max(-1, Math.min(1, f[2])));
	const r0 = [Math.cos(yaw), -Math.sin(yaw), 0];
	const u0 = cross(r0, [f[0], f[1], f[2]]);
	const sr = up[0] * r0[0] + up[1] * r0[1] + up[2] * r0[2];
	const cr = up[0] * u0[0] + up[1] * u0[1] + up[2] * u0[2];
	return { yaw: yaw / D, pitch: pitch / D, roll: Math.atan2(sr, cr) / D, vfov };
}
/** nearfield/lift.ts camToEnuMatrix and camera poseToOpenCV R_cam2enu */
function oldCamToEnu(p: Pose) {
	const { f, right: R, up: U } = oldBasis(p);
	return [R[0], -U[0], f[0], R[1], -U[1], f[1], R[2], -U[2], f[2]];
}
const oldOpenCvCam2Enu = (p: Pose) => {
	const { f, right: R, up: U } = oldBasis(p);
	return [0, 1, 2].flatMap((i) => [R[i], -U[i], f[i]]);
};

// ---- deterministic grid: pitch near the poles, roll +-180, yaw wrap ----
const grid: Pose[] = [];
for (const yaw of [
	-725, -360, -181, -90, -1e-9, 0, 0.5, 45, 179.9, 180, 270, 359.99, 360, 721,
])
	for (const pitch of [-89.9, -89, -60, -10, 0, 0.001, 33, 70, 89, 89.9])
		for (const roll of [-180, -179.9, -90, -13, 0, 7, 90, 180, 359])
			grid.push({ yaw, pitch, roll, vfov: 47 });

const closeArr = (a: ArrayLike<number>, b: ArrayLike<number>, tol = TOL) => {
	expect(a.length).toBe(b.length);
	for (let i = 0; i < a.length; i++)
		expect(Math.abs(a[i] - b[i])).toBeLessThanOrEqual(tol);
};
/** Pose equality modulo angle wraps (yaw at 0/360 and roll at +-180 may land on either side). */
const angDiff = (a: number, b: number) =>
	Math.abs(((((a - b + 540) % 360) + 360) % 360) - 180);
const nearPose = (a: Pose, b: Pose, tol: number) => {
	expect(angDiff(a.yaw, b.yaw)).toBeLessThanOrEqual(tol);
	expect(Math.abs(a.pitch - b.pitch)).toBeLessThanOrEqual(tol);
	expect(angDiff(a.roll, b.roll)).toBeLessThanOrEqual(tol);
};

describe("poseToR / camToEnu equal the old copies", () => {
	it("camera.poseToR == old matcher/propagate poseToR", () => {
		for (const p of grid) {
			closeArr(poseToR(p), oldPoseToR(p), 0);
			closeArr(matcher.poseToR(p), oldPoseToR(p), 0);
			closeArr(propPoseToR(p), oldPoseToR(p), 0);
			expect(matcher.poseToR(p)).toBeInstanceOf(Float64Array);
		}
	});
	it("camToEnu == old camToEnuMatrix == old R_cam2enu == poseToR transposed", () => {
		for (const p of grid) {
			closeArr(camToEnu(p), oldCamToEnu(p), 0);
			closeArr(camToEnuMatrix(p), oldCamToEnu(p), 0);
			closeArr(poseToOpenCV(p, 400, 300).R_cam2enu, oldOpenCvCam2Enu(p), 0);
			const R = poseToR(p);
			closeArr(
				camToEnu(p),
				[R[0], R[3], R[6], R[1], R[4], R[7], R[2], R[5], R[8]],
				0,
			);
		}
	});
	it("matcher.poseBasis == old basis", () => {
		for (const p of grid) {
			const a = matcher.poseBasis(p);
			const b = oldBasis(p);
			closeArr(a.f, b.f, 0);
			closeArr(a.right, b.right, 0);
			closeArr(a.up, b.up, 0);
		}
	});
	it("lineArt viewOfPose == old inline basis", () => {
		for (const p of grid) {
			const v = viewOfPose(p, [1, 2, 3]);
			const b = oldBasis(p);
			closeArr(v.fwd, b.f, 0);
			closeArr(v.right, b.right, 0);
			closeArr(v.up, b.up, 0);
		}
	});
});

describe("rToPose / anglesFromAxes equal the old inverses", () => {
	it("matcher + propagate + camera rToPose agree with their old versions", () => {
		for (const p of grid) {
			const R = oldPoseToR(p);
			for (const [got, want] of [
				[rToPose(R, 47), oldMatcherRToPose(R, 47)],
				[matcher.rToPose(R, 47), oldMatcherRToPose(R, 47)],
				[propRToPose(R as never, 47), oldPropRToPose(R, 47)],
				[rToPose(R, 47), oldPropRToPose(R, 47)],
			] as [Pose, Pose][]) {
				nearPose(got, want, TOL);
				expect(got.vfov).toBe(47);
				expect(got.yaw).toBeGreaterThanOrEqual(0);
				expect(got.yaw).toBeLessThan(360);
			}
		}
	});
	it("round trips poseToR -> rToPose (away from the poles)", () => {
		for (const p of grid.filter((q) => Math.abs(q.pitch) < 89)) {
			const q = rToPose(poseToR(p), p.vfov);
			nearPose(q, { ...p }, 1e-9);
		}
	});
	it("anglesFromAxes == old pins/seed anglesFromAxes and deck poseFromBasis", () => {
		for (const p of grid) {
			const { f, right, up } = oldBasis(p);
			const a = anglesFromAxes(f, right);
			const old = oldPoseFromBasis(f, up, 47);
			// seed.ts: yaw/pitch/roll in degrees, yaw unwrapped
			const yaw = Math.atan2(f[0], f[1]);
			expect(Math.abs(a.yaw - yaw / D)).toBeLessThanOrEqual(TOL);
			nearPose({ ...a, vfov: 47 }, old, TOL);
			const d = poseFromBasis(f, up, 47);
			nearPose(d, old, TOL);
			expect(d.yaw).toBeCloseTo(a.yaw, 9);
		}
	});
});
