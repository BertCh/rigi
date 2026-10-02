// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { seededRandom, uniform } from "#/test/helpers";
import {
	IMHOF_AIR,
	IMHOF_GLSL_MATH,
	IMHOF_SCALE_CENTERS,
	IMHOF_WGSL_MATH,
	imhofAerial,
	imhofBlendNormalXy,
	imhofColour,
	imhofScaleWeights,
	imhofSwungLight,
} from "../imhof";

describe("imhofScaleWeights", () => {
	it("is all fine near and all coarse far", () => {
		expect(imhofScaleWeights(10)).toEqual([1, 0, 0, 0]);
		expect(imhofScaleWeights(1e6)).toEqual([0, 0, 0, 1]);
		expect(imhofScaleWeights(0)).toEqual([1, 0, 0, 0]);
	});
	it("is exactly one level at each centre", () => {
		IMHOF_SCALE_CENTERS.forEach((c, i) => {
			const w = imhofScaleWeights(10 ** c);
			expect(w[i]).toBeCloseTo(1, 9);
		});
	});
	it("always sums to 1 with non-negative weights, and only neighbours blend", () => {
		const rand = seededRandom(3);
		for (let k = 0; k < 200; k++) {
			const w = imhofScaleWeights(10 ** uniform(rand, 0, 5.5));
			expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
			expect(Math.min(...w)).toBeGreaterThanOrEqual(0);
			expect(w.filter((x) => x > 0).length).toBeLessThanOrEqual(2);
		}
	});
});

describe("imhofBlendNormalXy", () => {
	it("returns the selected level for a one-hot weight and the mean for equal weights", () => {
		const xy = [
			[1, 0],
			[0, 1],
			[-1, 0],
			[0, -1],
		] as const;
		expect(imhofBlendNormalXy(xy, [0, 0, 1, 0])).toEqual([-1, 0]);
		const [x, y] = imhofBlendNormalXy(xy, [0.25, 0.25, 0.25, 0.25]);
		expect(x).toBeCloseTo(0, 12);
		expect(y).toBeCloseTo(0, 12);
	});
});

describe("imhofSwungLight", () => {
	const flat: [number, number, number] = [0, 0, 1];
	it("returns mdow at swing 0", () => {
		expect(imhofSwungLight([0.3, 0.2, 0.93], 0.42, 0)).toBeCloseTo(0.42, 12);
	});
	it("lights flat ground the same at any swing (flat is lit 1 by the 45 degree light)", () => {
		expect(imhofSwungLight(flat, 1, 1)).toBeCloseTo(1, 9);
	});
	it("is finite and non-negative over random normals", () => {
		const rand = seededRandom(5);
		for (let k = 0; k < 200; k++) {
			const a = uniform(rand, 0, 2 * Math.PI);
			const s = uniform(rand, 0, 0.9);
			const n: [number, number, number] = [
				s * Math.sin(a),
				s * Math.cos(a),
				Math.sqrt(1 - s * s),
			];
			const L = imhofSwungLight(n, uniform(rand, 0, 1), uniform(rand, 0, 1));
			expect(Number.isFinite(L)).toBe(true);
			expect(L).toBeGreaterThanOrEqual(0);
		}
	});
	it("lights an east-facing slope more with swing than the fixed NW light does", () => {
		const s = 0.5;
		const east: [number, number, number] = [s, 0, Math.sqrt(1 - s * s)];
		expect(imhofSwungLight(east, 0.1, 1)).toBeGreaterThan(
			imhofSwungLight(east, 0.1, 0),
		);
	});
});

describe("imhofColour", () => {
	const grey = [0.5, 0.5, 0.5] as const;
	it("is monotone in shade for a grey albedo", () => {
		let prev = -1;
		for (let L = 0; L <= 1.0001; L += 0.1) {
			const c = imhofColour(grey, L, 1500, 0);
			const lum = c[0] + c[1] + c[2];
			expect(lum).toBeGreaterThan(prev);
			prev = lum;
		}
	});
	it("warms lit slopes and cools shaded ones", () => {
		const lit = imhofColour(grey, 1, 1500, 0);
		const shade = imhofColour(grey, 0, 1500, 0);
		expect(lit[0]).toBeGreaterThan(lit[2]);
		expect(shade[2]).toBeGreaterThan(shade[0]);
	});
	it("tint 0 ignores elevation, tint 1 greens the lowlands and lightens the high", () => {
		expect(imhofColour(grey, 0.8, 300, 0)).toEqual(
			imhofColour(grey, 0.8, 3500, 0),
		);
		const low = imhofColour(grey, 0.8, 300, 1);
		const high = imhofColour(grey, 0.8, 3500, 1);
		expect(low[1] / low[0]).toBeGreaterThan(high[1] / high[0]);
		expect(high[0]).toBeGreaterThan(low[0]);
	});
});

describe("imhofAerial", () => {
	const col = [0.8, 0.3, 0.1] as const;
	it("leaves near relief and aerial = 0 untouched", () => {
		expect(imhofAerial(col, 500, 1000, 1)).toEqual([...col]);
		const far = imhofAerial(col, 40000, 1000, 0);
		for (let i = 0; i < 3; i++) expect(far[i]).toBeCloseTo(col[i], 12);
	});
	it("moves far colour toward the air colour and valleys more than summits", () => {
		const d = (c: readonly number[]) =>
			Math.hypot(...c.map((v, i) => v - IMHOF_AIR[i]));
		const near = imhofAerial(col, 5000, 1000, 1);
		const far = imhofAerial(col, 40000, 1000, 1);
		expect(d(far)).toBeLessThan(d(near));
		expect(d(imhofAerial(col, 40000, 3500, 1))).toBeGreaterThan(d(far));
	});
});

describe("shader math text", () => {
	it("bakes the constants into both shader texts", () => {
		expect(IMHOF_WGSL_MATH).toContain("ts_imhof_scale_weights");
		expect(IMHOF_GLSL_MATH).toContain("imhofScaleWeights");
		expect(IMHOF_WGSL_MATH).toContain((2.7).toExponential(9));
	});
});
