// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { evaluateBody, rotationFromAxisAngle } from "../anny";
import { backDepthFromFit } from "../back-depth";
import { chamfer, FACING_CAMERA, fitBody, solveSpd } from "../fit";
import { rasterDepthRange } from "../raster";
import { syntheticBody } from "./synthetic";

const K = { fx: 0.75, fy: 1, cx: 0.5, cy: 0.5 };

/** Ground truth: a pose, shape and camera placement of the synthetic body → camera-frame keypoints and mesh. */
function groundTruth(opts: { yaw?: number; z?: number } = {}) {
	const m = syntheticBody();
	const pose = new Float64Array(3 * m.jointCount);
	pose[3 * 7 + 1] = 0.5; // left shoulder
	pose[3 * 8] = -0.4; // left elbow, flexed (its hinge axis points about −x)
	pose[3 * 9 + 2] = -0.3; // right shoulder
	pose[3 * 2] = 0.3; // left knee
	pose[3 * 11] = 0.1; // neck
	const beta = [0.3];
	const body = evaluateBody(m, beta, pose);
	const Rw = rotationFromAxisAngle(0, opts.yaw ?? 0.25, 0.05);
	const R = new Float64Array(9);
	for (let r = 0; r < 3; r++)
		for (let c = 0; c < 3; c++)
			for (let k = 0; k < 3; k++)
				R[3 * r + c] += Rw[3 * r + k] * FACING_CAMERA[3 * k + c];
	const t = [0.15, 0.1, opts.z ?? 3];
	const cam = (p: Float64Array) => {
		const o = new Float64Array(p.length);
		for (let i = 0; i < p.length / 3; i++)
			for (let r = 0; r < 3; r++)
				o[3 * i + r] =
					R[3 * r] * p[3 * i] +
					R[3 * r + 1] * p[3 * i + 1] +
					R[3 * r + 2] * p[3 * i + 2] +
					t[r];
		return o;
	};
	const kp = cam(body.keypoints);
	const verts = cam(body.vertices);
	const u = new Float32Array(17);
	const v = new Float32Array(17);
	for (let k = 0; k < 17; k++) {
		u[k] = K.cx + (K.fx * kp[3 * k]) / kp[3 * k + 2];
		v[k] = K.cy + (K.fy * kp[3 * k + 1]) / kp[3 * k + 2];
	}
	return {
		m,
		kp,
		verts,
		u,
		v,
		score: new Float32Array(17).fill(0.9),
		t,
		R,
		stature: body.stature,
	};
}

function rms(a: ArrayLike<number>, b: ArrayLike<number>) {
	let s = 0;
	for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2;
	return Math.sqrt(s / (a.length / 3));
}

