// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import {
	computeFeatures,
	detectSkyline,
	finishSkylineColumns,
	fitSkyModel,
	heuristicSky,
	modelSky,
	resolveOptions,
	seedWeightOf,
	skylineColumnPart,
	viterbi,
} from "../skyline";

function ridgeImage(w: number, h: number) {
	const data = new Uint8ClampedArray(w * h * 4);
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			const ridge = h * 0.55 + 6 * Math.sin(x / 9);
			const o = 4 * (y * w + x);
			if (y < ridge) {
				data[o] = 110 + y * 0.3;
				data[o + 1] = 160;
				data[o + 2] = 235;
			} else {
				data[o] = 60 + ((x * 7 + y * 13) % 17);
				data[o + 1] = 70 + ((x * 5 + y * 3) % 11);
				data[o + 2] = 50;
			}
			data[o + 3] = 255;
		}
	return { width: w, height: h, data };
}

describe("skyline finish split", () => {
	const w = 96;
	const h = 72;
	const img = ridgeImage(w, h);

	it("column part + column tail reproduce detectSkyline (no refit)", () => {
		const { o, minWeight } = resolveOptions(h, { refinePasses: 0 });
		const f = computeFeatures(img);
		const prior = heuristicSky(f, w * h);
		const seed = fitSkyModel(f, w, h, seedWeightOf(prior, h));
		const sky = seed ? modelSky(f, w, h, seed) : prior;
		const bound = viterbi(sky, f.edge, w, h, o);
		const { rows, weight } = skylineColumnPart(f, sky, bound, w, h);
		finishSkylineColumns(rows, weight, w, h, minWeight);
		const ref = detectSkyline(img, { refinePasses: 0 });
		expect([...rows]).toEqual([...ref.rows]);
		expect([...weight]).toEqual([...ref.weight]);
		expect(rows.filter(Number.isFinite).length).toBeGreaterThan(w / 2);
	});

	it("column part: NaN rows have weight 0, boundary near the border is skipped", () => {
		const f = computeFeatures(img);
		const sky = new Float32Array(w * h).fill(0.5);
		const bound = new Int32Array(w).fill(30);
		bound[0] = 5; // inside the 14 px top margin
		bound[1] = h - 3; // inside the bottom margin
		const { rows, weight } = skylineColumnPart(f, sky, bound, w, h);
		expect(Number.isNaN(rows[0])).toBe(true);
		expect(Number.isNaN(rows[1])).toBe(true);
		expect(weight[0]).toBe(0);
		expect(weight[1]).toBe(0);
		expect(Number.isFinite(rows[5])).toBe(true);
		expect(Math.abs(rows[5] - 30)).toBeLessThanOrEqual(0.5);
	});

	it("column tail: a short isolated run is zeroed, a long run survives, NaN rows get weight 0", () => {
		const W = 200;
		const H = 100;
		const rows = new Float32Array(W).fill(50);
		const weight = new Float32Array(W).fill(0.8);
		for (let x = 90; x < 94; x++) rows[x] = 10; // 4-column spike far above both neighbours
		for (let x = 150; x < 170; x++) rows[x] = Number.NaN;
		finishSkylineColumns(rows, weight, W, H, 0.1);
		for (let x = 90; x < 94; x++) {
			expect(weight[x]).toBe(0);
			expect(Number.isNaN(rows[x])).toBe(true);
		}
		for (let x = 150; x < 170; x++) {
			expect(weight[x]).toBe(0);
			expect(Number.isNaN(rows[x])).toBe(true);
		}
		expect(weight[20]).toBeGreaterThan(0.7);
		expect(rows[20]).toBe(50);
	});

	it("column tail: weights under minWeight become NaN rows", () => {
		const W = 120;
		const rows = new Float32Array(W).fill(40);
		const weight = new Float32Array(W).fill(0.8);
		for (let x = 0; x < 60; x++) weight[x] = 0.05;
		finishSkylineColumns(rows, weight, W, 80, 0.1);
		expect(Number.isNaN(rows[10])).toBe(true);
		expect(weight[10]).toBe(0);
		expect(rows[100]).toBe(40);
	});
});
