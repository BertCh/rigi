// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { irfft2Reference, rfft2Reference } from "../fft-reference";

describe("fft-reference", () => {
	it("an impulse has a flat spectrum, a constant has only DC", () => {
		const h = 4;
		const w = 8;
		const impulse = new Float32Array(h * w);
		impulse[0] = 1;
		const spec = rfft2Reference(impulse, 1, h, w);
		expect(spec.length).toBe(h * (w / 2 + 1) * 2);
		for (let i = 0; i < spec.length; i += 2) {
			expect(spec[i]).toBeCloseTo(1, 6);
			expect(spec[i + 1]).toBeCloseTo(0, 6);
		}
		const flat = rfft2Reference(new Float32Array(h * w).fill(2), 1, h, w);
		expect(flat[0]).toBeCloseTo(2 * h * w, 5);
		for (let i = 2; i < flat.length; i++) expect(flat[i]).toBeCloseTo(0, 5);
	});

	it("irfft2 inverts rfft2 (batched, non-square)", () => {
		const b = 2;
		const h = 8;
		const w = 16;
		const x = Float32Array.from({ length: b * h * w }, (_, i) =>
			Math.sin(i * 1.3),
		);
		const back = irfft2Reference(rfft2Reference(x, b, h, w), b, h, w);
		for (let i = 0; i < x.length; i++) expect(back[i]).toBeCloseTo(x[i], 5);
	});

	it("a shifted cosine lands in its bin with the right phase", () => {
		const h = 8;
		const w = 8;
		const x = Float32Array.from({ length: h * w }, (_, i) =>
			Math.cos((2 * Math.PI * 2 * (i % w)) / w),
		);
		const spec = rfft2Reference(x, 1, h, w);
		// bin (v=0, u=2) holds h * w / 2
		expect(spec[(0 * 5 + 2) * 2]).toBeCloseTo((h * w) / 2, 5);
		expect(spec[(0 * 5 + 2) * 2 + 1]).toBeCloseTo(0, 5);
	});
});
