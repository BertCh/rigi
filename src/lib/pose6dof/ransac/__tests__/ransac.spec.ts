// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { seededRandom } from "#/test/helpers";
import { absolutePoseRansac, dltFocal, p3pGrunert } from "../absolute";
import {
	absolutePoseRansacAsync,
	cameraRotationRansacAsync,
	rotationRansacAsync,
} from "../async";
import {
	chord2OfAngle,
	driveAsync,
	driveSync,
	HYP_STRIDE,
	type HypothesisBatch,
	putHypothesis,
	scoreBatchCpu,
	scoreHypothesis,
} from "../batch";
import { cameraRotationRansac, triad } from "../camera-rotation";
import { refinePoseLm } from "../lm";
import { createRng, sampleDistinct, trialsNeeded } from "../rng";
import {
	expSO3,
	kabsch,
	mul3,
	rotationAngleDeg,
	rotationDistanceDeg,
	rotationFromCovariance,
	transpose3,
} from "../rot3";
import { rotationRansac, rotationRansacLoop } from "../rotation";
import { synthAbsolute, synthRotation } from "./synth";

const det3 = (R: ArrayLike<number>) =>
	R[0] * (R[4] * R[8] - R[5] * R[7]) -
	R[1] * (R[3] * R[8] - R[5] * R[6]) +
	R[2] * (R[3] * R[7] - R[4] * R[6]);
const truthMask = (n: number, nOut: number) =>
	Uint8Array.from({ length: n }, (_, i) => (i < nOut ? 0 : 1));
const agreement = (a: ArrayLike<number>, b: ArrayLike<number>) => {
	let s = 0;
	for (let i = 0; i < a.length; i++) if (!!a[i] === !!b[i]) s++;
	return s / a.length;
};

describe("rot3", () => {
	it("expSO3 is a proper rotation with the right angle", () => {
		const R = expSO3(0.3, -0.2, 0.1);
		const RRt = mul3(R, transpose3(R));
		for (let i = 0; i < 9; i++)
			expect(RRt[i]).toBeCloseTo(i % 4 === 0 ? 1 : 0, 12);
		expect(det3(R)).toBeCloseTo(1, 12);
		expect(rotationAngleDeg(R)).toBeCloseTo(
			(Math.hypot(0.3, 0.2, 0.1) * 180) / Math.PI,
			9,
		);
	});
	it("kabsch recovers a rotation from noiseless pairs, and stays proper for a reflection", () => {
		const rnd = seededRandom(3);
		const R = expSO3(1.1, -0.4, 2.0);
		const n = 5;
		const x = new Float64Array(n * 3).map(() => rnd() - 0.5);
		const y = new Float64Array(n * 3);
		for (let i = 0; i < n; i++)
			for (let r = 0; r < 3; r++)
				y[i * 3 + r] =
					R[r * 3] * x[i * 3] +
					R[r * 3 + 1] * x[i * 3 + 1] +
					R[r * 3 + 2] * x[i * 3 + 2];
		expect(rotationDistanceDeg(kabsch(x, y), R)).toBeLessThan(1e-6);
		const mirror = rotationFromCovariance([1, 0, 0, 0, 1, 0, 0, 0, -1]);
		expect(det3(mirror)).toBeCloseTo(1, 12);
	});
});

describe("rng", () => {
	it("samples distinct indices deterministically", () => {
		const a = createRng(5);
		const b = createRng(5);
		const out = new Int32Array(6);
		for (let k = 0; k < 50; k++) {
			sampleDistinct(a, 7, 6, out);
			expect(new Set(out).size).toBe(6);
			expect(Array.from(sampleDistinct(b, 7, 6, new Int32Array(6)))).toEqual(
				Array.from(out),
			);
		}
	});
	it("trialsNeeded matches the closed form", () => {
		expect(trialsNeeded(0.5, 2, 0.99)).toBe(
			Math.ceil(Math.log(0.01) / Math.log(0.75)),
		);
		expect(trialsNeeded(1, 3, 0.99)).toBe(1);
		expect(trialsNeeded(0, 3, 0.99)).toBe(Number.POSITIVE_INFINITY);
	});
});

