// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { seededRandom } from "#/test/helpers";
import { type SkyMaskLike, skylineFromSky, skylineFromSkyDP } from "../skyline";

/** A mask whose sky is rows < boundary(x) (hard edge), row 0 = top. */
function mask(
	w: number,
	h: number,
	boundary: (x: number) => number,
	soft = 0,
): SkyMaskLike {
	const data = new Uint8Array(w * h);
	for (let x = 0; x < w; x++) {
		const b = boundary(x);
		for (let y = 0; y < h; y++) {
			const t = soft
				? 1 / (1 + Math.exp((y + 0.5 - b) / soft))
				: y + 0.5 < b
					? 1
					: 0;
			data[y * w + x] = Math.round(255 * t);
		}
	}
	return { width: w, height: h, data };
}

describe("skylineFromSky", () => {
	const w = 40;
	const h = 100;
	it("finds a flat horizon to sub-pixel accuracy", () => {
		const obs = skylineFromSky(mask(w, h, () => 40, 0.8));
		for (let x = 0; x < w; x++) {
			expect(obs.rows[x]).toBeCloseTo(40, 0);
			expect(obs.weight[x]).toBeGreaterThan(0.5);
		}
	});
	it("tracks a sloped boundary", () => {
		const obs = skylineFromSky(mask(w, h, (x) => 30 + x, 0.8));
		for (let x = 0; x < w; x++)
			expect(Math.abs(obs.rows[x] - (30 + x))).toBeLessThan(0.7);
	});
	it("reports the observation size and typed arrays", () => {
		const obs = skylineFromSky(mask(w, h, () => 40));
		expect(obs.width).toBe(w);
		expect(obs.height).toBe(h);
		expect(obs.rows).toBeInstanceOf(Float32Array);
		expect(obs.rows.length).toBe(w);
		expect(obs.weight.length).toBe(w);
	});
	it("a column that is all sky has no boundary (NaN, weight 0)", () => {
		const obs = skylineFromSky({
			width: 2,
			height: 50,
			data: new Uint8Array(100).fill(255),
		});
		expect(obs.rows[0]).toBeNaN();
		expect(obs.weight[0]).toBe(0);
	});
	it("a column with no sky has no boundary", () => {
		const obs = skylineFromSky({
			width: 2,
			height: 50,
			data: new Uint8Array(100),
		});
		expect(Number.isNaN(obs.rows[0])).toBe(true);
	});
	it("scans through a thin occluder (wire) inside the sky", () => {
		const m = mask(w, h, () => 60);
		// a 3 px wire at rows 20-22 across all columns
		for (let x = 0; x < w; x++)
			for (let y = 20; y < 23; y++) m.data[y * w + x] = 0;
		const obs = skylineFromSky(m);
		for (let x = 0; x < w; x++) expect(obs.rows[x]).toBeCloseTo(60, 0);
	});
	it("a thick non-sky run is terrain: the boundary is its top", () => {
		const m = mask(w, h, () => 60);
		for (let x = 0; x < w; x++)
			for (let y = 20; y < 40; y++) m.data[y * w + x] = 0;
		const obs = skylineFromSky(m);
		expect(obs.rows[5]).toBeCloseTo(20, 0);
	});
	it("tiny sky specks (< minSky) do not start a skyline", () => {
		const m = { width: 1, height: 100, data: new Uint8Array(100) };
		m.data[10] = 255; // 1 px of sky
		expect(skylineFromSky(m).rows[0]).toBeNaN();
	});
	it("sky not touching the top is down-weighted", () => {
		const a = skylineFromSky(mask(1, 100, () => 50, 0.8));
		const m = mask(1, 100, () => 50, 0.8);
		for (let y = 0; y < 10; y++) m.data[y] = 0;
		const b = skylineFromSky(m);
		expect(b.weight[0]).toBeLessThan(a.weight[0]);
		expect(b.rows[0]).toBeCloseTo(a.rows[0], 3);
	});
	it("a blurry edge gets a lower weight than a sharp one", () => {
		const sharp = skylineFromSky(mask(1, 100, () => 50, 0.5));
		const blur = skylineFromSky(mask(1, 100, () => 50, 6));
		expect(Number.isNaN(blur.rows[0]) || blur.weight[0] < sharp.weight[0]).toBe(
			true,
		);
	});
	it("minWeight discards low-confidence columns", () => {
		const obs = skylineFromSky(
			mask(1, 100, () => 50, 3),
			{ minWeight: 0.99 },
		);
		expect(obs.rows[0]).toBeNaN();
	});
});

