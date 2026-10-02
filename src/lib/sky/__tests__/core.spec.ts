// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { expectArrayClose, seededRandom } from "#/test/helpers";
import {
	boxMean,
	classicalSky,
	fastGuidedFilter,
	modelSize,
	normalise,
	refineToWorking,
	resamplePlanes,
	rgbPlanes,
	toBytes,
	workingSize,
} from "../core";

const randomPlane = (n: number, seed: number) => {
	const r = seededRandom(seed);
	return Float32Array.from({ length: n }, () => r());
};

describe("workingSize", () => {
	it("scales the long side down to longSide, keeping aspect", () => {
		expect(workingSize(4000, 3000, 1000)).toEqual({ width: 1000, height: 750 });
		expect(workingSize(3000, 4000, 1000)).toEqual({ width: 750, height: 1000 });
	});
	it("never upscales", () => {
		expect(workingSize(100, 50, 1000)).toEqual({ width: 100, height: 50 });
	});
	it("never returns a zero side", () => {
		expect(workingSize(10000, 1, 100).height).toBe(1);
	});
});

describe("modelSize", () => {
	it("returns multiples of 32, at least 64", () => {
		for (const [w, h] of [
			[4000, 3000],
			[1234, 987],
			[5000, 40],
			[320, 320],
		]) {
			const m = modelSize(w, h, 320);
			expect(m.width % 32).toBe(0);
			expect(m.height % 32).toBe(0);
			expect(m.width).toBeGreaterThanOrEqual(64);
			expect(m.height).toBeGreaterThanOrEqual(64);
		}
	});
	it("long side lands on longSide when it is a multiple of 32", () => {
		expect(modelSize(4000, 3000, 320)).toEqual({ width: 320, height: 256 });
	});
	it("upscales small images (unlike workingSize)", () => {
		expect(modelSize(64, 64, 320)).toEqual({ width: 320, height: 320 });
	});
});

describe("resamplePlanes", () => {
	it("returns the input itself at equal size", () => {
		const a = randomPlane(12, 1);
		expect(resamplePlanes(a, 4, 3, 1, 4, 3)).toBe(a);
	});
	it("a constant field stays constant, up and down", () => {
		const a = new Float32Array(3 * 8 * 6).fill(0.4);
		for (const [W, H] of [
			[4, 3],
			[16, 12],
			[5, 7],
		]) {
			const out = resamplePlanes(a, 8, 6, 3, W, H);
			expect(out.length).toBe(3 * W * H);
			for (const v of out) expect(v).toBeCloseTo(0.4, 6);
		}
	});
	it("area-average downsample by 2 equals the 2x2 block mean", () => {
		const a = Float32Array.from([
			1, 3, 5, 7, 2, 4, 6, 8, 0, 0, 1, 1, 0, 0, 1, 1,
		]);
		const out = resamplePlanes(a, 4, 4, 1, 2, 2);
		expectArrayClose(out, [2.5, 6.5, 0, 1], 1e-6);
	});
	it("downsampling preserves the mean for fractional ratios", () => {
		const a = randomPlane(9 * 9, 2);
		const out = resamplePlanes(a, 9, 9, 1, 4, 4);
		const mean = (x: Float32Array) => x.reduce((s, v) => s + v, 0) / x.length;
		expect(mean(out)).toBeCloseTo(mean(a), 5);
	});
	it("bilinear upsample reproduces a linear ramp in the interior", () => {
		const a = Float32Array.from({ length: 4 }, (_, i) => i); // 4x1 ramp
		const out = resamplePlanes(a, 4, 1, 1, 8, 1);
		// output pixel j centre maps to source coordinate (j+0.5)/2 - 0.5
		for (let j = 1; j < 7; j++)
			expect(out[j]).toBeCloseTo((j + 0.5) / 2 - 0.5, 5);
	});
	it("planes are independent", () => {
		const a = new Float32Array(2 * 4);
		a.fill(0, 0, 4);
		a.fill(1, 4, 8);
		const out = resamplePlanes(a, 2, 2, 2, 1, 1);
		expect(Array.from(out)).toEqual([0, 1]);
	});
});

