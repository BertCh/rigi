// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { seededRandom } from "#/test/helpers";
import { guidedFilter } from "../guided-filter";

const W = 32;
const H = 24;

/** left half 0, right half 1 */
const edgeImage = () => {
	const a = new Float32Array(W * H);
	for (let y = 0; y < H; y++) for (let x = W / 2; x < W; x++) a[y * W + x] = 1;
	return a;
};

describe("guidedFilter", () => {
	it("keeps a constant mask constant", () => {
		const I = edgeImage();
		const p = new Float32Array(W * H).fill(0.4);
		const q = guidedFilter(I, p, W, H, 3, 1e-3);
		for (const v of q) expect(v).toBeCloseTo(0.4, 5);
	});
	it("with the guide equal to the mask and a small eps, it returns the mask", () => {
		const I = edgeImage();
		const q = guidedFilter(I, I, W, H, 4, 1e-6);
		for (let i = 0; i < q.length; i++) expect(q[i]).toBeCloseTo(I[i], 3);
	});
	it("snaps a blurry mask onto the guide's edge", () => {
		const I = edgeImage();
		// the same edge, but displaced by 2 px and soft
		const p = new Float32Array(W * H);
		for (let y = 0; y < H; y++)
			for (let x = 0; x < W; x++)
				p[y * W + x] = Math.min(1, Math.max(0, (x - W / 2 + 2 + 3) / 6));
		const q = guidedFilter(I, p, W, H, 4, 1e-3);
		const row = 12 * W;
		// far from the edge: unchanged side; at the edge: moves toward the guide's 0/1 step
		expect(q[row + W / 2 - 1]).toBeLessThan(p[row + W / 2 - 1]);
		expect(q[row + W / 2]).toBeGreaterThan(p[row + W / 2]);
		for (const v of q) {
			expect(v).toBeGreaterThanOrEqual(0);
			expect(v).toBeLessThanOrEqual(1);
		}
	});
	it("a huge eps degenerates to a plain box blur of the mask", () => {
		const rand = seededRandom(2);
		const I = Float32Array.from({ length: W * H }, () => rand());
		const p = Float32Array.from({ length: W * H }, () => rand());
		const q = guidedFilter(I, p, W, H, 2, 1e6);
		// q ≈ mean(mean(p)) so it is smoother than p: lower variance
		const variance = (a: Float32Array) => {
			const m = a.reduce((s, v) => s + v, 0) / a.length;
			return a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length;
		};
		expect(variance(q)).toBeLessThan(variance(p) * 0.2);
	});
	it("output is always clamped to [0, 1] and has the input's size", () => {
		const rand = seededRandom(8);
		const I = Float32Array.from({ length: W * H }, () => rand());
		const p = Float32Array.from({ length: W * H }, () => rand() * 3 - 1);
		const q = guidedFilter(I, p, W, H, 1, 1e-4);
		expect(q).toHaveLength(W * H);
		for (const v of q) {
			expect(v).toBeGreaterThanOrEqual(0);
			expect(v).toBeLessThanOrEqual(1);
		}
	});
	it("works for radii larger than the image (border clamping) and a 1x1 image", () => {
		const I = edgeImage();
		const q = guidedFilter(I, I, W, H, 500, 1e-2);
		expect(q.every(Number.isFinite)).toBe(true);
		const one = guidedFilter(
			new Float32Array([0.5]),
			new Float32Array([0.7]),
			1,
			1,
			3,
			1e-3,
		);
		expect(one[0]).toBeCloseTo(0.7, 5);
	});
});
