// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { seededRandom } from "#/test/helpers";
import {
	BAND_CENTERS_LOG10,
	BAND_EDGES_M,
	bandInputs,
	estimateNoiseSigma,
	identityStats,
	N_BANDS,
	reduceBands,
} from "../color-stats";

describe("constants", () => {
	it("4 bands, centres ascending and inside their band edges", () => {
		expect(N_BANDS).toBe(4);
		expect(BAND_CENTERS_LOG10).toHaveLength(N_BANDS);
		for (let i = 1; i < N_BANDS; i++)
			expect(BAND_CENTERS_LOG10[i]).toBeGreaterThan(BAND_CENTERS_LOG10[i - 1]);
		const edges = [0, ...BAND_EDGES_M, Number.POSITIVE_INFINITY].map((e) => e);
		BAND_CENTERS_LOG10.forEach((c, i) => {
			expect(10 ** c).toBeGreaterThan(edges[i]);
			expect(10 ** c).toBeLessThan(edges[i + 1]);
		});
	});
});

describe("identityStats", () => {
	it("is a no-op transfer: zero means, unit stds, no counts, invalid", () => {
		const s = identityStats();
		expect(s.valid).toBe(false);
		expect([...s.photoMean, ...s.layerMean].every((v) => v === 0)).toBe(true);
		expect([...s.photoStd, ...s.layerStd].every((v) => v === 1)).toBe(true);
		expect([...s.count]).toEqual([0, 0, 0, 0]);
		expect(s.photoMean).toHaveLength(N_BANDS * 3);
	});
	it("returns fresh buffers each call", () => {
		expect(identityStats().photoMean).not.toBe(identityStats().photoMean);
	});
});

describe("bandInputs", () => {
	const w = 16;
	const h = 16;
	const grey = (v: number) => {
		const p = new Uint8ClampedArray(w * h * 4);
		for (let i = 0; i < w * h; i++) p.set([v, v, v, 255], i * 4);
		return p;
	};
	const layerOf = (v: number, alpha: number) => {
		const l = new Float32Array(w * h * 4);
		for (let i = 0; i < w * h; i++)
			l.set([v * alpha, v * alpha, v * alpha, alpha], i * 4);
		return l;
	};
	const range = (r: number) => (_x: number, y: number) => (y < 2 ? 0 : r);

	it("stores log10 range in the photo alpha slot, 0 for sky", () => {
		const { a } = bandInputs(grey(128), layerOf(0.2, 1), w, h, range(3000));
		expect(a[(5 * w + 5) * 4 + 3]).toBeCloseTo(Math.log10(3000), 6);
		expect(a[(0 * w + 5) * 4 + 3]).toBe(0);
	});
	it("neutral greys have zero chroma and photo lightness rises with value", () => {
		const dark = bandInputs(grey(40), layerOf(0.2, 1), w, h, range(3000)).a;
		const light = bandInputs(grey(200), layerOf(0.2, 1), w, h, range(3000)).a;
		const j = (8 * w + 8) * 4;
		expect(dark[j + 1]).toBeCloseTo(0, 3);
		expect(dark[j + 2]).toBeCloseTo(0, 3);
		expect(light[j]).toBeGreaterThan(dark[j]);
		// white (255) is Oklab L = 1
		expect(
			bandInputs(grey(255), layerOf(1, 1), w, h, range(3000)).a[j],
		).toBeCloseTo(1, 4);
	});
	it("un-premultiplies the layer: colour is independent of coverage", () => {
		const full = bandInputs(grey(100), layerOf(0.3, 1), w, h, range(3000)).b;
		const part = bandInputs(grey(100), layerOf(0.3, 0.99), w, h, range(3000)).b;
		const j = (8 * w + 8) * 4;
		for (let c = 0; c < 3; c++) expect(part[j + c]).toBeCloseTo(full[j + c], 5);
	});
	it("validity: needs full coverage, range beyond minRange, and 3 px of margin from sky", () => {
		const ok = (v: Float32Array, x: number, y: number) =>
			v[(y * w + x) * 4 + 3];
		const { b } = bandInputs(grey(100), layerOf(0.3, 1), w, h, range(3000));
		expect(ok(b, 8, 1)).toBe(0); // sky itself
		for (const y of [2, 3, 4]) expect(ok(b, 8, y), `row ${y}`).toBe(0); // within 3 px below sky
		expect(ok(b, 8, 5)).toBe(1);
		const partial = bandInputs(
			grey(100),
			layerOf(0.3, 0.9),
			w,
			h,
			range(3000),
		).b;
		expect(ok(partial, 8, 8)).toBe(0);
		const near = bandInputs(
			grey(100),
			layerOf(0.3, 1),
			w,
			h,
			range(300),
			undefined,
			500,
		).b;
		expect(ok(near, 8, 8)).toBe(0);
		const far = bandInputs(
			grey(100),
			layerOf(0.3, 1),
			w,
			h,
			range(300),
			undefined,
			200,
		).b;
		expect(ok(far, 8, 8)).toBe(1);
	});
	it("people (fg >= 0.3) are excluded; non-finite and negative ranges count as sky", () => {
		const fg = (x: number) => (x === 8 ? 0.3 : 0.29);
		const { b } = bandInputs(grey(100), layerOf(0.3, 1), w, h, range(3000), fg);
		expect(b[(8 * w + 8) * 4 + 3]).toBe(0);
		expect(b[(8 * w + 9) * 4 + 3]).toBe(1);
		const weird = bandInputs(grey(100), layerOf(0.3, 1), w, h, (_x, y) =>
			y < 2 ? Number.NaN : y < 4 ? -5 : 3000,
		);
		expect(weird.a[3]).toBe(0);
		expect(weird.a[(2 * w + 0) * 4 + 3]).toBe(0);
	});
});

