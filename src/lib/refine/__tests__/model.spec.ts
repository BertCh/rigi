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
	type Camera,
	cameraFromAngles,
	directionENU,
	project,
} from "../../geo/camera";
import type { HorizonProfile } from "../../geo/horizon";
import { EARTH_R, REFRACTION_K } from "../../geodesy";
import {
	cameraFromParams,
	columnSigma,
	columnsFromSkyline,
	DEG,
	DEYE,
	evalColumn,
	type Geometry,
	horizonTable,
	KREF,
	LOGF,
	NPARAM,
	newEval,
	PARAM_NAMES,
	PITCH,
	paramsFromCamera,
	ROLL,
	sampleHorizon,
	YAW,
} from "../model";

const step = 0.5;
const n = 720;
const profile = (): HorizonProfile => {
	const elevation = new Float32Array(n);
	const distance = new Float32Array(n);
	for (let i = 0; i < n; i++) {
		const az = i * step;
		elevation[i] =
			3 +
			2 * Math.sin((az * Math.PI) / 37) +
			1.2 * Math.sin((az * Math.PI) / 11 + 1);
		distance[i] = 4000 + 3000 * Math.sin((az * Math.PI) / 50) ** 2;
	}
	return {
		step,
		elevation,
		distance,
		ridges: Array.from({ length: n }, () => []),
	};
};

describe("constants", () => {
	it("param indices line up with PARAM_NAMES", () => {
		expect(NPARAM).toBe(6);
		expect(PARAM_NAMES[YAW]).toBe("yaw");
		expect(PARAM_NAMES[PITCH]).toBe("pitch");
		expect(PARAM_NAMES[ROLL]).toBe("roll");
		expect(PARAM_NAMES[LOGF]).toBe("logf");
		expect(PARAM_NAMES[KREF]).toBe("k");
		expect(PARAM_NAMES[DEYE]).toBe("dEye");
	});
});

describe("horizonTable / sampleHorizon", () => {
	it("converts to radians and Float64", () => {
		const t = horizonTable(profile());
		expect(t.n).toBe(n);
		expect(t.el[10]).toBeCloseTo(profile().elevation[10] * DEG, 10);
		expect(t.dist).toBeInstanceOf(Float64Array);
	});
	it("interpolates linearly and wraps through north", () => {
		const t = horizonTable(profile());
		const out = { h: 0, slope: 0, d: 0, dSlope: 0 };
		sampleHorizon(t, 10.25, out);
		expect(out.h).toBeCloseTo((t.el[20] + t.el[21]) / 2, 12);
		expect(out.slope).toBeCloseTo((t.el[21] - t.el[20]) / (step * DEG), 9);
		sampleHorizon(t, 359.75, out);
		expect(out.h).toBeCloseTo((t.el[719] + t.el[0]) / 2, 12);
		const a = { ...sampleHorizon(t, -30, { h: 0, slope: 0, d: 0, dSlope: 0 }) };
		const b = { ...sampleHorizon(t, 330, { h: 0, slope: 0, d: 0, dSlope: 0 }) };
		expect(a).toEqual(b);
	});
	it("smoothing preserves a constant profile and lowers a peak", () => {
		const flat: HorizonProfile = {
			...profile(),
			elevation: new Float32Array(n).fill(5),
		};
		const sm = horizonTable(flat, 1);
		for (const v of sm.el) expect(v).toBeCloseTo(5 * DEG, 10);
		const spike = { ...profile(), elevation: new Float32Array(n) };
		spike.elevation[100] = 10;
		const t = horizonTable(spike, 1);
		expect(t.el[100]).toBeLessThan(10 * DEG);
		expect(t.el[100]).toBeGreaterThan(0);
		let sum = 0;
		for (const v of t.el) sum += v;
		expect(sum).toBeCloseTo(10 * DEG, 8); // a normalised filter conserves the area
	});
});

