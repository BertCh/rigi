// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { seededRandom, uniform } from "#/test/helpers";
import { ATM_CURV, FIT_MIN_QUALITY, type Vec3 } from "../atmosphere";
import {
	fitHaze,
	minimise1D,
	reweight,
	robustSky,
	solveJ0,
	sse,
	sum,
} from "../haze-fit";

describe("small solvers", () => {
	it("sum adds", () => {
		expect(sum([])).toBe(0);
		expect(sum([1, 2, 3.5])).toBe(6.5);
	});
	it("solveJ0 recovers J from I = J t + A (1 - t) and clamps to [0, A]", () => {
		const A = 0.7;
		const J = 0.2;
		const t = [0.9, 0.7, 0.5, 0.3];
		const I = t.map((x) => J * x + A * (1 - x));
		const w = t.map(() => 1);
		expect(solveJ0(I, t, w, A, 0, -1)).toBeCloseTo(J, 12);
		expect(
			solveJ0(
				t.map(() => 5),
				t,
				w,
				A,
				0,
				-1,
			),
		).toBe(A);
		expect(
			solveJ0(
				t.map(() => -5),
				t,
				w,
				A,
				0,
				-1,
			),
		).toBe(0);
		expect(solveJ0([], [], [], A, 0, -1)).toBe(0);
	});
	it("solveJ0's prior pulls toward jBar when the data are weak", () => {
		const t = [0.05];
		const I = [0.9 * 0.95 + 0.0];
		const free = solveJ0(I, t, [1], 0.9, 0, -1);
		const pulled = solveJ0(I, t, [1], 0.9, 100, 0.3);
		expect(Math.abs(pulled - 0.3)).toBeLessThan(Math.abs(free - 0.3));
	});
	it("sse is zero at the true J and grows away from it", () => {
		const t = [0.8, 0.5];
		const I = t.map((x) => 0.3 * x + 0.8 * (1 - x));
		expect(sse(I, t, [1, 1], 0.8, 0.3)).toBeCloseTo(0, 20);
		expect(sse(I, t, [1, 1], 0.8, 0.5)).toBeGreaterThan(
			sse(I, t, [1, 1], 0.8, 0.35),
		);
	});
	it("minimise1D finds the minimum of a smooth and of a multi-modal function", () => {
		expect(minimise1D((x) => (x - 0.37) ** 2, 0, 1, 10)).toBeCloseTo(0.37, 6);
		const f = (x: number) => Math.min((x - 2) ** 2 + 1, (x - 8) ** 2);
		expect(minimise1D(f, 0, 10, 100)).toBeCloseTo(8, 5);
	});
	it("reweight downweights outliers (Cauchy) and keeps inliers near w0", () => {
		const res = [[0.001, -0.002, 0.001, 0.002, 5]];
		const out = [[0, 0, 0, 0, 0]];
		reweight(res, [1, 1, 1, 1, 1], out);
		expect(out[0][0]).toBeGreaterThan(0.99);
		expect(out[0][4]).toBeLessThan(0.01);
	});
	it("robustSky takes the brighter-half median of a skyline band, else range-0 pixels, else a default", () => {
		const n = 40;
		const r = Array.from({ length: n }, (_, i) => (i < 20 ? 0.8 : 0.2));
		const g = r.map((v) => v * 0.9);
		const b = r.map((v) => v * 0.5);
		const l = r.map((v) => v);
		const sky = robustSky(r, g, b, l, new Float32Array(0), new Float32Array(0));
		expect(sky[0]).toBeCloseTo(0.8, 9);
		expect(sky[2]).toBeCloseTo(0.4, 9);
		// no band: use range-0 pixels of the photo
		const lin = new Float32Array(30 * 3).fill(0.55);
		const range = new Float32Array(30); // all sky
		const fromRange = robustSky([], [], [], [], lin, range);
		expect(fromRange[0]).toBeCloseTo(0.55, 6);
		expect(
			robustSky([], [], [], [], new Float32Array(0), new Float32Array(0)),
		).toEqual([0.62, 0.7, 0.8]);
	});
});

// A small synthetic scene: sky above `skyRows`, below it terrain whose range falls log-linearly from
// 140 km to 250 m; pixels follow I = J t + A (1 - t) with per-channel constant extinction.
const W = 120;
const H = 90;
const EYE = 1900;
const A: Vec3 = [0.62, 0.7, 0.82];
const BETA: Vec3 = [3e-5, 4e-5, 6e-5];
const enc = (c: number) => {
	const v = Math.max(0, Math.min(1, c));
	return Math.round(
		255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055),
	);
};

