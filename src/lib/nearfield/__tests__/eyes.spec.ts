// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { seededRandom } from "#/test/helpers";
import type { Pose } from "../../camera";
import { camToEnuMatrix } from "../lift";
import {
	dropInconsistent,
	type EyeCam,
	type EyePair,
	eyePairGate,
	invert,
	pairTranslation,
	REFINE_EYES_DEFAULT,
	refineEyes,
	robustLM,
	rodrigues,
	solveEyeOffsets,
	solveLinear,
	type Vec3,
} from "../roll/eyes";

const dist = (a: ArrayLike<number>, b: ArrayLike<number>) =>
	Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

describe("rodrigues", () => {
	it("is identity for a zero vector and a proper rotation otherwise", () => {
		expect(rodrigues([0, 0, 0])).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
		const R = rodrigues([0.3, -0.5, 0.2]);
		for (let a = 0; a < 3; a++)
			for (let b = 0; b < 3; b++) {
				const dot = R[a] * R[b] + R[3 + a] * R[3 + b] + R[6 + a] * R[6 + b];
				expect(dot).toBeCloseTo(a === b ? 1 : 0, 12);
			}
	});
	it("rotates by the vector's angle about its axis", () => {
		const R = rodrigues([0, 0, Math.PI / 2]); // 90 deg about z: x -> y
		expect(R[0]).toBeCloseTo(0, 12);
		expect(R[3]).toBeCloseTo(1, 12);
		expect(R[1]).toBeCloseTo(-1, 12);
	});
});

describe("solveLinear / invert", () => {
	it("solves a known system, including one needing a pivot swap", () => {
		const A = [0, 2, 1, 1, 0, 3, 4, 1, 0];
		const x = [1, -2, 3];
		const b = [0, 1, 2].map(
			(r) => A[3 * r] * x[0] + A[3 * r + 1] * x[1] + A[3 * r + 2] * x[2],
		);
		const s = solveLinear(A, b, 3);
		expect(s).not.toBeNull();
		s?.forEach((v, i) => {
			expect(v).toBeCloseTo(x[i], 10);
		});
	});
	it("returns null for singular systems", () => {
		expect(solveLinear([1, 2, 2, 4], [1, 2], 2)).toBeNull();
		expect(invert([1, 2, 2, 4], 2)).toBeNull();
	});
	it("invert gives A * A^-1 = I", () => {
		const A = [4, 1, 0, 1, 3, 1, 0, 1, 2];
		const inv = invert(A, 3) as number[];
		for (let i = 0; i < 3; i++)
			for (let j = 0; j < 3; j++) {
				let s = 0;
				for (let k = 0; k < 3; k++) s += A[3 * i + k] * inv[3 * k + j];
				expect(s).toBeCloseTo(i === j ? 1 : 0, 10);
			}
	});
});

describe("robustLM", () => {
	it("fits a line by least squares (fScale = Infinity)", () => {
		const xs = [0, 1, 2, 3, 4, 5];
		const fn = (p: number[]) => xs.map((x) => p[0] * x + p[1] - (2 * x + 1));
		const r = robustLM(fn, [0, 0], Number.POSITIVE_INFINITY);
		expect(r.p[0]).toBeCloseTo(2, 5);
		expect(r.p[1]).toBeCloseTo(1, 5);
		expect(r.cost).toBeLessThan(1e-8);
		expect(r.JtWJ).toHaveLength(4);
	});
	it("soft-L1 resists an outlier that least squares follows", () => {
		const xs = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
		const y = xs.map((_x, i) => (i === 9 ? 100 : 3));
		const fn = (p: number[]) => xs.map((_, i) => p[0] - y[i]);
		const ls = robustLM(fn, [0], Number.POSITIVE_INFINITY);
		const rob = robustLM(fn, [0], 0.5);
		expect(Math.abs(rob.p[0] - 3)).toBeLessThan(Math.abs(ls.p[0] - 3));
		expect(rob.p[0]).toBeCloseTo(3, 0);
	});
});

function project(c: EyeCam, X: number[]) {
	const M = camToEnuMatrix(c.pose);
	const v = [0, 1, 2].map(
		(k) =>
			M[k] * (X[0] - c.eye[0]) +
			M[3 + k] * (X[1] - c.eye[1]) +
			M[6 + k] * (X[2] - c.eye[2]),
	);
	if (!(v[2] > 0.1)) return null;
	const f = c.height / 2 / Math.tan((c.pose.vfov * Math.PI) / 360);
	const x = c.width / 2 + (f * v[0]) / v[2];
	const y = c.height / 2 + (f * v[1]) / v[2];
	return x >= 0 && x < c.width && y >= 0 && y < c.height ? [x, y] : null;
}