describe("rgbPlanes / normalise / toBytes", () => {
	it("rgbPlanes splits interleaved RGBA into 0..1 planes", () => {
		const out = rgbPlanes({
			width: 2,
			height: 1,
			data: new Uint8Array([255, 0, 51, 255, 0, 255, 102, 255]),
		});
		expectArrayClose(out, [1, 0, 0, 1, 0.2, 0.4], 1e-6);
	});
	it("normalise applies ImageNet mean/std per channel", () => {
		const out = normalise(
			Float32Array.from([0.485, 0.485, 0.456, 0.456, 0.406, 0.406]),
			2,
		);
		expectArrayClose(out, new Float32Array(6), 1e-6);
		const hi = normalise(Float32Array.from([1, 1, 1]), 1);
		expect(hi[0]).toBeCloseTo((1 - 0.485) / 0.229, 5);
		expect(hi[1]).toBeCloseTo((1 - 0.456) / 0.224, 5);
		expect(hi[2]).toBeCloseTo((1 - 0.406) / 0.225, 5);
	});
	it("toBytes saturates and rounds", () => {
		expect(Array.from(toBytes(Float32Array.from([-1, 0, 0.5, 1, 2])))).toEqual([
			0, 0, 128, 255, 255,
		]);
	});
	it("toBytes maps NaN to 0", () => {
		// NaN is neither <= 0 nor >= 1; Math.round(NaN) is NaN, which a Uint8Array stores as 0
		expect(toBytes(Float32Array.from([Number.NaN]))[0]).toBe(0);
	});
});

describe("boxMean", () => {
	it("radius 0 is the identity", () => {
		const a = randomPlane(20, 3);
		expectArrayClose(boxMean(a, 5, 4, 0), a, 1e-6);
	});
	it("matches a brute-force clamped-window mean", () => {
		const w = 7;
		const h = 5;
		const a = randomPlane(w * h, 4);
		const r = 2;
		const out = boxMean(a, w, h, r);
		for (let y = 0; y < h; y++)
			for (let x = 0; x < w; x++) {
				let s = 0;
				let c = 0;
				for (let j = Math.max(0, y - r); j <= Math.min(h - 1, y + r); j++)
					for (let i = Math.max(0, x - r); i <= Math.min(w - 1, x + r); i++) {
						s += a[j * w + i];
						c++;
					}
				expect(out[y * w + x]).toBeCloseTo(s / c, 5);
			}
	});
	it("a constant stays constant even with radius larger than the image", () => {
		const out = boxMean(new Float32Array(12).fill(3), 4, 3, 10);
		for (const v of out) expect(v).toBeCloseTo(3, 6);
	});
	it("writes into a supplied output buffer", () => {
		const out = new Float32Array(4);
		expect(boxMean(new Float32Array(4).fill(1), 2, 2, 1, out)).toBe(out);
	});
});

describe("fastGuidedFilter", () => {
	const lw = 16;
	const lh = 16;
	const n = lw * lh;
	const guide = (w: number, h: number) => {
		// vertical step edge in all channels: left dark, right bright
		const g = new Float32Array(3 * w * h);
		for (let c = 0; c < 3; c++)
			for (let y = 0; y < h; y++)
				for (let x = 0; x < w; x++)
					g[c * w * h + y * w + x] = x < w / 2 ? 0.1 : 0.9;
		return g;
	};
	it("outputs values in [0, 1] at the high resolution", () => {
		const p = randomPlane(n, 6);
		const q = fastGuidedFilter(guide(lw, lh), p, lw, lh, guide(32, 32), 32, 32);
		expect(q.length).toBe(32 * 32);
		for (const v of q) {
			expect(v).toBeGreaterThanOrEqual(0);
			expect(v).toBeLessThanOrEqual(1);
		}
	});
	it("a constant p stays (almost) constant", () => {
		const p = new Float32Array(n).fill(0.7);
		const q = fastGuidedFilter(guide(lw, lh), p, lw, lh, guide(lw, lh), lw, lh);
		for (const v of q) expect(v).toBeCloseTo(0.7, 3);
	});
	it("snaps a blurry mask to the guide's edge", () => {
		// soft ramp mask across the true edge at x = 8
		const p = Float32Array.from({ length: n }, (_, i) => {
			const x = i % lw;
			return Math.min(1, Math.max(0, (x - 4) / 8));
		});
		const q = fastGuidedFilter(
			guide(lw, lh),
			p,
			lw,
			lh,
			guide(lw, lh),
			lw,
			lh,
			{
				radius: 2,
				eps: 1e-4,
			},
		);
		const row = 8 * lw;
		// far from the edge it is saturated; the transition is sharper than the input ramp
		expect(q[row + 1]).toBeLessThan(0.3);
		expect(q[row + 14]).toBeGreaterThan(0.7);
		expect(Math.abs(q[row + 9] - q[row + 6])).toBeGreaterThan(
			Math.abs(p[row + 9] - p[row + 6]),
		);
	});
});

