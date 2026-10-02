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