describe("batch scoring", () => {
	const rnd = seededRandom(11);
	const s = synthRotation(60, 0.3, rnd);
	it("ties go to the lowest index (a strict-improvement sequential loop)", () => {
		const hyps = new Float64Array(4 * HYP_STRIDE);
		putHypothesis(hyps, 0, expSO3(0.5, 0, 0), null);
		putHypothesis(hyps, 1, s.R, null);
		putHypothesis(hyps, 2, s.R, null);
		putHypothesis(hyps, 3, expSO3(0, 0.5, 0), null);
		const w = scoreBatchCpu({
			mode: "chord",
			hyps,
			count: 4,
			a: s.b0,
			b: s.b1,
			n: 60,
			thr2: chord2OfAngle(0.005),
		});
		expect(w.index).toBe(1);
		expect(w.count).toBe(60 - s.nOut);
	});
	it("reproj picks the lowest MSAC cost and counts points behind the camera as outliers", () => {
		const a = synthAbsolute(40, 0, rnd);
		const obs = new Float64Array(80);
		for (let i = 0; i < 40; i++) {
			obs[i * 2] = a.p2[i * 2] - a.cx;
			obs[i * 2 + 1] = a.p2[i * 2 + 1] - a.cy;
		}
		const hyps = new Float64Array(3 * HYP_STRIDE);
		const flipped = mul3(expSO3(0, Math.PI, 0), a.R);
		putHypothesis(hyps, 0, flipped, a.t, a.f, a.f);
		putHypothesis(hyps, 1, a.R, [a.t[0] + 3, a.t[1], a.t[2]], a.f, a.f);
		putHypothesis(hyps, 2, a.R, a.t, a.f, a.f);
		const batch: HypothesisBatch = {
			mode: "reproj",
			hyps,
			count: 3,
			a: a.p3,
			b: obs,
			n: 40,
			thr2: 36,
		};
		expect(scoreHypothesis(batch, 0).count).toBe(0);
		expect(scoreBatchCpu(batch).index).toBe(2);
	});
	it("driveSync and driveAsync run the same loop to the same answer", async () => {
		const x = driveSync(
			rotationRansacLoop(s.b0, s.b1, { maxChord: 0.005, maxIterations: 300 }),
		);
		const y = await driveAsync(
			rotationRansacLoop(s.b0, s.b1, { maxChord: 0.005, maxIterations: 300 }),
			async (b) => scoreBatchCpu(b),
		);
		expect(Array.from(y?.R ?? [])).toEqual(Array.from(x?.R ?? []));
	});
});

describe("rotationRansac (run_propagate.rot_ransac port)", () => {
	it.each([0.3, 0.6, 0.85])("recovers R with %f outliers", (out) => {
		const s = synthRotation(400, out, seededRandom(21));
		const r = rotationRansac(s.b0, s.b1, { maxChord: 0.004 });
		expect(r).not.toBeNull();
		expect(rotationDistanceDeg(r?.R ?? [], s.R)).toBeLessThan(0.02);
		expect(agreement(r?.inliers ?? [], truthMask(400, s.nOut))).toBeGreaterThan(
			0.97,
		);
		expect(r?.rmsChord ?? 1).toBeLessThan(0.002);
	});
	it("is deterministic per seed and null below 3 pairs", () => {
		const s = synthRotation(100, 0.5, seededRandom(1));
		const a = rotationRansac(s.b0, s.b1, { seed: 4 });
		const b = rotationRansac(s.b0, s.b1, { seed: 4 });
		expect(Array.from(a?.R ?? [])).toEqual(Array.from(b?.R ?? []));
		expect(rotationRansac(s.b0.subarray(0, 6), s.b1.subarray(0, 6))).toBeNull();
	});
	it("maxErrorDeg is the angle whose chord is maxChord", () => {
		const s = synthRotation(200, 0.5, seededRandom(8));
		const chord = 0.004;
		const deg = (2 * Math.asin(chord / 2) * 180) / Math.PI;
		const a = rotationRansac(s.b0, s.b1, {
			maxChord: chord,
			maxIterations: 200,
		});
		const b = rotationRansac(s.b0, s.b1, {
			maxErrorDeg: deg,
			maxIterations: 200,
		});
		expect(b?.inlierCount).toBe(a?.inlierCount);
	});
	it("an adaptive stop scores fewer hypotheses on clean data", () => {
		const s = synthRotation(300, 0.1, seededRandom(9));
		const r = rotationRansac(s.b0, s.b1, {
			maxChord: 0.004,
			confidence: 0.999,
		});
		expect(r?.iterations).toBeLessThan(2000);
		expect(rotationDistanceDeg(r?.R ?? [], s.R)).toBeLessThan(0.02);
	});
});

