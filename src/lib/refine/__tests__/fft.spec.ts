// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { expectArrayClose, seededRandom, uniform } from "#/test/helpers";
import { correlateSpectra, fft, ifft, isPow2, rfft } from "../fft";

describe("isPow2", () => {
	it("accepts powers of two only", () => {
		for (const n of [1, 2, 4, 1024]) expect(isPow2(n)).toBe(true);
		for (const n of [0, -4, 3, 6, 1000]) expect(isPow2(n)).toBe(false);
	});
});

describe("fft", () => {
	it("rejects non power-of-two and mismatched sizes", () => {
		expect(() => fft(new Float64Array(6), new Float64Array(6))).toThrow();
		expect(() => fft(new Float64Array(8), new Float64Array(4))).toThrow();
	});
	it("an impulse transforms to a flat spectrum", () => {
		const x = new Float64Array(16);
		x[0] = 1;
		const { re, im } = rfft(x);
		expectArrayClose(re, new Float64Array(16).fill(1), 1e-12);
		expectArrayClose(im, new Float64Array(16), 1e-12);
	});
	it("a pure cosine puts energy in bins k and n-k", () => {
		const n = 64;
		const k = 5;
		const x = Array.from({ length: n }, (_, i) =>
			Math.cos((2 * Math.PI * k * i) / n),
		);
		const { re, im } = rfft(x);
		for (let i = 0; i < n; i++) {
			const expected = i === k || i === n - k ? n / 2 : 0;
			expect(re[i]).toBeCloseTo(expected, 9);
			expect(im[i]).toBeCloseTo(0, 9);
		}
	});
	it("matches a naive DFT", () => {
		const r = seededRandom(1);
		const n = 32;
		const x = Array.from({ length: n }, () => uniform(r, -1, 1));
		const { re, im } = rfft(x);
		for (let k = 0; k < n; k++) {
			let sr = 0;
			let si = 0;
			for (let j = 0; j < n; j++) {
				sr += x[j] * Math.cos((2 * Math.PI * j * k) / n);
				si -= x[j] * Math.sin((2 * Math.PI * j * k) / n);
			}
			expect(re[k]).toBeCloseTo(sr, 9);
			expect(im[k]).toBeCloseTo(si, 9);
		}
	});
	it("ifft inverts fft (complex input), and Parseval holds", () => {
		const r = seededRandom(2);
		const n = 128;
		const re = Float64Array.from({ length: n }, () => uniform(r, -1, 1));
		const im = Float64Array.from({ length: n }, () => uniform(r, -1, 1));
		const re0 = re.slice();
		const im0 = im.slice();
		const e0 = re0.reduce((s, v, i) => s + v * v + im0[i] * im0[i], 0);
		fft(re, im);
		const e1 = re.reduce((s, v, i) => s + v * v + im[i] * im[i], 0);
		expect(e1 / n).toBeCloseTo(e0, 8);
		ifft(re, im);
		expectArrayClose(re, re0, 1e-12);
		expectArrayClose(im, im0, 1e-12);
	});
	it("size 1 is the identity", () => {
		const re = Float64Array.of(3);
		const im = Float64Array.of(-2);
		fft(re, im);
		expect([re[0], im[0]]).toEqual([3, -2]);
	});
});

describe("correlateSpectra", () => {
	it("out[s] = sum_j a[j] b[(j+s) mod n], so a circular shift is found at its lag", () => {
		const r = seededRandom(3);
		const n = 64;
		const a = Float64Array.from({ length: n }, () => uniform(r, -1, 1));
		const shift = 17;
		const b = Float64Array.from(
			{ length: n },
			(_, i) => a[(i - shift + n) % n],
		);
		const c = correlateSpectra(rfft(a), rfft(b));
		let best = 0;
		for (let s = 1; s < n; s++) if (c[s] > c[best]) best = s;
		expect(best).toBe(shift);
		for (let s = 0; s < n; s += 7) {
			let direct = 0;
			for (let j = 0; j < n; j++) direct += a[j] * b[(j + s) % n];
			expect(c[s]).toBeCloseTo(direct, 9);
		}
	});
});