function makeScene() {
	const rand = seededRandom(77);
	const geo = new Float32Array(W * H * 4);
	const PW = W * 2;
	const PH = H * 2;
	const data = new Uint8ClampedArray(PW * PH * 4);
	const sky = 18;
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++) {
			let col: Vec3;
			const gi = ((H - 1 - y) * W + x) * 4;
			if (y < sky) {
				col = [A[0], A[1], A[2]];
			} else {
				const f = (y - sky) / (H - 1 - sky);
				const d = Math.exp(
					Math.log(140000) + f * (Math.log(250) - Math.log(140000)),
				);
				const az = ((x / W - 0.5) * 60 * Math.PI) / 180;
				const h = 1400 + 300 * Math.sin(x * 0.1) * Math.cos(y * 0.13) - 500 * f;
				const px = d * Math.sin(az);
				const py = d * Math.cos(az);
				geo[gi] = px;
				geo[gi + 1] = py;
				geo[gi + 2] = h - (px * px + py * py) * ATM_CURV;
				geo[gi + 3] = d;
				const g = uniform(rand, 0.03, 0.4);
				col = [0, 1, 2].map((c) => {
					const t = Math.exp(-BETA[c] * d);
					return g * t + A[c] * (1 - t);
				}) as Vec3;
			}
			for (let yy = 0; yy < 2; yy++)
				for (let xx = 0; xx < 2; xx++) {
					const k = ((y * 2 + yy) * PW + x * 2 + xx) * 4;
					data[k] = enc(col[0]);
					data[k + 1] = enc(col[1]);
					data[k + 2] = enc(col[2]);
					data[k + 3] = 255;
				}
		}
	return { photo: { width: PW, height: PH, data }, geo };
}

describe("fitHaze on a synthetic constant-beta scene", () => {
	const { photo, geo } = makeScene();
	const fit = fitHaze({
		photo,
		geo: { kind: "xyzr", data: geo },
		geoW: W,
		geoH: H,
		eyeAlt: EYE,
	});
	it("recovers the airlight within 5 percent", () => {
		for (let c = 0; c < 3; c++)
			expect(Math.abs(fit.airlight[c] - A[c]) / A[c]).toBeLessThan(0.05);
	});
	it("recovers the free per-channel extinction within 25 percent and orders blue above red", () => {
		for (let c = 0; c < 3; c++)
			expect(Math.abs(fit.beta[c] - BETA[c]) / BETA[c]).toBeLessThan(0.25);
		expect(fit.beta[2]).toBeGreaterThan(fit.beta[0]);
	});
	it("reports a plausible quality, visibility and sample bins", () => {
		expect(fit.quality).toBeGreaterThan(FIT_MIN_QUALITY);
		expect(fit.quality).toBeLessThanOrEqual(1);
		expect(fit.visibility).toBeGreaterThan(5000);
		expect(fit.visibility).toBeLessThan(500000);
		expect(fit.samples.length).toBeGreaterThan(5);
		for (const s of fit.samples) {
			expect(s.range).toBeGreaterThan(0);
			expect(s.n).toBeGreaterThan(0);
		}
		expect(fit.strength).toBe(1);
		expect(fit.rms).toBeGreaterThanOrEqual(0);
	});
	it("is deterministic and carries the sun it was given", () => {
		const again = fitHaze({
			photo,
			geo: { kind: "xyzr", data: geo },
			geoW: W,
			geoH: H,
			eyeAlt: EYE,
			sunDir: [0, 0.6, 0.8],
		});
		expect(again.beta).toEqual(fit.beta);
		expect(again.sunDir).toEqual([0, 0.6, 0.8]);
	});
	it("the 'range' geometry with a pixel-ray function matches the xyzr fit on the same points", () => {
		// same scene, but as range + rays: each pixel's ray is the unit direction to its xyz point
		const range = new Float32Array(W * H);
		const dirs: Vec3[] = [];
		for (let i = 0; i < W * H; i++) {
			const r = geo[i * 4 + 3];
			range[i] = r;
			dirs.push(
				r > 0
					? [geo[i * 4] / r, geo[i * 4 + 1] / r, (geo[i * 4 + 2] - EYE) / r]
					: [0, 1, 0],
			);
		}
		const viaRange = fitHaze({
			photo,
			geo: { kind: "range", data: range, ray: (x, y) => dirs[y * W + x] },
			geoW: W,
			geoH: H,
			eyeAlt: EYE,
		});
		for (let c = 0; c < 3; c++)
			expect(Math.abs(viaRange.airlight[c] - fit.airlight[c])).toBeLessThan(
				0.05,
			);
	});
});

describe("fitHaze degenerate inputs", () => {
	it("an all-sky frame does not throw and reports low quality", () => {
		const PW = 40;
		const PH = 30;
		const data = new Uint8ClampedArray(PW * PH * 4).fill(200);
		const f = fitHaze({
			photo: { width: PW, height: PH, data },
			geo: { kind: "xyzr", data: new Float32Array(20 * 15 * 4) },
			geoW: 20,
			geoH: 15,
			eyeAlt: 500,
		});
		expect(f.quality).toBeLessThan(FIT_MIN_QUALITY);
		expect(Number.isFinite(f.airlight[0])).toBe(true);
	});
});