describe("cameraRotationRansac (match.solve_rotation port)", () => {
	it("triad maps the first pair exactly and the plane of both", () => {
		const R = expSO3(0.2, 0.9, -0.3);
		const a1 = [0.1, 0.2, 1];
		const a2 = [-0.4, 0.1, 1];
		const ap = (v: number[]) =>
			[0, 1, 2].map(
				(r) => R[r * 3] * v[0] + R[r * 3 + 1] * v[1] + R[r * 3 + 2] * v[2],
			);
		expect(rotationDistanceDeg(triad(a1, a2, ap(a1), ap(a2)), R)).toBeLessThan(
			1e-6,
		);
	});
	it.each([
		"fixed",
		"free",
	] as const)("recovers the rotation (%s focal) with half outliers", (focal) => {
		const s = synthAbsolute(500, 0.5, seededRandom(31));
		const dirs = new Float64Array(s.p3.length);
		for (let i = 0; i < dirs.length; i++) dirs[i] = s.p3[i] - s.eye[i % 3];
		const f0 = focal === "free" ? s.f * 1.06 : s.f;
		const r = cameraRotationRansac(
			s.p2,
			dirs,
			{ fx: f0, fy: f0, cx: s.cx, cy: s.cy },
			{ focal },
		);
		expect(r).not.toBeNull();
		expect(rotationDistanceDeg(r?.R ?? [], s.R)).toBeLessThan(0.02);
		if (focal === "free")
			expect(Math.abs((r?.focal ?? 0) / s.f - 1)).toBeLessThan(0.005);
		else expect(r?.focal).toBe(s.f);
		expect(agreement(r?.inliers ?? [], truthMask(500, s.nOut))).toBeGreaterThan(
			0.97,
		);
		expect(r?.rmsPx ?? 9).toBeLessThan(2);
	});
	it("returns null below minInliers", () => {
		const s = synthAbsolute(5, 0, seededRandom(2));
		expect(
			cameraRotationRansac(s.p2, s.p3, {
				fx: 1000,
				fy: 1000,
				cx: 512,
				cy: 384,
			}),
		).toBeNull();
	});
});

describe("minimal solvers", () => {
	const s = synthAbsolute(10, 0, seededRandom(41), 0);
	const bear = (i: number) => {
		const x = (s.p2[i * 2] - s.cx) / s.f;
		const y = (s.p2[i * 2 + 1] - s.cy) / s.f;
		const l = Math.hypot(x, y, 1);
		return [x / l, y / l, 1 / l];
	};
	it("p3pGrunert has the true pose among its solutions", () => {
		const Rs = new Float64Array(36);
		const ts = new Float64Array(12);
		const m = p3pGrunert(
			[...bear(0), ...bear(1), ...bear(2)],
			s.p3.subarray(0, 9),
			Rs,
			ts,
		);
		expect(m).toBeGreaterThan(0);
		let best = Number.POSITIVE_INFINITY;
		for (let j = 0; j < m; j++)
			best = Math.min(
				best,
				rotationDistanceDeg(Rs.subarray(j * 9, j * 9 + 9), s.R),
			);
		expect(best).toBeLessThan(1e-4);
	});
	it("dltFocal recovers R, t and the focal scale from 6 exact points", () => {
		const xn = new Float64Array(20);
		for (let i = 0; i < 10; i++) {
			xn[i * 2] = (s.p2[i * 2] - s.cx) / (s.f * 0.8);
			xn[i * 2 + 1] = (s.p2[i * 2 + 1] - s.cy) / (s.f * 0.8);
		}
		const m = dltFocal(xn, s.p3, [0, 1, 2, 3, 4, 5]);
		expect(m).not.toBeNull();
		expect(m?.scale ?? 0).toBeCloseTo(1.25, 4);
		expect(rotationDistanceDeg(m?.R ?? [], s.R)).toBeLessThan(1e-3);
		expect(
			Math.hypot(...[0, 1, 2].map((k) => (m?.t[k] ?? 0) - s.t[k])),
		).toBeLessThan(0.5);
	});
});

describe("refinePoseLm", () => {
	it("converges from a perturbed pose (rotation, translation, focal)", () => {
		const s = synthAbsolute(80, 0, seededRandom(51), 0.5);
		const obs = new Float64Array(160);
		for (let i = 0; i < 80; i++) {
			obs[i * 2] = s.p2[i * 2] - s.cx;
			obs[i * 2 + 1] = s.p2[i * 2 + 1] - s.cy;
		}
		const state = {
			R: mul3(expSO3(0.01, -0.008, 0.005), s.R),
			t: Float64Array.from([s.t[0] + 20, s.t[1] - 15, s.t[2] + 10]),
			fx: s.f * 1.05,
			fy: s.f * 1.05,
		};
		refinePoseLm(s.p3, obs, state, {
			translation: true,
			focal: true,
			loss: "cauchy",
			scale: 3,
		});
		expect(rotationDistanceDeg(state.R, s.R)).toBeLessThan(0.01);
		expect(Math.abs(state.fx / s.f - 1)).toBeLessThan(0.003);
	});
});