describe("fitBody", () => {
	it("recovers a synthetic pose and placement from its own projected keypoints", () => {
		const gt = groundTruth();
		// the true size is known to the prior here (no grid): stature = the ground truth's
		const fit = fitBody(gt.m, K, gt, null, {
			statureM: gt.stature,
			statureSigmaM: 0.02,
			initialDepthM: 2.6,
		});
		expect(fit).not.toBeNull();
		if (!fit) return;
		expect(fit.used.every(Boolean)).toBe(true);
		expect(fit.keypointRms).toBeLessThan(0.01);
		// 3D keypoints within a few cm (depth from the known size)
		expect(rms(fit.keypoints, gt.kp)).toBeLessThan(0.06);
		expect(Math.abs(fit.translation[2] - gt.t[2])).toBeLessThan(0.15);
		// the body → camera rotation within 3°
		let tr = 0;
		for (let i = 0; i < 9; i++) tr += fit.rotation[i] * gt.R[i];
		expect(Math.acos(Math.min(1, (tr - 1) / 2))).toBeLessThan(
			(3 * Math.PI) / 180,
		);
	});

	for (const depthScale of ["metric", "free"] as const)
		it(`places the body on the observed front depth over a wrong stature prior (${depthScale} depth scale)`, () => {
			const gt = groundTruth({ z: 2.5 });
			const GW = 96;
			const GH = 128;
			const range = rasterDepthRange(gt.verts, gt.m.faces, K, GW, GH);
			const cells: number[] = [];
			for (let k = 0; k < GW * GH; k++)
				if (Number.isFinite(range.near[k])) cells.push(k);
			const fit = fitBody(
				gt.m,
				K,
				gt,
				{ gridWidth: GW, gridHeight: GH, cells, frontZ: range.near },
				{ statureM: 1.5, depthScale },
			);
			expect(fit).not.toBeNull();
			if (!fit) return;
			// in the scene frame the result is the ground truth either way
			expect(Math.abs(fit.translation[2] - gt.t[2])).toBeLessThan(0.06);
			expect(Math.abs(fit.sceneScale * fit.stature - gt.stature)).toBeLessThan(
				0.08,
			);
			expect(rms(fit.vertices, gt.verts)).toBeLessThan(0.05);
			if (depthScale === "metric") expect(fit.sceneScale).toBe(1);
			// free: the body keeps (about) the prior's size and the scene scale absorbs the rest
			else expect(fit.stature).toBeLessThan(gt.stature - 0.05);
			// the back surface it yields matches the ground truth's
			const back = backDepthFromFit(fit, gt.m, {
				cells,
				gridWidth: GW,
				gridHeight: GH,
				K,
				frontZ: range.near,
				inflatedBackZ: new Float32Array(GW * GH),
			});
			const err: number[] = [];
			for (const k of cells)
				if (Number.isFinite(back.back[k]))
					err.push(Math.abs(back.back[k] - range.far[k]));
			err.sort((a, b) => a - b);
			expect(err.length).toBeGreaterThan(0.8 * cells.length);
			expect(err[err.length >> 1]).toBeLessThan(0.02);
		});

	it("ignores keypoints at the photo frame and below the confidence threshold", () => {
		const gt = groundTruth();
		const v = gt.v.slice();
		const score = gt.score.slice();
		// ankles cut by the frame, knees low confidence
		v[15] = 1.0;
		v[16] = 0.999;
		score[13] = 0.1;
		score[14] = 0.2;
		const fit = fitBody(gt.m, K, { u: gt.u, v, score }, null, {
			statureM: gt.stature,
			initialDepthM: 3,
		});
		expect(fit?.used.slice(13)).toEqual([false, false, false, false]);
		expect(fit?.used.slice(0, 13).every(Boolean)).toBe(true);
	});

	it("returns null with fewer than four usable keypoints", () => {
		const gt = groundTruth();
		const score = new Float32Array(17);
		score[0] = score[5] = score[6] = 0.9;
		expect(fitBody(gt.m, K, { u: gt.u, v: gt.v, score })).toBeNull();
	});
});

describe("helpers", () => {
	it("solveSpd solves a symmetric positive definite system", () => {
		const A = Float64Array.from([4, 1, 0, 1, 3, 1, 0, 1, 2]);
		const x = solveSpd(A, Float64Array.from([1, 2, 3]), 3);
		expect(x).not.toBeNull();
		if (!x) return;
		const b = [0, 1, 2].map(
			(r) => A[3 * r] * x[0] + A[3 * r + 1] * x[1] + A[3 * r + 2] * x[2],
		);
		for (let i = 0; i < 3; i++) expect(b[i]).toBeCloseTo(i + 1, 12);
		expect(
			solveSpd(Float64Array.from([1, 2, 2, 1]), Float64Array.from([1, 1]), 2),
		).toBeNull();
	});

	it("chamfer distance is 0 inside and grows outside", () => {
		const W = 9;
		const m = new Uint8Array(W * W);
		m[4 * W + 4] = 1;
		const d = chamfer(m, W, W);
		expect(d[4 * W + 4]).toBe(0);
		expect(d[4 * W + 5]).toBe(1);
		expect(d[4 * W + 8]).toBe(4);
		expect(d[5 * W + 5]).toBeCloseTo(4 / 3, 6);
	});
});