function synthPair(tTrue: Vec3, nNear: number, nFar: number, seed = 7) {
	const rnd = seededRandom(seed);
	const poseA: Pose = { yaw: 10, pitch: -5, roll: 1, vfov: 60 };
	const poseB: Pose = { yaw: 25, pitch: -4, roll: -1, vfov: 60 };
	const A: EyeCam = {
		id: "A",
		pose: poseA,
		eye: [0, 0, 1000],
		width: 1024,
		height: 768,
	};
	const B: EyeCam = {
		id: "B",
		pose: poseB,
		eye: [tTrue[0], tTrue[1], 1000 + tTrue[2]],
		width: 1024,
		height: 768,
	};
	const ka: number[] = [];
	const kb: number[] = [];
	const dA: number[] = [];
	const dB: number[] = [];
	let guard = 0;
	while (dA.length < nNear + nFar && guard++ < 100_000) {
		const far = dA.length >= nNear;
		const d = far ? 1500 + 2500 * rnd() : 6 + 40 * rnd();
		const yaw = ((12 + 20 * (rnd() - 0.5)) * Math.PI) / 180;
		const el = ((-8 + 10 * (rnd() - 0.5)) * Math.PI) / 180;
		const X = [
			d * Math.sin(yaw) * Math.cos(el),
			d * Math.cos(yaw) * Math.cos(el),
			1000 + d * Math.sin(el),
		];
		const pa = project(A, X);
		const pb = project(B, X);
		if (!pa || !pb) continue;
		ka.push(pa[0], pa[1]);
		kb.push(pb[0], pb[1]);
		dA.push(Math.hypot(X[0], X[1], X[2] - 1000));
		dB.push(Math.hypot(X[0] - B.eye[0], X[1] - B.eye[1], X[2] - B.eye[2]));
	}
	// the solver is handed a wrong GPS eye for B
	const Bgps: EyeCam = { ...B, eye: [B.eye[0] + 6, B.eye[1] - 4, B.eye[2]] };
	return { A, B: Bgps, m: { ka, kb, depthA: dA, depthB: dB } };
}

describe("pairTranslation", () => {
	it("recovers the true eye difference from exact matches", () => {
		const t: Vec3 = [1.2, -0.8, 0.3];
		const s = synthPair(t, 60, 120);
		const p = pairTranslation(s.A, s.B, s.m, { calib: "none" });
		expect(p.ok).toBe(true);
		expect(dist(p.t, t)).toBeLessThan(0.1);
		expect(p.baselineM).toBeCloseTo(Math.hypot(...t), 1);
		expect(p.inliers).toBeGreaterThan(150);
		expect(p.nearInliers).toBeGreaterThan(50);
		expect(p.medPx).toBeLessThan(0.5);
		expect(p.gpsDist).toBeCloseTo(Math.hypot(7.2, -4.8, 0.3), 6);
		expect(p.info).toHaveLength(9);
		expect(p.info[0]).toBeGreaterThan(0);
		eyePairGate(p);
		expect(p.gate).toBe(true);
		expect(p.why).toBeUndefined();
	});
	it("rot calibration keeps nuisances near identity on clean data", () => {
		const s = synthPair([0.5, 0.4, 0], 60, 120, 11);
		const p = pairTranslation(s.A, s.B, s.m, { calib: "rot" });
		expect(p.focalScale).toEqual([1, 1]);
		expect(p.relRotCorrDeg).toBeLessThan(0.2);
		expect(dist(p.t, [0.5, 0.4, 0])).toBeLessThan(0.3);
	});
	it("fails softly (ok=false) with fewer than 20 usable matches", () => {
		const s = synthPair([1, 0, 0], 10, 5);
		const p = pairTranslation(s.A, s.B, s.m);
		expect(p.ok).toBe(false);
		expect(p.used).toBe(15);
		expect(p.t).toEqual([0, 0, 0]);
		eyePairGate(p);
		expect(p.gate).toBe(false);
		expect(p.why).toBe("no solve");
	});
	it("ignores matches without depth in either photo", () => {
		const s = synthPair([1, 0, 0], 40, 40);
		const depthA = s.m.depthA.map((_, i) => (i < 30 ? 0 : s.m.depthA[i]));
		const depthB = s.m.depthB.map((_, i) =>
			i < 30 ? Number.NaN : s.m.depthB[i],
		);
		const p = pairTranslation(s.A, s.B, { ...s.m, depthA, depthB });
		expect(p.used).toBe(50);
	});
	it("far-only pairs lack near evidence and fail the gate", () => {
		const s = synthPair([30, 10, 0], 0, 120);
		const p = pairTranslation(s.A, s.B, s.m);
		eyePairGate(p);
		expect(p.nearInliers).toBe(0);
		expect(p.gate).toBe(false);
		expect(p.why).toBe("no near evidence");
	});
});