describe("reduceBands", () => {
	/** n pixels in one band: photo Oklab values drawn around `mean` with spread `sd`, layer = photo + offset. */
	function fill(
		n: number,
		band: number,
		mean: number[],
		sd: number[],
		layerShift: number[],
		rand: () => number,
	) {
		const a = new Float32Array(n * 4);
		const b = new Float32Array(n * 4);
		const logR = Math.log10([500, 3000, 10000, 50000][band]);
		for (let i = 0; i < n; i++) {
			for (let c = 0; c < 3; c++) {
				const v = mean[c] + (rand() * 2 - 1) * Math.sqrt(3) * sd[c];
				a[i * 4 + c] = v;
				b[i * 4 + c] = v + layerShift[c];
			}
			a[i * 4 + 3] = logR;
			b[i * 4 + 3] = 1;
		}
		return { a, b };
	}
	it("recovers means and standard deviations per band", () => {
		const rand = seededRandom(3);
		const { a, b } = fill(
			4000,
			1,
			[0.6, 0.02, -0.03],
			[0.1, 0.02, 0.02],
			[-0.1, 0.01, 0.0],
			rand,
		);
		const s = reduceBands(a, b, 4000);
		expect(s.valid).toBe(true);
		expect(s.count[1]).toBe(4000);
		expect(s.photoMean[3]).toBeCloseTo(0.6, 2);
		expect(s.photoStd[3]).toBeCloseTo(0.1, 2);
		expect(s.layerMean[3]).toBeCloseTo(0.5, 2);
		expect(s.layerStd[3]).toBeCloseTo(0.1, 2);
		expect(s.photoMean[4]).toBeCloseTo(0.02, 2);
		expect(s.layerMean[4]).toBeCloseTo(0.03, 2);
	});
	it("empty bands borrow the nearest trusted one (lower neighbour first)", () => {
		const rand = seededRandom(5);
		const { a, b } = fill(
			500,
			1,
			[0.5, 0, 0],
			[0.05, 0.01, 0.01],
			[0, 0, 0],
			rand,
		);
		const s = reduceBands(a, b, 500);
		expect([...s.count]).toEqual([0, 500, 0, 0]);
		for (const k of [0, 2, 3])
			for (let c = 0; c < 3; c++) {
				expect(s.photoMean[k * 3 + c]).toBe(s.photoMean[3 + c]);
				expect(s.layerStd[k * 3 + c]).toBe(s.layerStd[3 + c]);
			}
	});
	it("a band with fewer than minCount pixels is untrusted", () => {
		const rand = seededRandom(5);
		const { a, b } = fill(
			59,
			2,
			[0.5, 0, 0],
			[0.05, 0.01, 0.01],
			[0, 0, 0],
			rand,
		);
		expect(reduceBands(a, b, 59).valid).toBe(false);
		expect(reduceBands(a, b, 59, 50).valid).toBe(true);
	});
	it("invalid input yields the identity transfer", () => {
		const s = reduceBands(new Float32Array(40), new Float32Array(40), 10);
		expect(s.valid).toBe(false);
		expect([...s.photoStd].every((v) => v === 1)).toBe(true);
	});
	it("ignores pixels the mask rejects", () => {
		const rand = seededRandom(9);
		const { a, b } = fill(
			200,
			0,
			[0.5, 0, 0],
			[0.05, 0.01, 0.01],
			[0, 0, 0],
			rand,
		);
		for (let i = 0; i < 200; i++) b[i * 4 + 3] = i < 100 ? 1 : 0;
		expect(reduceBands(a, b, 200).count[0]).toBe(100);
	});
	it("floors the standard deviation so flat bands do not explode the ratio", () => {
		const n = 100;
		const a = new Float32Array(n * 4);
		const b = new Float32Array(n * 4);
		for (let i = 0; i < n; i++) {
			a.set([0.8, 0, 0, Math.log10(3000)], i * 4);
			b.set([0.5, 0, 0, 1], i * 4);
		}
		const s = reduceBands(a, b, n);
		expect(s.photoStd[3]).toBeCloseTo(0.01, 7);
		expect(s.photoStd[4]).toBeCloseTo(0.004, 7);
		expect(s.layerStd[5]).toBeCloseTo(0.004, 7);
	});
	it("band edges: 999 m is near, 1000 m is mid, 20000 m is far-far", () => {
		const mk = (r: number) => {
			const a = new Float32Array(4 * 100);
			const b = new Float32Array(4 * 100);
			for (let i = 0; i < 100; i++) {
				a[i * 4 + 3] = Math.log10(r);
				b[i * 4 + 3] = 1;
			}
			return reduceBands(a, b, 100).count;
		};
		expect([...mk(999)]).toEqual([100, 0, 0, 0]);
		expect([...mk(1001)]).toEqual([0, 100, 0, 0]);
		expect([...mk(5001)]).toEqual([0, 0, 100, 0]);
		expect([...mk(20001)]).toEqual([0, 0, 0, 100]);
	});
});

