// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import {
	type CameraX,
	IDENTITY_INTRINSICS,
	projectX,
	type Vec3,
} from "../../../concord/core";
import { DEG } from "../../../geodesy";
import type { EyeHorizon } from "../../../pose6dof/eye";
import {
	cameraXFromState,
	type Factor,
	type GeoState,
	IDX,
	NP,
	stateFromCameraX,
} from "../../core";
import {
	altFactor,
	COMPASS_DEFAULTS,
	compassFactor,
	concordCueFactors,
	focalFactor,
	gpsFactor,
	gravityFactor,
	groundFactor,
	lakeFloorFactor,
	linHorizonEl,
	pointFactor,
	skylineFactor,
} from "../factors";
import { focalPx1600, type JointCue } from "../joint-residual";

const base: CameraX = {
	pose: { yaw: 30, pitch: 5, roll: 3, vfov: 40 },
	eye: [0, 0, 0],
	aspect: 1.5,
	intr: { ...IDENTITY_INTRINSICS },
};
const x0 = () => stateFromCameraX(base);
const withState = (
	x: GeoState,
	patch: Partial<Record<keyof typeof IDX, number>>,
) => {
	const y = Float64Array.from(x);
	for (const [k, v] of Object.entries(patch))
		y[IDX[k as keyof typeof IDX]] += v as number;
	return y;
};

// the solver's central-difference steps (core/types.ts Factor docs)
const STEPS = [1e-3, 1e-3, 1e-3, 1e-4, 0.5, 0.5, 0.5];

function fdJacobian(f: Factor, x: GeoState): Float64Array {
	const J = new Float64Array(f.dim * NP);
	for (let c = 0; c < NP; c++) {
		const xp = Float64Array.from(x);
		const xm = Float64Array.from(x);
		xp[c] += STEPS[c];
		xm[c] -= STEPS[c];
		const rp = f.residual(xp);
		const rm = f.residual(xm);
		for (let r = 0; r < f.dim; r++)
			J[r * NP + c] = (rp[r] - rm[r]) / (2 * STEPS[c]);
	}
	return J;
}

function expectJacobianMatchesFD(f: Factor, x: GeoState, tol = 1e-5) {
	const A = f.jacobian?.(x);
	expect(A).toBeDefined();
	const F = fdJacobian(f, x);
	expect(A?.length).toBe(f.dim * NP);
	for (let i = 0; i < F.length; i++) {
		const scale = Math.max(1, Math.abs(F[i]));
		expect(Math.abs((A as Float64Array)[i] - F[i]) / scale).toBeLessThan(tol);
	}
}

describe("prior factors: analytic Jacobians match finite differences", () => {
	const x = withState(x0(), { E: 3.2, N: -4.1, U: 7.5, logf: 0.05 });
	it("gps", () => expectJacobianMatchesFD(gpsFactor(1, 2, 10), x));
	it("alt", () => expectJacobianMatchesFD(altFactor(500, -7, 3), x));
	it("gravity", () => expectJacobianMatchesFD(gravityFactor(4, 2, 1.5), x));
	it("compass (including across the 0/360 seam)", () => {
		expectJacobianMatchesFD(compassFactor(29), x);
		expectJacobianMatchesFD(compassFactor(359), withState(x0(), { yaw: -30 }));
	});
	it("focal", () => expectJacobianMatchesFD(focalFactor(1200, 1250, 30), x));
	it("ground on a sloped DEM, above and below the 1.6 m stand height", () => {
		const ground = (e: number, n: number) => 0.3 * e - 0.1 * n + 2;
		const f = groundFactor(ground);
		expectJacobianMatchesFD(f, withState(x0(), { U: 20 }));
		expectJacobianMatchesFD(f, withState(x0(), { U: -20 }));
	});
	it("lakeFloor above and below the floor", () => {
		const f = lakeFloorFactor(-5);
		expectJacobianMatchesFD(f, withState(x0(), { U: 10 }));
		expectJacobianMatchesFD(f, withState(x0(), { U: -10 }));
	});
});