describe("absolutePoseRansac (poselib estimate_absolute_pose port)", () => {
	it.each([
		0.2, 0.5, 0.7,
	])("fixed focal recovers the pose with %f outliers", (out) => {
		const s = synthAbsolute(300, out, seededRandom(61));
		const r = absolutePoseRansac(
			s.p2,
			s.p3,
			{ fx: s.f, fy: s.f, cx: s.cx, cy: s.cy },
			{ maxReprojErrorPx: 6 },
		);
		expect(r).not.toBeNull();
		expect(rotationDistanceDeg(r?.R ?? [], s.R)).toBeLessThan(0.05);
		const eye = [0, 1, 2].map(
			(k) =>
				-(
					(r?.R[k] ?? 0) * (r?.t[0] ?? 0) +
					(r?.R[3 + k] ?? 0) * (r?.t[1] ?? 0) +
					(r?.R[6 + k] ?? 0) * (r?.t[2] ?? 0)
				),
		);
		expect(
			Math.hypot(eye[0] - s.eye[0], eye[1] - s.eye[1], eye[2] - s.eye[2]),
		).toBeLessThan(5);
		expect(agreement(r?.inliers ?? [], truthMask(300, s.nOut))).toBeGreaterThan(
			0.97,
		);
		expect(r?.focal).toBeUndefined();
	});
	it("free focal recovers the focal from a 20 % wrong prior", () => {
		const s = synthAbsolute(300, 0.4, seededRandom(71));
		const f0 = s.f * 1.2;
		const r = absolutePoseRansac(
			s.p2,
			s.p3,
			{ fx: f0, fy: f0, cx: s.cx, cy: s.cy },
			{ maxReprojErrorPx: 6, focal: "free" },
		);
		expect(Math.abs((r?.focal ?? 0) / s.f - 1)).toBeLessThan(0.01);
		expect(rotationDistanceDeg(r?.R ?? [], s.R)).toBeLessThan(0.05);
	});
	it("works in normalised image coordinates and without the final refinement", () => {
		const s = synthAbsolute(200, 0.3, seededRandom(81));
		const xn = new Float64Array(s.p2.length);
		for (let i = 0; i < 200; i++) {
			xn[i * 2] = (s.p2[i * 2] - s.cx) / s.f;
			xn[i * 2 + 1] = (s.p2[i * 2 + 1] - s.cy) / s.f;
		}
		const r = absolutePoseRansac(
			xn,
			s.p3,
			{ fx: 1, fy: 1, cx: 0, cy: 0 },
			{ maxReprojErrorPx: 6 / s.f, refine: false },
		);
		expect(rotationDistanceDeg(r?.R ?? [], s.R)).toBeLessThan(0.1);
	});
	it("returns null for too few points", () => {
		const s = synthAbsolute(5, 0, seededRandom(2));
		expect(
			absolutePoseRansac(s.p2.subarray(0, 4), s.p3.subarray(0, 6), {
				fx: 1,
				fy: 1,
				cx: 0,
				cy: 0,
			}),
		).toBeNull();
		expect(
			absolutePoseRansac(
				s.p2,
				s.p3,
				{ fx: 1000, fy: 1000, cx: 512, cy: 384 },
				{ focal: "free" },
			),
		).toBeNull();
	});
});

describe("async variants without a GPU", () => {
	it("score on the CPU and agree with the sync solvers", async () => {
		const paths: string[] = [];
		const s = synthRotation(200, 0.5, seededRandom(91));
		const a = rotationRansac(s.b0, s.b1, { maxChord: 0.004 });
		const b = await rotationRansacAsync(s.b0, s.b1, {
			maxChord: 0.004,
			gpu: "off",
			onBatch: (p) => paths.push(p),
		});
		expect(paths).toEqual(["cpu"]);
		expect(Array.from(b?.R ?? [])).toEqual(Array.from(a?.R ?? []));
		const t = synthAbsolute(150, 0.3, seededRandom(92));
		const cam = { fx: t.f, fy: t.f, cx: t.cx, cy: t.cy };
		const c = await absolutePoseRansacAsync(t.p2, t.p3, cam, {
			maxReprojErrorPx: 6,
			gpu: "off",
		});
		expect(rotationDistanceDeg(c?.R ?? [], t.R)).toBeLessThan(0.05);
		const dirs = new Float64Array(t.p3.length);
		for (let i = 0; i < dirs.length; i++) dirs[i] = t.p3[i] - t.eye[i % 3];
		const d = await cameraRotationRansacAsync(t.p2, dirs, cam, { gpu: "off" });
		expect(rotationDistanceDeg(d?.R ?? [], t.R)).toBeLessThan(0.05);
	});
	it("auto falls back to the CPU in node (no compute device)", async () => {
		const paths: string[] = [];
		const s = synthRotation(400, 0.5, seededRandom(93));
		await rotationRansacAsync(s.b0, s.b1, {
			maxChord: 0.004,
			minGpuWork: 0,
			onBatch: (p) => paths.push(p),
		});
		expect(paths).toEqual(["cpu"]);
	});
});