describe("refineToWorking", () => {
	const W = 32;
	const H = 24;
	const rgb = new Float32Array(3 * W * H);
	for (let c = 0; c < 3; c++)
		for (let y = 0; y < H; y++)
			for (let x = 0; x < W; x++)
				rgb[c * W * H + y * W + x] = y < 12 ? 0.8 : 0.2;
	const lw = 16;
	const lh = 12;
	const prob = Float32Array.from({ length: lw * lh }, (_, i) =>
		((i / lw) | 0) < 6 ? 1 : 0,
	);
	it("without refine is the plain bilinear upsample", () => {
		const out = refineToWorking(
			rgb,
			W,
			H,
			{ prob, width: lw, height: lh },
			false,
		);
		expectArrayClose(out, resamplePlanes(prob, lw, lh, 1, W, H), 0);
	});
	it("with refine keeps sky above and non-sky below, in [0,1]", () => {
		const out = refineToWorking(
			rgb,
			W,
			H,
			{ prob, width: lw, height: lh },
			true,
		);
		expect(out.length).toBe(W * H);
		for (const v of out) {
			expect(v).toBeGreaterThanOrEqual(0);
			expect(v).toBeLessThanOrEqual(1);
		}
		expect(out[2 * W + 10]).toBeGreaterThan(0.95);
		expect(out[20 * W + 10]).toBeLessThan(0.05);
	});
	it("far from the model boundary the refined mask equals the upsampled model", () => {
		const up = resamplePlanes(prob, lw, lh, 1, W, H);
		const out = refineToWorking(
			rgb,
			W,
			H,
			{ prob, width: lw, height: lh },
			true,
		);
		expect(out[0]).toBeCloseTo(up[0], 5);
		expect(out[(H - 1) * W]).toBeCloseTo(up[(H - 1) * W], 5);
	});
});

describe("classicalSky", () => {
	const mk = (W: number, H: number) => {
		const rgb = new Float32Array(3 * W * H);
		const n = W * H;
		for (let y = 0; y < H; y++)
			for (let x = 0; x < W; x++) {
				const sky = y < H * 0.4;
				const i = y * W + x;
				rgb[i] = sky ? 0.45 : 0.25;
				rgb[n + i] = sky ? 0.65 : 0.3;
				rgb[2 * n + i] = sky ? 0.95 : 0.2;
			}
		return rgb;
	};
	it("returns a probability plane at <= 640 px with values in [0,1]", () => {
		const r = classicalSky(mk(80, 60), 80, 60);
		expect(r.width).toBe(80);
		expect(r.height).toBe(60);
		expect(r.prob.length).toBe(80 * 60);
		for (const v of r.prob) {
			expect(v).toBeGreaterThanOrEqual(0);
			expect(v).toBeLessThanOrEqual(1);
		}
	});
	it("caps the long side at 640 px", () => {
		const r = classicalSky(mk(1280, 8), 1280, 8);
		expect(r.width).toBe(640);
		expect(r.height).toBe(32); // minimum side
	});
	it("a blue-above-dark-below scene is sky-ish above and not below", () => {
		const r = classicalSky(mk(96, 64), 96, 64);
		const col = 48;
		expect(r.prob[2 * 96 + col]).toBeGreaterThan(r.prob[60 * 96 + col]);
		expect(r.prob[60 * 96 + col]).toBeLessThan(0.5);
	});
});
