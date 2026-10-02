// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import type { EyeHorizon } from "../../pose6dof/eye";
import {
	associate,
	camOf,
	type FitParams,
	fitArm,
	hzEl,
	type Obs,
	PK_OPTS,
	projectAzEl,
	pxPerDeg,
	scanStart,
} from "../fit";
import { horizonPeaks, skylinePeaks } from "../peaks";

const step = 0.05;
const n = 7200;
const bump = (az: number, c: number, h: number, w: number) => {
	const d = Math.min(Math.abs(az - c), 360 - Math.abs(az - c));
	return h * Math.exp(-(d * d) / (2 * w * w));
};
const hz: EyeHorizon = {
	step,
	elevation: Float64Array.from({ length: n }, (_, k) => {
		const az = k * step;
		return (
			3 +
			bump(az, 12, 7, 1.2) +
			bump(az, 19, 5, 0.9) +
			bump(az, 26, 8, 1.5) +
			bump(az, 31, 3, 1.0)
		);
	}),
};

const W = 1600;
const H = 1000;
const vfov = 36;
const truth: FitParams = [21, 2, 0, 0];

/** Render the sky boundary the true camera would see over the horizon. */
function synthObs(p: FitParams): Obs {
	const c = camOf(p, { W, H, vfov, samples: [], peaks: [] });
	const samples: Obs["samples"] = [];
	for (let x = 0; x < W; x += 4) {
		// invert: find y such that unprojecting (x, y) hits the horizon, by bisection over y
		let lo = 0;
		let hi = H;
		const f = (y: number) => {
			const xx = (x - c.cx) / c.f;
			const yy = (c.cy - y) / c.f;
			const d = [0, 1, 2].map((i) => c.fw[i] + c.rt[i] * xx + c.up[i] * yy);
			const az = ((Math.atan2(d[0], d[1]) * 180) / Math.PI + 360) % 360;
			const el = (Math.atan2(d[2], Math.hypot(d[0], d[1])) * 180) / Math.PI;
			return el - hzEl(hz, az);
		};
		for (let k = 0; k < 40; k++) {
			const mid = (lo + hi) / 2;
			if (f(mid) > 0) lo = mid;
			else hi = mid;
		}
		samples.push({ x, y: (lo + hi) / 2, w: 1 });
	}
	const peaks = skylinePeaks(samples, 4, {
		minPromPx: PK_OPTS.promPx,
		windowPx: 60,
	});
	return { W, H, vfov, samples, peaks };
}

describe("projectAzEl / pxPerDeg", () => {
	const c = camOf(truth, { W, H, vfov, samples: [], peaks: [] });
	it("projects the optical axis to the principal point", () => {
		const q = projectAzEl(c, truth[0], truth[1]);
		expect(q).not.toBeNull();
		expect((q as [number, number])[0]).toBeCloseTo(W / 2, 6);
		expect((q as [number, number])[1]).toBeCloseTo(H / 2, 6);
	});
	it("returns null behind the camera", () => {
		expect(projectAzEl(c, truth[0] + 180, 0)).toBeNull();
	});
	it("moves right when azimuth increases and up when elevation increases", () => {
		const a = projectAzEl(c, truth[0] + 1, truth[1]) as [number, number];
		const b = projectAzEl(c, truth[0], truth[1] + 1) as [number, number];
		expect(a[0]).toBeGreaterThan(W / 2);
		expect(b[1]).toBeLessThan(H / 2);
	});
	it("matches pxPerDeg near the centre and scales with exp(lnf)", () => {
		const a = projectAzEl(c, truth[0] + 0.01, truth[1]) as [number, number];
		expect((a[0] - W / 2) / 0.01).toBeCloseTo(
			pxPerDeg(truth, { W, H, vfov, samples: [], peaks: [] }),
			1,
		);
		const o = { W, H, vfov, samples: [], peaks: [] };
		expect(
			pxPerDeg([0, 0, 0, Math.log(1.05)], o) / pxPerDeg([0, 0, 0, 0], o),
		).toBeCloseTo(1.05, 9);
	});
});

