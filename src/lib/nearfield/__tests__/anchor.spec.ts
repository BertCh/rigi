// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import {
	ANCHOR_QUALITY_CONSTS,
	anchoredRange,
	anchorQuality,
	CURVE_METRIC_NEAR,
	curveRange,
	fitAnchor,
	fitCurve,
	logMode,
} from "../anchor";
import type { NearFieldDepth } from "../types";

const K = { fx: 1e6, fy: 1e6, cx: 0.5, cy: 0.5 }; // ray length == z-depth

/** Grid whose z-depth grows geometrically down the rows (20 m .. 400 m). */
function rampDepth(W = 64, H = 64): NearFieldDepth {
	const depth = new Float32Array(W * H);
	for (let j = 0; j < H; j++)
		for (let i = 0; i < W; i++) depth[j * W + i] = 20 * 20 ** (j / (H - 1));
	return {
		width: W,
		height: H,
		depth,
		valid: new Uint8Array(W * H).fill(1),
		model: "t",
		seconds: 0,
	};
}
const zAt = (v: number, H = 64) => 20 * 20 ** (Math.floor(v * H) / (H - 1));

describe("anchorQuality", () => {
	it("is inlierFrac when residual is zero and decays with the residual", () => {
		const base = { residualLog: 0, inlierFrac: 0.8, n: 1000 };
		expect(anchorQuality(base)).toBeCloseTo(0.8, 12);
		expect(anchorQuality({ ...base, residualLog: 0.2 })).toBeCloseTo(
			0.8 * Math.exp(-1),
			12,
		);
		expect(anchorQuality({ ...base, residualLog: 0.4 })).toBeLessThan(
			anchorQuality({ ...base, residualLog: 0.2 }),
		);
	});
	it("prefers residualLogAll over residualLog", () => {
		const q = anchorQuality({
			residualLog: 0,
			residualLogAll: 0.2,
			inlierFrac: 1,
			n: 500,
		});
		expect(q).toBeCloseTo(Math.exp(-1), 12);
	});
	it("is 0 with too few samples or a non-finite residual", () => {
		const n = ANCHOR_QUALITY_CONSTS.nMin - 1;
		expect(anchorQuality({ residualLog: 0, inlierFrac: 1, n })).toBe(0);
		expect(
			anchorQuality({ residualLog: Number.NaN, inlierFrac: 1, n: 5000 }),
		).toBe(0);
	});
	it("clamps to [0, 1]", () => {
		expect(anchorQuality({ residualLog: 0, inlierFrac: 3, n: 1000 })).toBe(1);
	});
});

describe("curveRange / anchoredRange", () => {
	const curve = {
		x: [Math.log(20), Math.log(200)],
		y: [Math.log(30), Math.log(900)],
	};
	it("interpolates log-log and hits the knots", () => {
		expect(curveRange(curve, 20)).toBeCloseTo(30, 9);
		expect(curveRange(curve, 200)).toBeCloseTo(900, 9);
		// midpoint in log space -> geometric mean of metres
		expect(curveRange(curve, Math.sqrt(20 * 200))).toBeCloseTo(
			Math.sqrt(30 * 900),
			9,
		);
	});
	it("keeps a constant ratio beyond the far knot", () => {
		expect(curveRange(curve, 2000) / 2000).toBeCloseTo(900 / 200, 9);
	});
	it("is monotone for an increasing curve", () => {
		let prev = 0;
		for (let m = 16; m < 800; m *= 1.1) {
			const r = curveRange(curve, m);
			expect(r).toBeGreaterThan(prev);
			prev = r;
		}
	});
	it("below a near knot within CURVE_METRIC_NEAR keeps a constant ratio", () => {
		const c = { x: [Math.log(10)], y: [Math.log(20)] };
		expect(curveRange(c, 5)).toBeCloseTo(10, 9);
	});
	it("below a far-out near knot, the ratio relaxes to 1 at CURVE_METRIC_NEAR", () => {
		const c = {
			x: [Math.log(100), Math.log(300)],
			y: [Math.log(800), Math.log(2400)],
		};
		expect(curveRange(c, CURVE_METRIC_NEAR)).toBeCloseTo(CURVE_METRIC_NEAR, 9);
		expect(curveRange(c, 2)).toBeCloseTo(2, 9);
		expect(curveRange(c, 100)).toBeCloseTo(800, 6);
		const mid = curveRange(c, 40) / 40;
		expect(mid).toBeGreaterThan(1);
		expect(mid).toBeLessThan(8);
	});
	it("a one-knot curve keeps its constant ratio above the knot", () => {
		// regression: the near-relaxation weight was unclamped, so the ratio kept growing past the knot
		const c = { x: [Math.log(100)], y: [Math.log(300)] };
		expect(curveRange(c, 100)).toBeCloseTo(300, 6);
		expect(curveRange(c, 1000)).toBeCloseTo(3000, 6);
		expect(curveRange(c, 5000)).toBeCloseTo(15000, 4);
		expect(curveRange(c, CURVE_METRIC_NEAR)).toBeCloseTo(CURVE_METRIC_NEAR, 9);
	});
	it("is NaN for non-positive input", () => {
		expect(curveRange(curve, 0)).toBeNaN();
		expect(curveRange(curve, -3)).toBeNaN();
	});
	it("anchoredRange uses the curve when present, else scale*m + shift", () => {
		expect(anchoredRange({ scale: 2, shift: 5 }, 10)).toBe(25);
		expect(anchoredRange({ scale: 2, shift: 5, curve }, 20)).toBeCloseTo(30, 9);
	});
});