describe("prior factors: residual semantics", () => {
	it("are flagged prior and are zero at their own measurement", () => {
		const x = withState(x0(), { E: 10, N: 20, U: 30 });
		const zeros: Factor[] = [
			gpsFactor(10, 20, 5),
			altFactor(30 + -7, -7),
			gravityFactor(5, 3),
			compassFactor(30),
			focalFactor(1000, 1000, 20),
			lakeFloorFactor(0),
		];
		for (const f of zeros) {
			expect(f.prior).toBe(true);
			for (const r of f.residual(x)) expect(Math.abs(r)).toBeLessThan(1e-12);
		}
	});

	it("gps is sigma-normalised in E and N", () => {
		const r = gpsFactor(0, 0, 5).residual(withState(x0(), { E: 10, N: -15 }));
		expect(Array.from(r)).toEqual([2, -3]);
	});

	it("ground is asymmetric: below the DEM is penalised with the smaller sigma", () => {
		const f = groundFactor(() => 0, 1.6, 2, 0.5);
		const up = f.residual(withState(x0(), { U: 1.6 + 1 }))[0];
		const down = f.residual(withState(x0(), { U: 1.6 - 1 }))[0];
		expect(up).toBeCloseTo(0.5, 12);
		expect(down).toBeCloseTo(-2, 12);
	});

	it("ground drops a non-finite DEM gradient instead of poisoning the Jacobian", () => {
		const f = groundFactor((e) => (e > 0 ? Number.NaN : 0));
		const J = f.jacobian?.(x0()) as Float64Array;
		expect(J[IDX.E]).toBe(0);
		expect(Number.isFinite(J[IDX.U])).toBe(true);
	});

	it("compass wraps the heading difference and uses a Student-t loss", () => {
		const f = compassFactor(358);
		expect(f.loss).toEqual({ kind: "student", nu: COMPASS_DEFAULTS.nu });
		const s = Math.hypot(
			COMPASS_DEFAULTS.sigmaNoiseDeg,
			COMPASS_DEFAULTS.sigmaBiasDeg,
		);
		// yaw 2 vs heading 358: 4 degrees apart, not 356
		expect(f.residual(withState(x0(), { yaw: 2 - 30 }))[0]).toBeCloseTo(
			4 / s,
			12,
		);
	});

	it("gravity wraps roll across +-180", () => {
		const f = gravityFactor(0, 179, 1);
		const r = f.residual(withState(x0(), { pitch: -5, roll: -3 - 178 }));
		// roll -178 vs 179 is 3 degrees apart across the seam (not 357)
		expect(r[1]).toBeCloseTo(3, 9);
	});

	it("lakeFloor is one-sided with the 0.3 m default margin", () => {
		const f = lakeFloorFactor(10);
		expect(f.residual(withState(x0(), { U: 11 }))[0]).toBe(0);
		expect(f.residual(withState(x0(), { U: 10.3 - 0.25 }))[0]).toBeCloseTo(
			1,
			9,
		);
	});
});

describe("pointFactor", () => {
	const dirs: [number, number][] = [
		[28, 4],
		[33, 6],
		[30, 2],
		[25, 8],
	];
	const world = (az: number, el: number, d: number): Vec3 => [
		d * Math.cos(el * DEG) * Math.sin(az * DEG),
		d * Math.cos(el * DEG) * Math.cos(az * DEG),
		d * Math.sin(el * DEG),
	];
	const corrs = dirs.map(([az, el], i) => {
		const w = world(az, el, 800 + 500 * i);
		const q = projectX(base, w);
		if (!q) throw new Error("test point behind camera");
		return { u: q.u, v: q.v, world: w };
	});

	it("has zero residual at the true pose (with and without cluster whitening)", () => {
		for (const o of [{}, { cluster: null }, { demSigmaM: null }]) {
			const f = pointFactor(base, corrs, o);
			expect(f.dim).toBe(2 * corrs.length);
			for (const r of f.residual(x0())) expect(Math.abs(r)).toBeLessThan(1e-9);
		}
	});

	it("scales a small yaw error to sigma-normalised pixels at 1600", () => {
		const f = pointFactor(base, corrs, { demSigmaM: null, sigmaPx: 2 });
		const r = f.residual(withState(x0(), { yaw: 0.1 }));
		// yaw +0.1 deg moves the points ~ f * 0.1 deg left in px, f in px@1600
		const fpx = focalPx1600(base);
		const rowU = Array.from(r).filter((_, i) => i % 2 === 0);
		const mean = rowU.reduce((a, b) => a + b, 0) / rowU.length;
		expect(Math.abs(mean)).toBeGreaterThan((0.5 * (fpx * 0.1 * DEG)) / 2);
		expect(Math.abs(mean)).toBeLessThan((1.5 * (fpx * 0.1 * DEG)) / 2);
	});

	it("marks a point behind the camera as NaN rows without cluster whitening", () => {
		const f = pointFactor(
			base,
			[{ u: 0.5, v: 0.5, world: world(210, 0, 500) }],
			{ demSigmaM: null },
		);
		const r = f.residual(x0());
		expect(Number.isNaN(r[0]) && Number.isNaN(r[1])).toBe(true);
	});

	it("only exposes relinearize when cluster whitening is on", () => {
		expect(
			pointFactor(base, corrs, { cluster: null }).relinearize,
		).toBeUndefined();
		expect(pointFactor(base, corrs, {}).relinearize).toBeTypeOf("function");
	});

	it("a larger demSigma (farther point) shrinks the residual of the same pixel error", () => {
		const near = pointFactor(base, [{ ...corrs[0], u: corrs[0].u + 0.01 }], {
			cluster: null,
		});
		const far = pointFactor(base, [{ ...corrs[0], u: corrs[0].u + 0.01 }], {
			cluster: null,
			demSigmaM: () => 200,
		});
		expect(Math.abs(far.residual(x0())[0])).toBeLessThan(
			Math.abs(near.residual(x0())[0]),
		);
	});
});