describe("hzEl", () => {
	it("interpolates linearly, wraps the seam, and returns NaN near no-data", () => {
		const h: EyeHorizon = { step: 1, elevation: [0, 10, 20, -90] };
		expect(hzEl(h, 0.5)).toBeCloseTo(5, 9);
		expect(hzEl(h, 1.25)).toBeCloseTo(12.5, 9);
		expect(hzEl(h, 2.5)).toBeNaN();
		expect(hzEl(h, 3.5)).toBeNaN();
		expect(hzEl(h, 363)).toBeNaN();
		expect(hzEl(h, -3.5)).toBeCloseTo(5, 9); // wraps to indices 0 and 1
	});
});

describe("associate", () => {
	const obs = synthObs(truth);
	const c = camOf(truth, obs);
	const model = horizonPeaks(hz, 0, 60, { minPromDeg: 0.5, windowDeg: 4 });
	it("pairs every sufficiently prominent peak at the true pose", () => {
		const a = associate(c, model, obs, PK_OPTS, pxPerDeg(truth, obs));
		expect(a.nItems).toBeGreaterThan(0);
		const photoSide = a.pairs.filter((p) => p.side === "photo");
		expect(photoSide.length).toBeGreaterThan(0);
		for (const p of a.pairs) {
			const q = a.mpx[p.model] as [number, number];
			const ph = obs.peaks[p.photo];
			expect(Math.hypot(q[0] - ph.x, q[1] - ph.y)).toBeLessThan(PK_OPTS.gatePx);
		}
	});
	it("pairs nothing when the model is off by more than the gate", () => {
		const far: FitParams = [truth[0] + 10, truth[1], 0, 0];
		const a = associate(
			camOf(far, obs),
			model,
			obs,
			PK_OPTS,
			pxPerDeg(far, obs),
		);
		expect(a.pairs).toHaveLength(0);
	});
});

describe("fitArm recovery", () => {
	const obs = synthObs(truth);
	const model = horizonPeaks(hz, 0, 60, { minPromDeg: 0.5, windowDeg: 4 });
	const p0: FitParams = [truth[0] + 0.7, truth[1] - 0.4, 0.3, 0.01];
	it("dense arm recovers yaw/pitch to within 0.1 deg", () => {
		const r = fitArm("dense", p0, hz, model, obs);
		expect(Math.abs(r.p[0] - truth[0])).toBeLessThan(0.1);
		expect(Math.abs(r.p[1] - truth[1])).toBeLessThan(0.1);
		expect(r.cost).toBeLessThan(
			fitArm("dense", p0, hz, model, obs, PK_OPTS, 0).cost,
		);
		expect(r.peak).toBeNaN();
	});
	it("both arm recovers yaw/pitch and matches peaks", () => {
		const r = fitArm("both", p0, hz, model, obs);
		expect(Math.abs(r.p[0] - truth[0])).toBeLessThan(0.1);
		expect(Math.abs(r.p[1] - truth[1])).toBeLessThan(0.1);
		expect(r.nMatched).toBeGreaterThan(0);
	});
	it("keeps ln fScale inside the bound", () => {
		const r = fitArm("both", [truth[0], truth[1], 0, 0.5], hz, model, obs);
		expect(Math.abs(r.p[3])).toBeLessThanOrEqual(PK_OPTS.lnfMax + 1e-12);
	});
	it("never increases the cost from the start", () => {
		const r0 = fitArm("dense", p0, hz, model, obs, PK_OPTS, 0);
		const r = fitArm("dense", p0, hz, model, obs, PK_OPTS, 6);
		expect(r.cost).toBeLessThanOrEqual(r0.cost + 1e-12);
	});
});

describe("scanStart", () => {
	it("moves a start offset by ~1 deg back toward the true yaw/pitch", () => {
		const obs = synthObs(truth);
		const s = scanStart(
			[truth[0] + 1.5, truth[1] - 0.75, 0, 0],
			hz,
			obs,
			PK_OPTS,
		);
		expect(Math.abs(s[0] - truth[0])).toBeLessThan(0.5);
		expect(Math.abs(s[1] - truth[1])).toBeLessThan(0.5);
		expect(s[2]).toBe(0);
		expect(s[3]).toBe(0);
	});
});