describe("estimateNoiseSigma", () => {
	function noisyImage(w: number, h: number, sigma255: number, seed: number) {
		const rand = seededRandom(seed);
		const data = new Uint8ClampedArray(w * h * 4);
		for (let i = 0; i < w * h; i++) {
			// Box–Muller, the same noise on all channels so luma noise = sigma
			const g =
				Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
			const v = 128 + g * sigma255;
			data.set([v, v, v, 255], i * 4);
		}
		return { width: w, height: h, data } as unknown as ImageData;
	}
	it("is zero on a flat image", () => {
		const data = new Uint8ClampedArray(64 * 64 * 4).fill(128);
		expect(
			estimateNoiseSigma({
				width: 64,
				height: 64,
				data,
			} as unknown as ImageData),
		).toBe(0);
	});
	it("recovers the sigma of Gaussian noise on a flat sky (Immerkær estimator)", () => {
		const img = noisyImage(200, 200, 5, 21);
		const est = estimateNoiseSigma(img, () => true);
		expect(est).toBeGreaterThan((5 / 255) * 0.9);
		expect(est).toBeLessThan((5 / 255) * 1.1);
	});
	it("scales with the noise level", () => {
		const lo = estimateNoiseSigma(noisyImage(160, 160, 3, 1), () => true);
		const hi = estimateNoiseSigma(noisyImage(160, 160, 9, 1), () => true);
		expect(hi / lo).toBeGreaterThan(2.5);
		expect(hi / lo).toBeLessThan(3.5);
	});
	it("without sky it falls back to the flattest pixels and stays finite and non-negative", () => {
		const est = estimateNoiseSigma(noisyImage(100, 100, 6, 4));
		expect(Number.isFinite(est)).toBe(true);
		expect(est).toBeGreaterThan(0);
	});
});