describe("concordCueFactors", () => {
	const w: Vec3 = [100, 800, 40];
	const q = projectX(base, w) as { u: number; v: number };
	const point = (src: string, du = 0): JointCue => ({
		kind: "point",
		u: q.u + du,
		v: q.v,
		world: w,
		depthM: 800,
		sigmaPx: 2,
		source: src,
	});

	it("groups by kind and pin-ness, with per-kind nEff and uncapped pins", () => {
		const fs = concordCueFactors(base, [
			point("auto"),
			point("auto"),
			point("pin:a"),
		]);
		expect(fs.map((f) => f.name).sort()).toEqual([
			"cue:point",
			"cue:point:pin",
		]);
		const auto = fs.find((f) => f.name === "cue:point") as Factor;
		const pin = fs.find((f) => f.name === "cue:point:pin") as Factor;
		expect(auto.dim).toBe(4);
		expect(auto.nEff).toBe(60);
		expect(pin.dim).toBe(2);
		expect(pin.nEff).toBeUndefined();
		expect(auto.family).toBe("point");
	});

	it("drops non-finite and zero-sigma cues", () => {
		const fs = concordCueFactors(base, [
			{ ...point("a"), u: Number.NaN },
			{ ...point("a"), sigmaPx: 0 },
		]);
		expect(fs).toEqual([]);
	});

	it("point cue residual is zero at truth and the pin keeps its raw sigma", () => {
		const [auto, pin] = (() => {
			const fs = concordCueFactors(base, [point("auto"), point("pin:a")]);
			return [
				fs.find((f) => !f.name.endsWith("pin")),
				fs.find((f) => f.name.endsWith("pin")),
			] as Factor[];
		})();
		for (const r of auto.residual(x0())) expect(Math.abs(r)).toBeLessThan(1e-9);
		// the same 3 px error: the pin (sigma 2) is whitened harder than the DEM-inflated auto cue
		const f2 = concordCueFactors(base, [
			point("auto", 3 / 1600),
			point("pin:a", 3 / 1600),
		]);
		const a = f2.find((f) => !f.name.endsWith("pin")) as Factor;
		const p = f2.find((f) => f.name.endsWith("pin")) as Factor;
		expect(Math.abs(p.residual(x0())[0])).toBeGreaterThan(
			Math.abs(a.residual(x0())[0]),
		);
		expect(pin.dim).toBe(2);
	});

	it("edge, level and shore cues: residual zero at the pose they were taken from", () => {
		const e = (() => {
			const c: JointCue = {
				kind: "edge",
				u: q.u,
				v: q.v,
				nu: 0.6,
				nv: 0.8,
				world: w,
				depthM: 800,
				sigmaPx: 1.5,
				source: "auto",
				residualPx: 0,
			};
			return c;
		})();
		const elTrue = Math.atan2(w[2], Math.hypot(w[0], w[1])) / DEG;
		const level: JointCue = {
			kind: "level",
			u: q.u,
			v: q.v,
			el: elTrue,
			depthM: 800,
			sigmaPx: 2,
			source: "auto",
		};
		for (const c of [e, level]) {
			const [f] = concordCueFactors(base, [c]);
			expect(f.dim).toBe(1);
			expect(Math.abs(f.residual(x0())[0])).toBeLessThan(1e-9);
		}
		// a level cue a few px off is non-zero and proportional to the error
		const [fo] = concordCueFactors(base, [{ ...level, el: elTrue + 0.05 }]);
		expect(Math.abs(fo.residual(x0())[0])).toBeGreaterThan(0.5);
	});

	it("edge cues honour the fixed edge bias", () => {
		const c: JointCue = {
			kind: "edge",
			u: q.u,
			v: q.v,
			nu: 1,
			nv: 0,
			world: w,
			depthM: 800,
			sigmaPx: 1,
			source: "auto",
			residualPx: 0,
		};
		const [f] = concordCueFactors(base, [c], { edgeBiasPx: -2 });
		expect(f.residual(x0())[0]).toBeCloseTo(2, 9);
	});
});