const basePair: EyePair = {
	a: "a",
	b: "b",
	ok: true,
	t: [0.2, 0, 0],
	info: [1e4, 0, 0, 0, 1e4, 0, 0, 0, 1e4],
	baselineM: 0.2,
	used: 100,
	inliers: 100,
	nearInliers: 50,
	medPx: 1,
	relRotCorrDeg: 0,
	focalScale: [1, 1],
	gpsDist: 6.7,
};

describe("eyePairGate", () => {
	it("names the first failing criterion and honours overrides", () => {
		expect(eyePairGate({ ...basePair, inliers: 10 })).toBe(false);
		const bad = { ...basePair, medPx: 5 };
		eyePairGate(bad);
		expect(bad.why).toBe("residual");
		const nan = { ...basePair, medPx: Number.NaN };
		eyePairGate(nan);
		expect(nan.why).toBe("residual");
		const few = { ...basePair, nearInliers: 5 };
		eyePairGate(few);
		expect(few.why).toBe("no near evidence");
		expect(eyePairGate({ ...few }, { minNear: 5 })).toBe(true);
		expect(eyePairGate({ ...basePair })).toBe(true);
	});
});

describe("dropInconsistent", () => {
	const mk = (a: string, b: string, t: Vec3, near: number): EyePair => ({
		...basePair,
		a,
		b,
		t,
		baselineM: Math.hypot(...t),
		nearInliers: near,
		gate: true,
	});
	it("ungates the weakest pair of an inconsistent triangle", () => {
		const ps = [
			mk("a", "b", [10, 0, 0], 50),
			mk("b", "c", [10, 0, 0], 30),
			mk("a", "c", [40, 0, 0], 3),
		];
		dropInconsistent(ps);
		expect(ps[2].gate).toBe(false);
		expect(ps[2].why).toBe("triplet closure");
		expect(ps[0].gate && ps[1].gate).toBe(true);
	});
	it("leaves a consistent triangle and open chains alone", () => {
		const ok = [
			mk("a", "b", [10, 0, 0], 5),
			mk("b", "c", [10, 5, 0], 5),
			mk("a", "c", [20, 5, 0], 5),
		];
		dropInconsistent(ok);
		expect(ok.every((p) => p.gate)).toBe(true);
		const chain = [mk("a", "b", [10, 0, 0], 5), mk("b", "c", [99, 0, 0], 5)];
		dropInconsistent(chain);
		expect(chain.every((p) => p.gate)).toBe(true);
	});
});

describe("solveEyeOffsets / refineEyes", () => {
	const slope = (e: number, n: number) => 1000 + 0.1 * e - 0.05 * n;
	const eyes: Record<string, Vec3> = {
		a: [0, 0, slope(0, 0) + 1.6],
		b: [3, 6, slope(3, 6) + 1.6],
		c: [80, 20, slope(80, 20) + 1.6],
	};
	it("honours the pair, keeps the component mean and puts z on the DEM", () => {
		const s = solveEyeOffsets(eyes, [{ ...basePair, gate: true }], slope);
		const ea = s.eyes.a;
		const eb = s.eyes.b;
		expect(Math.abs(eb[0] - ea[0] - 0.2)).toBeLessThan(0.4);
		expect(Math.abs(eb[1] - ea[1])).toBeLessThan(0.4);
		expect((ea[0] + eb[0]) / 2).toBeCloseTo(1.5, 1);
		expect((ea[1] + eb[1]) / 2).toBeCloseTo(3, 1);
		expect(Math.abs(ea[2] - (slope(ea[0], ea[1]) + 1.6))).toBeLessThan(0.3);
		expect(dist(s.eyes.c, eyes.c)).toBeLessThan(0.05);
		expect(s.pairsUsed).toEqual(["a-b"]);
		expect(s.components.map((c) => c.length).sort()).toEqual([1, 2]);
		expect(s.offsets.a).toHaveLength(3);
	});
	it("ignores ungated pairs and pairs with unknown ids", () => {
		const s = solveEyeOffsets(
			eyes,
			[
				{ ...basePair, gate: false },
				{ ...basePair, a: "zz", gate: true },
			],
			slope,
		);
		expect(s.pairsUsed).toEqual([]);
		expect(s.components).toHaveLength(3);
	});
	it("drops the z term where the DEM is unknown", () => {
		const s = solveEyeOffsets(eyes, [{ ...basePair, gate: true }], () => null);
		expect(s.eyes.a[2]).toBeCloseTo(eyes.a[2], 3);
	});
	it("refineEyes gates, filters and returns null when nothing survives", () => {
		expect(
			refineEyes(eyes, [{ ...basePair, nearInliers: 0 }], slope),
		).toBeNull();
		const r = refineEyes(eyes, [{ ...basePair }], slope);
		expect(r).not.toBeNull();
		expect(r?.pairs[0].gate).toBe(true);
		expect(r?.pairsUsed).toEqual(["a-b"]);
	});
	it("is off by default", () => {
		expect(REFINE_EYES_DEFAULT).toBe(false);
	});
});