describe("skylineFromSkyDP", () => {
	const w = 64;
	const h = 100;
	it("recovers a flat horizon", () => {
		const obs = skylineFromSkyDP(mask(w, h, () => 45, 0.8));
		for (let x = 0; x < w; x++)
			expect(Math.abs(obs.rows[x] - 45)).toBeLessThan(1);
		expect(obs.weight[10]).toBeGreaterThan(0.5);
	});
	it("tracks a smooth ridge", () => {
		const f = (x: number) => 40 + 10 * Math.sin((x / w) * Math.PI * 2);
		const obs = skylineFromSkyDP(mask(w, h, f, 0.8));
		let err = 0;
		for (let x = 0; x < w; x++) err += Math.abs(obs.rows[x] - f(x));
		expect(err / w).toBeLessThan(1.5);
	});
	it("bridges noisy mask columns instead of following them", () => {
		const base = mask(w, h, () => 50, 0.8);
		const r = seededRandom(7);
		// corrupt a few columns' pixels near the boundary
		for (const x of [10, 25, 40])
			for (let y = 44; y < 56; y++)
				base.data[y * w + x] = Math.round(r() * 255);
		const obs = skylineFromSkyDP(base);
		for (const x of [10, 25, 40])
			if (!Number.isNaN(obs.rows[x]))
				expect(Math.abs(obs.rows[x] - 50)).toBeLessThan(8);
	});
	it("zero-weights a narrow post (excursion) and keeps the rest", () => {
		const f = (x: number) => (x >= 30 && x < 32 ? 20 : 60);
		const obs = skylineFromSkyDP(mask(w, h, f, 0.8), undefined, { tau: 100 });
		expect(obs.rows[5]).toBeCloseTo(60, 0);
		// the 2 px post is either zero-weighted (NaN) or ignored by the DP; it must not report 20 with weight
		for (const x of [30, 31])
			expect(!(obs.weight[x] > 0 && obs.rows[x] < 40)).toBe(true);
	});
	it("an all-sky mask gives NaN everywhere", () => {
		const obs = skylineFromSkyDP({
			width: 8,
			height: 50,
			data: new Uint8Array(400).fill(255),
		});
		for (const v of obs.rows) expect(v).toBeNaN();
		for (const v of obs.weight) expect(v).toBe(0);
	});
	it("an all-ground mask gives NaN everywhere", () => {
		const obs = skylineFromSkyDP({
			width: 8,
			height: 50,
			data: new Uint8Array(400),
		});
		for (const v of obs.rows) expect(v).toBeNaN();
	});
	it("a strong photo edge term pulls a biased soft mask toward the colour step", () => {
		// the mask's 0.5 crossing is at row 54 but the photo's step is at row 50
		const m = mask(w, h, () => 54, 1.5);
		const img = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
		for (let y = 0; y < h; y++)
			for (let x = 0; x < w; x++) {
				const v = y < 50 ? 220 : 40;
				img.data.set([v, v, v, 255], (y * w + x) * 4);
			}
		const plain = skylineFromSkyDP(m, undefined, { minWeight: 0 }).rows[w >> 1];
		const guided = skylineFromSkyDP(m, img, { minWeight: 0, gamma: 40 }).rows[
			w >> 1
		];
		expect(Number.isNaN(plain) || Number.isNaN(guided)).toBe(false);
		expect(Math.abs(guided - 50)).toBeLessThan(Math.abs(plain - 50));
	});
	it("output arrays match the mask width", () => {
		const obs = skylineFromSkyDP(mask(w, h, () => 50));
		expect(obs.rows.length).toBe(w);
		expect(obs.weight.length).toBe(w);
		expect([obs.width, obs.height]).toEqual([w, h]);
	});
});
