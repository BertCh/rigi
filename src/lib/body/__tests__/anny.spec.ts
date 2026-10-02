// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { encodeSafetensors } from "#/lib/nn";
import { expectArrayClose, seededRandom, uniform } from "#/test/helpers";
import {
	annyFromBytes,
	evaluateBody,
	forwardKinematics,
	rotationFromAxisAngle,
	skinPoints,
} from "../anny";
import { syntheticBody } from "./synthetic";

describe("rotationFromAxisAngle", () => {
	it("is orthonormal with det 1 and rotates about its axis", () => {
		const rand = seededRandom(1);
		for (let n = 0; n < 50; n++) {
			const r = [
				uniform(rand, -2, 2),
				uniform(rand, -2, 2),
				uniform(rand, -2, 2),
			];
			const R = rotationFromAxisAngle(r[0], r[1], r[2]);
			for (let a = 0; a < 3; a++)
				for (let b = 0; b < 3; b++) {
					let d = 0;
					for (let c = 0; c < 3; c++) d += R[3 * a + c] * R[3 * b + c];
					expect(d).toBeCloseTo(a === b ? 1 : 0, 12);
				}
			// the axis is fixed
			const ax = [0, 1, 2].map(
				(i) => R[3 * i] * r[0] + R[3 * i + 1] * r[1] + R[3 * i + 2] * r[2],
			);
			expectArrayClose(ax, r, 1e-12);
		}
		// +90° about z maps x to y
		const Rz = rotationFromAxisAngle(0, 0, Math.PI / 2);
		expectArrayClose([Rz[0], Rz[3], Rz[6]], [0, 1, 0], 1e-12);
	});
});

describe("linear blend skinning", () => {
	it("leaves the rest pose unchanged", () => {
		const m = syntheticBody();
		const posed = evaluateBody(m, [0], new Float64Array(3 * m.jointCount));
		expectArrayClose(posed.vertices, m.vertices, 1e-6);
		expectArrayClose(posed.keypoints, m.keypoints, 1e-6);
		expectArrayClose(posed.joints, m.joints, 1e-6);
	});

	it("rotates a child chain about its joint and round-trips through the inverse transforms", () => {
		const m = syntheticBody();
		const rand = seededRandom(7);
		const pose = new Float64Array(3 * m.jointCount);
		for (let i = 0; i < pose.length; i++) pose[i] = uniform(rand, -0.6, 0.6);
		const fk = forwardKinematics(m, m.joints, pose);
		// a point skinned 50/50 to two joints, and its inverse with the inverted blended transform
		const rest = Float64Array.from([0.2, -0.05, 0.3, 0.1, 0.02, -0.3]);
		const idx = [7, 8, 0, 0, 1, 2, 0, 0];
		const w = [0.5, 0.5, 0, 0, 0.3, 0.7, 0, 0];
		const out = skinPoints(rest, idx, w, 4, fk.skin);
		for (let p = 0; p < 2; p++) {
			// blended 3 × 4, then solve M · x + t = out for x
			const M = new Float64Array(12);
			for (let c = 0; c < 4; c++)
				for (let e = 0; e < 12; e++)
					M[e] += w[4 * p + c] * fk.skin[12 * idx[4 * p + c] + e];
			const b = [0, 1, 2].map((r) => out[3 * p + r] - M[4 * r + 3]);
			const A = [M[0], M[1], M[2], M[4], M[5], M[6], M[8], M[9], M[10]];
			const det =
				A[0] * (A[4] * A[8] - A[5] * A[7]) -
				A[1] * (A[3] * A[8] - A[5] * A[6]) +
				A[2] * (A[3] * A[7] - A[4] * A[6]);
			const solve = (col: number) => {
				const B = A.slice();
				for (let r = 0; r < 3; r++) B[3 * r + col] = b[r];
				return (
					(B[0] * (B[4] * B[8] - B[5] * B[7]) -
						B[1] * (B[3] * B[8] - B[5] * B[6]) +
						B[2] * (B[3] * B[7] - B[4] * B[6])) /
					det
				);
			};
			expectArrayClose(
				[solve(0), solve(1), solve(2)],
				rest.subarray(3 * p, 3 * p + 3),
				1e-9,
			);
		}
	});

	it("moves an elbow keypoint rigidly with the shoulder rotation", () => {
		const m = syntheticBody();
		const pose = new Float64Array(3 * m.jointCount);
		// 90° about +y at the left shoulder (joint 7)
		pose[3 * 7 + 1] = Math.PI / 2;
		const posed = evaluateBody(m, [0], pose);
		const sh = [0.18, 0, 0.45];
		const el = [0.25, 0, 0.2];
		const d = [el[0] - sh[0], el[1] - sh[1], el[2] - sh[2]];
		const R = rotationFromAxisAngle(0, Math.PI / 2, 0);
		const want = [0, 1, 2].map(
			(r) =>
				sh[r] + R[3 * r] * d[0] + R[3 * r + 1] * d[1] + R[3 * r + 2] * d[2],
		);
		expectArrayClose(posed.keypoints.subarray(3 * 7, 3 * 7 + 3), want, 1e-6);
		// the shoulder keypoint itself stays
		expectArrayClose(posed.keypoints.subarray(3 * 5, 3 * 5 + 3), sh, 1e-6);
	});

	it("applies the linear shape to vertices, joints and stature", () => {
		const m = syntheticBody();
		const posed = evaluateBody(m, [1], new Float64Array(3 * m.jointCount));
		expectArrayClose(
			posed.vertices,
			Array.from(m.vertices, (x) => 1.1 * x),
			1e-6,
		);
		expect(posed.stature).toBeCloseTo(1.1 * m.stature, 6);
	});
});