describe("logMode", () => {
	it("is NaN for empty input", () => {
		expect(logMode([], 0.2)).toBeNaN();
	});
	it("finds the dense cluster and ignores outliers", () => {
		const r: number[] = [];
		for (let i = 0; i < 100; i++) r.push(0.7 + 0.01 * ((i % 11) - 5));
		for (let i = 0; i < 30; i++) r.push(-1 + i * 0.1); // scattered outliers
		expect(logMode(r, 0.2)).toBeCloseTo(0.7, 1);
	});
});

describe("fitCurve", () => {
	it("recovers a constant ratio with one knot", () => {
		const mr: number[] = [];
		const dr: number[] = [];
		for (let i = 0; i < 300; i++) {
			mr.push(40 + 0.01 * i);
			dr.push((40 + 0.01 * i) * 2.5);
		}
		const c = fitCurve(mr, dr);
		expect(c.x.length).toBe(1);
		expect(Math.exp(c.y[0] - c.x[0])).toBeCloseTo(2.5, 1);
	});
	it("recovers a range-compressing power law within a few percent", () => {
		const mr: number[] = [];
		const dr: number[] = [];
		for (let i = 0; i < 600; i++) {
			const m = 20 * 20 ** (i / 599);
			mr.push(m);
			dr.push(m ** 1.3 * 1.2);
		}
		const c = fitCurve(mr, dr);
		expect(c.x.length).toBeGreaterThanOrEqual(2);
		for (const m of [25, 50, 100, 200, 350]) {
			const want = m ** 1.3 * 1.2;
			expect(Math.abs(Math.log(curveRange(c, m) / want))).toBeLessThan(0.08);
		}
	});
	it("resists one-sided outliers (objects in front of the terrain)", () => {
		const mr: number[] = [];
		const dr: number[] = [];
		for (let i = 0; i < 600; i++) {
			const m = 30 + (i % 300);
			mr.push(m);
			dr.push(i % 5 === 0 ? m * 0.3 : m * 2); // 20 % nearer-than-DEM outliers
		}
		const c = fitCurve(mr, dr);
		expect(curveRange(c, 100) / 100).toBeGreaterThan(1.8);
		expect(curveRange(c, 100) / 100).toBeLessThan(2.2);
	});
	it("falls back to a constant ratio when the slope bounds cannot be met", () => {
		// model spans ~4 decades, DEM is almost constant: Σ slopeMin·Δx exceeds the y grid
		const mr: number[] = [];
		const dr: number[] = [];
		for (let i = 0; i < 800; i++) {
			mr.push(1 * 10_000 ** (i / 799));
			dr.push(100 * (1 + 0.01 * (i % 7)));
		}
		const c = fitCurve(mr, dr);
		expect(c.x.length).toBe(1);
		expect(c.y.length).toBe(1);
		expect(Number.isFinite(c.y[0])).toBe(true);
		// a proportional curve (the old code returned a flat curve at ~13.5 m that broke slopeMin)
		const r = curveRange(c, 100) / 100;
		expect(curveRange(c, 1000) / 1000).toBeCloseTo(r, 9);
		expect(r).toBeGreaterThan(2);
		expect(r).toBeLessThan(20);
	});
	it("octaveMinShare caps the weight of a sparse octave", () => {
		// 2000 samples at DEM ratio 2 over 200-400 m, plus 4 near samples (DEM 16-32 m octave) at ratio 0.5. With
		// plain octave weights the 4 samples weigh as much as the 2000 and bend the near end down to them; with a
		// 5 % floor they are outvoted and the near end extrapolates the far ratio.
		const mr: number[] = [];
		const dr: number[] = [];
		for (let i = 0; i < 2000; i++) {
			const m = 100 + (100 * i) / 1999;
			mr.push(m);
			dr.push(2 * m);
		}
		for (let i = 0; i < 4; i++) {
			mr.push(40 + i);
			dr.push(20 + i / 2);
		}
		const plain = fitCurve(mr, dr);
		const floored = fitCurve(mr, dr, { octaveMinShare: 0.05 });
		expect(fitCurve(mr, dr, { octaveMinShare: 0 })).toEqual(plain);
		const r = (c: { x: number[]; y: number[] }, m: number) =>
			curveRange(c, m) / m;
		expect(r(plain, 41)).toBeLessThan(1);
		expect(r(floored, 41)).toBeGreaterThan(1.2);
		for (const c of [plain, floored])
			expect(Math.abs(Math.log(r(c, 150) / 2))).toBeLessThan(0.05);
	});
	it("returns monotone knots with slopes within bounds", () => {
		const mr: number[] = [];
		const dr: number[] = [];
		for (let i = 0; i < 400; i++) {
			const m = 15 * 30 ** (i / 399);
			mr.push(m);
			dr.push(m * (1 + 4 * (i / 399)));
		}
		const c = fitCurve(mr, dr);
		for (let k = 1; k < c.x.length; k++) {
			const slope = (c.y[k] - c.y[k - 1]) / (c.x[k] - c.x[k - 1]);
			expect(slope).toBeGreaterThan(0.75 - 0.1);
			expect(slope).toBeLessThan(6 + 0.1);
		}
	});
});