describe("paramsFromCamera / cameraFromParams", () => {
	const cam = cameraFromAngles({
		width: 800,
		height: 600,
		f: 900,
		yaw: 200,
		pitch: 3,
		roll: -2,
	});
	it("round trips and defaults k, dEye", () => {
		const p = paramsFromCamera(cam);
		expect(p[YAW]).toBeCloseTo(200 * DEG, 12);
		expect(p[LOGF]).toBe(0);
		expect(p[KREF]).toBe(REFRACTION_K);
		expect(p[DEYE]).toBe(0);
		const back = cameraFromParams(p, cam);
		expect(back.yaw).toBeCloseTo(200, 9);
		expect(back.pitch).toBeCloseTo(3, 9);
		expect(back.roll).toBeCloseTo(-2, 9);
		expect(back.f).toBeCloseTo(900, 9);
	});
	it("logf scales the focal length and yaw wraps to [0, 360)", () => {
		const p = paramsFromCamera(cam, 600);
		expect(p[LOGF]).toBeCloseTo(Math.log(1.5), 12);
		const q = Float64Array.from(p);
		q[LOGF] = Math.log(1.1);
		q[YAW] = -10 * DEG;
		const c = cameraFromParams(q, cam);
		expect(c.f).toBeCloseTo(990, 6);
		expect(c.yaw).toBeCloseTo(350, 9);
	});
});

describe("columnsFromSkyline", () => {
	it("drops NaN and low-weight columns and uses pixel centres", () => {
		const cols = columnsFromSkyline({
			width: 5,
			rows: [10, Number.NaN, 12, 13, 14],
			weight: [1, 1, 0.05, 0.5, 0],
		});
		expect(cols).toEqual([
			{ x: 0.5, y: 10, w: 1 },
			{ x: 3.5, y: 13, w: 0.5 },
		]);
		expect(
			columnsFromSkyline({ width: 2, rows: [1, 2], weight: [0.2, 0.2] }, 0.3),
		).toEqual([]);
	});
});

describe("columnSigma", () => {
	const m = { sigmaPx: 1, sigmaZ: 8, sigmaK: 0.05, sigmaXY: 10 };
	it("reduces to sigmaPx with no other error sources", () => {
		expect(
			columnSigma(
				{ sigmaPx: 2, sigmaZ: 0, sigmaK: 0, sigmaXY: 0 },
				1000,
				5000,
				1,
			),
		).toBe(2);
	});
	it("near ridges are less certain than mid-distance ones", () => {
		expect(columnSigma(m, 1000, 100, 0.1)).toBeGreaterThan(
			columnSigma(m, 1000, 5000, 0.1),
		);
	});
	it("very far ridges are dominated by refraction uncertainty", () => {
		expect(columnSigma(m, 1000, 150_000, 0)).toBeGreaterThan(
			columnSigma(m, 1000, 20_000, 0),
		);
	});
	it("clamps the distance to 30 m and slope to 5", () => {
		expect(columnSigma(m, 1000, 1, 0)).toBe(columnSigma(m, 1000, 30, 0));
		expect(columnSigma(m, 1000, 500, 5)).toBe(columnSigma(m, 1000, 500, 50));
	});
});