describe("annyFromBytes", () => {
	it("reads the producer layout", () => {
		const m = syntheticBody();
		const bytes = encodeSafetensors(
			{
				"template.vertices": { shape: [m.vertexCount, 3], data: m.vertices },
				"template.joints": { shape: [m.jointCount, 3], data: m.joints },
				"template.keypoints": {
					shape: [m.keypointCount, 3],
					data: m.keypoints,
				},
				"template.stature": { shape: [1], data: Float32Array.of(m.stature) },
				"shape.dirs": { shape: [1, m.vertexCount, 3], data: m.shapeVertices },
				"shape.joints": { shape: [1, m.jointCount, 3], data: m.shapeJoints },
				"shape.keypoints": {
					shape: [1, m.keypointCount, 3],
					data: m.shapeKeypoints,
				},
				"shape.stature": { shape: [1], data: m.shapeStature },
				faces: {
					shape: [m.faces.length / 3, 3],
					data: Float32Array.from(m.faces),
				},
				"joints.parent": {
					shape: [m.jointCount],
					data: Float32Array.from(m.parents),
				},
				"skin.index": {
					shape: [m.vertexCount, 4],
					data: Float32Array.from(m.skinIndex),
				},
				"skin.weight": { shape: [m.vertexCount, 4], data: m.skinWeight },
				"keypoints.index": {
					shape: [m.keypointCount, 4],
					data: Float32Array.from(m.keypointIndex),
				},
				"keypoints.weight": {
					shape: [m.keypointCount, 4],
					data: m.keypointWeight,
				},
			},
			{ shapes: "scale", joints: m.jointNames.join(",") },
		);
		const back = annyFromBytes(bytes);
		expect(back.vertexCount).toBe(m.vertexCount);
		expect(back.jointNames).toEqual(m.jointNames);
		expect(back.shapeNames).toEqual(["scale"]);
		expect(Array.from(back.parents)).toEqual(Array.from(m.parents));
		expectArrayClose(back.vertices, m.vertices, 0);
		expectArrayClose(back.faces, m.faces, 0);
	});
});