describe("skylineFactor", () => {
	// horizon rises 0.002 deg per metre of eye height: exactly linear, so the linearisation is exact
	const horizonAt = (eye: Vec3): EyeHorizon => ({
		step: 1,
		elevation: new Float64Array(360).fill(2 + 0.002 * eye[2]),
		distance: new Float64Array(360).fill(5000),
	});
	const mkAt = () => {
		let calls = 0;
		const fn = async (eyes: Vec3[]) => {
			calls++;
			return eyes.map(horizonAt);
		};
		return { fn, calls: () => calls };
	};
	const cam = { ...base, pose: { yaw: 0, pitch: 2, roll: 0, vfov: 40 } };
	const xs = () => stateFromCameraX(cam, cam);
	const samples = [
		{ u: 0.5, v: 0.5 },
		{ u: 0.5, v: 0.5, w: 4 },
		{ u: 0.5, v: 0.5, w: 0.25 },
	];

	it("refuses to evaluate before relinearize", () => {
		const f = skylineFactor(cam, samples, mkAt().fn);
		expect(() => f.residual(xs())).toThrow(/relinearize/);
	});

	it("is zero where the observed skyline sits on the DEM horizon and costs 7 horizons per relinearisation", async () => {
		const at = mkAt();
		const f = skylineFactor(cam, samples, at.fn, { cluster: null });
		await f.relinearize?.(xs());
		expect(f.horizonCalls()).toBe(7);
		for (const r of f.residual(xs())) expect(Math.abs(r)).toBeLessThan(1e-6);
		// same quantised eye: no new horizon requests
		await f.relinearize?.(withState(xs(), { E: 0.05 }));
		expect(f.horizonCalls()).toBe(7);
		expect(at.calls()).toBe(1);
		// a quantum step does re-linearise
		await f.relinearize?.(withState(xs(), { E: 1 }));
		expect(f.horizonCalls()).toBe(14);
	});

	it("tracks the eye linearly: raising U by 10 m lowers the sample against the horizon by 0.02 deg", async () => {
		const f = skylineFactor(cam, [samples[0]], mkAt().fn, { cluster: null });
		await f.relinearize?.(xs());
		const up = withState(xs(), { U: 10 });
		const r = f.residual(up)[0];
		const expected = (-0.02 * DEG * focalPx1600(cam)) / f.sigmas()[0];
		expect(r).toBeCloseTo(expected, 6);
	});

	it("gives heavier-weighted samples a smaller sigma", async () => {
		const f = skylineFactor(cam, samples, mkAt().fn, { cluster: null });
		await f.relinearize?.(xs());
		const [s0, s1, s2] = f.sigmas();
		expect(s1).toBeLessThan(s0);
		expect(s2).toBeGreaterThan(s0);
	});

	it("with eye=false takes a single horizon and does not follow eye changes", async () => {
		const f = skylineFactor(cam, [samples[0]], mkAt().fn, { eye: false });
		await f.relinearize?.(xs());
		expect(f.horizonCalls()).toBe(1);
		const r0 = f.residual(xs())[0];
		const r1 = f.residual(withState(xs(), { U: 10 }))[0];
		expect(r1).toBeCloseTo(r0, 9);
	});

	it("cluster whitening of a zero residual stays zero and keep() masks rows", async () => {
		const f = skylineFactor(cam, samples, mkAt().fn);
		await f.relinearize?.(xs());
		for (const r of f.residual(xs())) expect(Math.abs(r)).toBeLessThan(1e-6);
		const masked = f.residual(xs(), (i) => i !== 1);
		expect(Number.isNaN(masked[1])).toBe(true);
		expect(Number.isNaN(masked[0])).toBe(false);
	});

	it("linHorizonEl is NaN where the horizon has no data", () => {
		const nodata: EyeHorizon = {
			step: 1,
			elevation: new Float64Array(360).fill(-90),
		};
		expect(
			Number.isNaN(
				linHorizonEl(
					{ eL: [0, 0, 0], h0: nodata, d: null, delta: 5 },
					10,
					[0, 0, 0],
				),
			),
		).toBe(true);
	});
});

describe("state round trip used by every factor", () => {
	it("cameraXFromState inverts stateFromCameraX", () => {
		const cam = cameraXFromState(base, withState(x0(), { U: 3, logf: 0.1 }));
		expect(cam.eye[2]).toBe(3);
		expect(cam.intr.fScale).toBeCloseTo(Math.exp(0.1), 12);
	});
});