describe("evalColumn", () => {
	const W = 800;
	const H = 600;
	const cam: Camera = cameraFromAngles({
		width: W,
		height: H,
		f: 900,
		yaw: 120,
		pitch: 2,
		roll: 1,
	});
	const geom: Geometry = {
		width: W,
		height: H,
		cx: cam.cx,
		cy: cam.cy,
		f0: cam.f,
	};
	const t = horizonTable(profile());

	/** A column exactly on the DEM skyline (k = default, dEye = 0, so H = elevation). */
	const exactColumn = (az: number) => {
		const i = Math.round(az / step);
		const el = profile().elevation[i];
		const p = project(cam, directionENU(i * step, el)) as number[];
		return { x: p[0], y: p[1], w: 1 };
	};

	it("the residual is ~0 for a column on the skyline", () => {
		const p = paramsFromCamera(cam);
		const out = newEval();
		for (const az of [105, 115, 120, 128, 135]) {
			const c = exactColumn(az);
			evalColumn(p, geom, t, c, out);
			expect(Math.abs(out.r)).toBeLessThan(1e-3);
			expect(out.az).toBeCloseTo(Math.round(az / step) * step, 4);
		}
	});
	it("a skyline observed above the model has positive residual", () => {
		const p = paramsFromCamera(cam);
		const c = exactColumn(120);
		const out = evalColumn(p, geom, t, { ...c, y: c.y - 5 }, newEval());
		expect(out.r).toBeGreaterThan(4.9);
		expect(out.r).toBeLessThan(5.1);
	});
	it("analytic Jacobian matches finite differences for all parameters", () => {
		const r = seededRandom(1);
		const base = paramsFromCamera(cam);
		for (let trial = 0; trial < 12; trial++) {
			const az = uniform(r, 100, 140);
			const c0 = exactColumn(az);
			const c = {
				x: c0.x + uniform(r, -3, 3),
				y: c0.y + uniform(r, -8, 8),
				w: 1,
			};
			const p = Float64Array.from(base);
			p[YAW] += uniform(r, -0.01, 0.01);
			p[PITCH] += uniform(r, -0.01, 0.01);
			p[ROLL] += uniform(r, -0.01, 0.01);
			p[DEYE] = uniform(r, -5, 5);
			p[KREF] = 0.1;
			const J = new Float64Array(NPARAM);
			evalColumn(p, geom, t, c, newEval(), J);
			for (let k = 0; k < NPARAM; k++) {
				const h = k === DEYE ? 1e-3 : k === KREF ? 1e-5 : 1e-6;
				const hi = Float64Array.from(p);
				const lo = Float64Array.from(p);
				hi[k] += h;
				lo[k] -= h;
				const fd =
					(evalColumn(hi, geom, t, c, newEval()).r -
						evalColumn(lo, geom, t, c, newEval()).r) /
					(2 * h);
				// the horizon is piecewise linear, so allow a tolerance relative to the scale
				const tol = Math.max(
					0.02 * Math.abs(fd),
					1e-4 * (k === KREF ? 1e4 : 1) + 1e-3,
				);
				expect(Math.abs(J[k] - fd)).toBeLessThan(tol);
			}
		}
	});
	it("a larger refraction coefficient raises the model horizon by d/(2R) per unit k", () => {
		const p = paramsFromCamera(cam);
		const c = exactColumn(120);
		const a = evalColumn(p, geom, t, c, newEval());
		const q = Float64Array.from(p);
		q[KREF] += 0.1;
		const b = evalColumn(q, geom, t, c, newEval());
		expect(b.H - a.H).toBeCloseTo((0.1 * a.d) / (2 * EARTH_R), 10);
	});
	it("yaw shifts the sampled azimuth one-for-one", () => {
		const p = paramsFromCamera(cam);
		const c = exactColumn(120);
		const a = evalColumn(p, geom, t, c, newEval());
		const q = Float64Array.from(p);
		q[YAW] += 2 * DEG;
		const b = evalColumn(q, geom, t, c, newEval());
		expect(angleDiffDeg(b.az, a.az + 2)).toBeLessThan(1e-9);
	});
	it("returns the shared scratch semantics: passes `out` back", () => {
		const out = newEval();
		expect(
			evalColumn(paramsFromCamera(cam), geom, t, { x: 400, y: 300, w: 1 }, out),
		).toBe(out);
	});
	it("expectArrayClose sanity for the table", () => {
		expectArrayClose(
			Array.from(t.el.slice(0, 3)),
			Array.from(profile().elevation.slice(0, 3)).map((v) => v * DEG),
			1e-6,
		);
	});
});