describe("fitAnchor", () => {
	it("fails (quality 0, scale 1) when fewer candidates than minSamples", () => {
		const d = rampDepth(8, 8);
		const fit = fitAnchor(d, () => 100, K, { stride: 1 });
		expect(fit.quality).toBe(0);
		expect(fit.scale).toBe(1);
		expect(fit.shift).toBe(0);
		expect(fit.n).toBe(64);
		expect(fit.curve).toBeUndefined();
	});
	it("scale mode recovers a constant factor with high quality", () => {
		const d = rampDepth();
		const fit = fitAnchor(d, (_u, v) => 2.5 * zAt(v), K, { mode: "scale" });
		expect(fit.scale).toBeCloseTo(2.5, 1);
		expect(fit.shift).toBe(0);
		expect(fit.inlierFrac).toBeGreaterThan(0.95);
		expect(fit.quality).toBeGreaterThan(0.9);
	});
	it("affine mode recovers scale and shift", () => {
		const d = rampDepth();
		const fit = fitAnchor(d, (_u, v) => 1.5 * zAt(v) + 12, K, {
			mode: "affine",
			band: Math.log(1.2),
		});
		expect(fit.scale).toBeGreaterThan(1.3);
		expect(fit.scale).toBeLessThan(1.7);
		expect(fit.shift).toBeGreaterThan(0);
		expect(fit.quality).toBeGreaterThan(0.5);
	});
	it("curve mode recovers a range-dependent map", () => {
		const d = rampDepth();
		const truth = (z: number) => z ** 1.25 * 1.4;
		const fit = fitAnchor(d, (_u, v) => truth(zAt(v)), K);
		expect(fit.curve).toBeDefined();
		expect(fit.quality).toBeGreaterThan(0.8);
		expect(fit.shift).toBe(0);
		for (const z of [30, 80, 200])
			expect(Math.abs(Math.log(anchoredRange(fit, z) / truth(z)))).toBeLessThan(
				0.1,
			);
	});
	it("skips sky, people and out-of-range DEM pixels", () => {
		const d = rampDepth();
		const W = d.width;
		const H = d.height;
		const full = fitAnchor(d, (_u, v) => 2 * zAt(v), K, {
			stride: 1,
			mode: "scale",
		});
		const sky = { width: W, height: H, data: new Uint8Array(W * H).fill(1) };
		const none = fitAnchor(d, (_u, v) => 2 * zAt(v), K, {
			stride: 1,
			skyMask: sky,
		});
		expect(none.n).toBe(0);
		const people = fitAnchor(d, (_u, v) => 2 * zAt(v), K, {
			stride: 1,
			peopleMask: sky,
		});
		expect(people.n).toBe(0);
		const noDem = fitAnchor(d, () => null, K, { stride: 1 });
		expect(noDem.n).toBe(0);
		const clipped = fitAnchor(d, (_u, v) => 2 * zAt(v), K, {
			stride: 1,
			minRange: 100,
			maxRange: 300,
			mode: "scale",
		});
		expect(clipped.n).toBeLessThan(full.n);
		expect(clipped.n).toBeGreaterThan(0);
		expect(clipped.maxRange).toBe(300);
	});
	it("edgeGuard drops candidates next to depth and DEM discontinuities", () => {
		const d = rampDepth();
		const W = d.width;
		// a vertical depth step in the model at column 32 (×3) that the DEM does not have
		for (let j = 0; j < d.height; j++)
			for (let i = 32; i < W; i++) d.depth[j * W + i] *= 3;
		const dem = (_u: number, v: number) => 2 * zAt(v);
		const off = fitAnchor(d, dem, K, { stride: 1, mode: "scale" });
		const on = fitAnchor(d, dem, K, {
			stride: 1,
			mode: "scale",
			edgeGuard: Math.log(1.5),
		});
		// columns 31 and 32 border the step
		expect(off.n - on.n).toBe(2 * d.height);
		// an untouched ramp keeps every candidate (row steps are ≈ 5 %, under the guard)
		const flat = rampDepth();
		expect(
			fitAnchor(flat, dem, K, { stride: 1, edgeGuard: Math.log(1.5) }).n,
		).toBe(fitAnchor(flat, dem, K, { stride: 1 }).n);
		// a DEM hole (no terrain) makes its neighbours edges
		const holed = (u: number, v: number) =>
			u > 0.5 && u < 0.52 ? null : 2 * zAt(v);
		const h = fitAnchor(flat, holed, K, { stride: 1, edgeGuard: 0.4 });
		const h0 = fitAnchor(flat, holed, K, { stride: 1 });
		expect(h.n).toBeLessThan(h0.n);
		// at stride 2 the guard still looks at pixel-distance-1 neighbours: candidates sit on odd columns, so only
		// column 31 (next to the step at 32) is dropped
		const off2 = fitAnchor(d, dem, K, { stride: 2, mode: "scale" });
		const on2 = fitAnchor(d, dem, K, {
			stride: 2,
			mode: "scale",
			edgeGuard: Math.log(1.5),
		});
		expect(off2.n - on2.n).toBe(d.height / 2);
	});
	it("ignores invalid model pixels", () => {
		const d = rampDepth();
		d.valid.fill(0);
		expect(fitAnchor(d, () => 100, K, { stride: 1 }).n).toBe(0);
	});
	it("wrong-by-pose DEM (random ratios) yields low quality", () => {
		const d = rampDepth();
		let s = 12345;
		const rnd = () => {
			s = (s * 1664525 + 1013904223) >>> 0;
			return s / 2 ** 32;
		};
		const fit = fitAnchor(d, (_u, v) => zAt(v) * 5 ** (rnd() * 2 - 1), K, {
			mode: "scale",
		});
		expect(fit.quality).toBeLessThan(0.5);
	});
});
