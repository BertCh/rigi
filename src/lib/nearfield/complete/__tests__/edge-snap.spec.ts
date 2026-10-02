// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { PixelClass } from "../../types";
import { computeRimAlpha, snapMixedDepthEdges } from "../edge-snap";

const W = 24;
const H = 10;
/** fg z=5 left of x0, bg z=20 right, with a ramp of `ramp` cells between. */
function stepGrid(x0: number, ramp: number): Float32Array {
	const z = new Float32Array(W * H);
	for (let j = 0; j < H; j++)
		for (let i = 0; i < W; i++) {
			const t = Math.min(1, Math.max(0, (i - x0) / ramp));
			z[j * W + i] = Math.exp(Math.log(5) + t * Math.log(4));
		}
	return z;
}

describe("snapMixedDepthEdges", () => {
	it("removes the intermediate ramp: every surviving cell is at the fg or bg depth", () => {
		const z = stepGrid(10, 6);
		const before = z.slice();
		const r = snapMixedDepthEdges(z, W, H);
		expect(z).toEqual(before); // input untouched
		let dropped = 0;
		for (let k = 0; k < W * H; k++) {
			if (Number.isNaN(r.z[k])) {
				dropped++;
				continue;
			}
			const nearFg = Math.abs(Math.log(r.z[k] / 5)) < 0.3;
			const nearBg = Math.abs(Math.log(r.z[k] / 20)) < 0.3;
			expect(nearFg || nearBg).toBe(true);
		}
		expect(dropped).toBeGreaterThan(0);
		expect(dropped).toBe(r.dropped.reduce((a, b) => a + b, 0));
		// a ramp cell near the middle is dropped, far fg / bg cells are kept
		expect(r.dropped[3 * W + 13]).toBe(1);
		expect(r.z[3 * W + 2]).toBeCloseTo(5, 4);
		expect(r.z[3 * W + 22]).toBeCloseTo(20, 3);
	});

	it("leaves a smooth grid and noise-free flat regions identical", () => {
		const flat = new Float32Array(W * H).fill(7);
		const a = snapMixedDepthEdges(flat, W, H);
		expect(Array.from(a.z)).toEqual(Array.from(flat));
		expect(a.dropped.every((v) => v === 0)).toBe(true);
		const gentle = new Float32Array(W * H);
		for (let k = 0; k < W * H; k++) gentle[k] = 6 + 0.02 * (k % W);
		const b = snapMixedDepthEdges(gentle, W, H);
		expect(Array.from(b.z)).toEqual(Array.from(gentle));
	});

	it("is deterministic and keeps invalid cells NaN", () => {
		const z = stepGrid(8, 5);
		z[5] = Number.NaN;
		z[7] = 0;
		const a = snapMixedDepthEdges(z, W, H);
		const b = snapMixedDepthEdges(z, W, H);
		expect(Array.from(a.z.map((v) => (Number.isNaN(v) ? -1 : v)))).toEqual(
			Array.from(b.z.map((v) => (Number.isNaN(v) ? -1 : v))),
		);
		expect(Number.isNaN(a.z[5])).toBe(true);
		expect(Number.isNaN(a.z[7])).toBe(true);
	});
});

describe("computeRimAlpha", () => {
	const w = 12;
	const h = 12;
	const cls = new Uint8Array(w * h);
	for (let j = 2; j < 10; j++)
		for (let i = 2; i < 10; i++) cls[j * w + i] = PixelClass.Object;
	const soft = {
		width: w,
		height: h,
		data: new Uint8Array(w * h).fill(128),
	};
	it("softens only the Object rim from the soft mask, clamped to the floor", () => {
		const a = computeRimAlpha(cls, w, h, soft, { rim: 1, floor: 0.25 });
		expect(a[2 * w + 2]).toBeCloseTo(128 / 255, 3); // corner = rim
		expect(a[5 * w + 5]).toBe(1); // interior
		expect(a[0]).toBe(1); // not Object
		soft.data.fill(0);
		const b = computeRimAlpha(cls, w, h, soft, { rim: 1, floor: 0.25 });
		expect(b[2 * w + 2]).toBe(0.25);
	});
	it("is all ones without a mask", () => {
		expect(computeRimAlpha(cls, w, h, null).every((v) => v === 1)).toBe(true);
	});
});
