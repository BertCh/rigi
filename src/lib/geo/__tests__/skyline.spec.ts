// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { seededRandom, uniform } from "#/test/helpers";
import {
	computeFeatures,
	detectSkyline,
	heuristicSky,
	type RGBALike,
	viterbi,
} from "../skyline";

/** Blue sky above a sloped dark-rock boundary; boundaryAt(x) is the first terrain row. */
function synth(
	w: number,
	h: number,
	boundaryAt: (x: number) => number,
	noise = 0,
	seed = 1,
) {
	const rand = seededRandom(seed);
	const data = new Uint8ClampedArray(w * h * 4);
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			const i = 4 * (y * w + x);
			const sky = y < boundaryAt(x);
			const n = noise ? uniform(rand, -noise, noise) : 0;
			// sky: smooth blue gradient; terrain: dark brown-grey with texture
			if (sky)
				[data[i], data[i + 1], data[i + 2]] = [
					90 + y * 0.2,
					150 + y * 0.2,
					230,
				];
			else [data[i], data[i + 1], data[i + 2]] = [70 + n, 62 + n, 55 + n];
			data[i + 3] = 255;
		}
	return { width: w, height: h, data } satisfies RGBALike;
}

describe("computeFeatures", () => {
	it("returns per-pixel arrays of size w*h with colours in [0,1]", () => {
		const img = synth(32, 24, () => 12);
		const f = computeFeatures(img);
		for (const a of [f.r, f.g, f.b, f.tex, f.edge, f.step])
			expect(a).toHaveLength(32 * 24);
		for (const v of f.r) {
			expect(v).toBeGreaterThanOrEqual(0);
			expect(v).toBeLessThanOrEqual(1);
		}
	});
	it("a flat image has no texture and no edge", () => {
		const data = new Uint8ClampedArray(20 * 20 * 4).fill(128);
		const f = computeFeatures({ width: 20, height: 20, data });
		expect(Math.max(...f.tex)).toBeLessThan(1e-6);
		expect(Math.max(...f.edge)).toBeLessThan(1e-6);
	});
	it("a sky-to-terrain step gives a positive step and edge at the boundary row", () => {
		const f = computeFeatures(synth(40, 40, () => 20));
		const i = 20 * 40 + 20;
		const nearBoundary = Math.max(f.step[i - 40], f.step[i], f.step[i - 80]);
		expect(nearBoundary).toBeGreaterThan(0.1);
		expect(f.edge[i - 40 * 10]).toBeLessThan(0.01);
	});
});

describe("heuristicSky", () => {
	it("blue bright pixels score high, dark brown pixels score low", () => {
		const img = synth(32, 32, () => 16);
		const s = heuristicSky(computeFeatures(img), 32 * 32);
		expect(s[4 * 32 + 16]).toBeGreaterThan(0.5);
		expect(s[28 * 32 + 16]).toBeLessThan(0.2);
		for (const v of s) {
			expect(v).toBeGreaterThanOrEqual(0);
			expect(v).toBeLessThanOrEqual(1);
		}
	});
});

describe("viterbi", () => {
	const opts = {
		belowBand: 12,
		aboveBand: 12,
		edgeWeight: 0,
		jumpCost: 0.5,
		jumpCap: 4,
	};
	it("recovers a constant boundary from a clean sky map", () => {
		const w = 20;
		const h = 40;
		const sky = new Float32Array(w * h);
		for (let y = 0; y < 15; y++) for (let x = 0; x < w; x++) sky[y * w + x] = 1;
		const b = viterbi(sky, new Float32Array(w * h), w, h, opts);
		expect(b).toHaveLength(w);
		for (const v of b) expect(Math.abs(v - 15)).toBeLessThanOrEqual(1);
	});
	it("an all-sky column maps to h, an all-ground one to 0", () => {
		const w = 6;
		const h = 30;
		const allSky = new Float32Array(w * h).fill(1);
		for (const v of viterbi(allSky, new Float32Array(w * h), w, h, opts))
			expect(v).toBeGreaterThanOrEqual(h - 1);
		const none = new Float32Array(w * h);
		for (const v of viterbi(none, new Float32Array(w * h), w, h, opts))
			expect(v).toBeLessThanOrEqual(1);
	});
	it("smoothness removes a single-column outlier", () => {
		const w = 21;
		const h = 40;
		const sky = new Float32Array(w * h);
		for (let x = 0; x < w; x++)
			for (let y = 0; y < (x === 10 ? 30 : 15); y++) sky[y * w + x] = 1;
		const b = viterbi(sky, new Float32Array(w * h), w, h, {
			...opts,
			jumpCost: 2,
			jumpCap: 40,
		});
		expect(Math.abs(b[10] - 15)).toBeLessThan(6);
	});
});

describe("detectSkyline", () => {
	it("finds a flat skyline", () => {
		const w = 96;
		const h = 72;
		const obs = detectSkyline(synth(w, h, () => 30, 6));
		expect(obs.width).toBe(w);
		expect(obs.rows).toHaveLength(w);
		expect(obs.weight).toHaveLength(w);
		let good = 0;
		for (let x = 0; x < w; x++) if (Math.abs(obs.rows[x] - 30) <= 3) good++;
		expect(good).toBeGreaterThan(w * 0.9);
	});
	it("follows a sloped skyline", () => {
		const w = 96;
		const h = 72;
		const at = (x: number) => 20 + x * 0.3;
		const obs = detectSkyline(synth(w, h, at, 6));
		let good = 0;
		for (let x = 4; x < w - 4; x++)
			if (Math.abs(obs.rows[x] - at(x)) <= 4) good++;
		expect(good).toBeGreaterThan((w - 8) * 0.85);
	});
	it("returnSky=false omits the probability map; weights are in [0,1]", () => {
		const obs = detectSkyline(
			synth(48, 36, () => 15, 4),
			{ returnSky: false },
		);
		expect(obs.sky).toBeUndefined();
		for (const v of obs.weight) {
			expect(v).toBeGreaterThanOrEqual(0);
			expect(v).toBeLessThanOrEqual(1);
		}
		const withSky = detectSkyline(synth(48, 36, () => 15, 4));
		expect(withSky.sky).toHaveLength(48 * 36);
	});
	it("is deterministic", () => {
		const img = synth(48, 36, () => 15, 4);
		const a = detectSkyline(img);
		const b = detectSkyline(img);
		expect([...a.rows]).toEqual([...b.rows]);
	});
});
