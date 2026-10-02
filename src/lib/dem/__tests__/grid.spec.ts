// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { seededRandom } from "#/test/helpers";
import {
	ancestorCrop,
	blendCorners,
	downsampleHeights2,
	downsampleSteps,
	gridCorners,
	sampleGrid,
} from "../grid";

const randomGrid = (S: number, seed = 5) => {
	const r = seededRandom(seed);
	return Float32Array.from({ length: S * S }, () => r() * 1000);
};
const plane = (S: number) =>
	Float32Array.from(
		{ length: S * S },
		(_, i) => 10 * (i % S) + 3 * ((i / S) | 0),
	);

describe("sampleGrid", () => {
	it("returns the exact sample at pixel centres", () => {
		const h = randomGrid(8);
		for (let y = 0; y < 8; y++)
			for (let x = 0; x < 8; x++)
				expect(sampleGrid(h, 8, x + 0.5, y + 0.5)).toBeCloseTo(h[y * 8 + x], 3);
	});
	it("reproduces a linear ramp between centres", () => {
		const h = plane(8);
		// at pixel coords (px,py) value of the plane at (px-0.5, py-0.5)
		expect(sampleGrid(h, 8, 3.25, 4.75)).toBeCloseTo(10 * 2.75 + 3 * 4.25, 4);
	});
	it("clamps outside the grid to the edge samples", () => {
		const h = randomGrid(4);
		expect(sampleGrid(h, 4, -10, -10)).toBe(h[0]);
		expect(sampleGrid(h, 4, 99, 99)).toBe(h[15]);
	});
	it("is monotone along a monotone row", () => {
		const h = plane(8);
		let prev = -Infinity;
		for (let p = 0; p <= 8; p += 0.1) {
			const v = sampleGrid(h, 8, p, 3);
			expect(v).toBeGreaterThanOrEqual(prev - 1e-9);
			prev = v;
		}
	});
});

describe("gridCorners + blendCorners", () => {
	it("equal sampleGrid bit for bit", () => {
		const S = 16;
		const h = randomGrid(S, 9);
		const r = seededRandom(2);
		const out: number[] = [];
		for (let i = 0; i < 200; i++) {
			const px = r() * (S + 2) - 1;
			const py = r() * (S + 2) - 1;
			gridCorners(S, px, py, out);
			const [x0, y0, x1, y1, fx, fy] = out;
			const v = blendCorners(
				h[y0 * S + x0],
				h[y0 * S + x1],
				h[y1 * S + x0],
				h[y1 * S + x1],
				fx,
				fy,
			);
			expect(v).toBe(sampleGrid(h, S, px, py));
		}
	});
	it("returns the out array and keeps indices in range", () => {
		const out: number[] = [];
		expect(gridCorners(4, 100, -100, out)).toBe(out);
		expect(out.slice(0, 4).every((v) => v >= 0 && v <= 3)).toBe(true);
		expect(out[4]).toBeGreaterThanOrEqual(0);
		expect(out[5]).toBeGreaterThanOrEqual(0);
	});
});

describe("ancestorCrop", () => {
	it("returns the same array when key = source and size matches", () => {
		const h = randomGrid(8);
		const k = { z: 5, x: 3, y: 4 };
		expect(ancestorCrop(h, k, k, 8)).toBe(h);
	});
	it("a child quadrant of a plane is the plane's sub-region", () => {
		const S = 16;
		const h = plane(S);
		const src = { z: 3, x: 1, y: 1 };
		// child (z4, 2*1+1, 2*1+0): east half, north half
		const key = { z: 4, x: 3, y: 2 };
		const out = ancestorCrop(h, src, key, S);
		// output pixel (i,j) centre maps to ancestor pixel coord 8 + (i+.5)/2 - .5 along x
		const expectAt = (i: number, j: number) => {
			const ax = 8 + (i + 0.5) / 2 - 0.5;
			const ay = 0 + (j + 0.5) / 2 - 0.5;
			return (
				10 * Math.min(Math.max(ax, 0), 15) + 3 * Math.min(Math.max(ay, 0), 15)
			);
		};
		for (const [i, j] of [
			[0, 3],
			[7, 7],
			[10, 12],
			[15, 15],
		])
			expect(out[j * S + i]).toBeCloseTo(expectAt(i, j), 3);
	});
	it("downsamples when the target size is smaller", () => {
		const h = plane(16);
		const k = { z: 2, x: 0, y: 0 };
		const out = ancestorCrop(h, k, k, 8);
		expect(out.length).toBe(64);
		// a linear field resampled at centres stays linear: spacing doubles
		expect(out[1] - out[0]).toBeCloseTo(20, 3);
	});
	it("output values stay within the source range", () => {
		const h = randomGrid(16, 4);
		const lo = Math.min(...h);
		const hi = Math.max(...h);
		const out = ancestorCrop(h, { z: 1, x: 0, y: 0 }, { z: 3, x: 2, y: 1 }, 16);
		for (const v of out) {
			expect(v).toBeGreaterThanOrEqual(lo - 1e-3);
			expect(v).toBeLessThanOrEqual(hi + 1e-3);
		}
	});
});

describe("downsampleHeights2", () => {
	it("averages 2x2 blocks", () => {
		const h = Float32Array.from([
			1, 2, 5, 6, 3, 4, 7, 8, 1, 1, 2, 2, 1, 1, 2, 2,
		]);
		expect(Array.from(downsampleHeights2(h, 4))).toEqual([2.5, 6.5, 1, 2]);
	});
	it("preserves the mean", () => {
		const h = randomGrid(16, 8);
		const d = downsampleHeights2(h, 16);
		const mean = (a: Float32Array) => a.reduce((s, v) => s + v, 0) / a.length;
		expect(mean(d)).toBeCloseTo(mean(h), 2);
	});
});

describe("downsampleSteps", () => {
	it("halves while above 2 samples per segment and 256 px", () => {
		expect(downsampleSteps(512, 128)).toBe(1); // 512 > 256 and >256 px: -> 256 stops
		expect(downsampleSteps(256, 64)).toBe(0);
		expect(downsampleSteps(1024, 64)).toBe(2); // 1024 -> 512 -> 256
		expect(downsampleSteps(1024, 4)).toBe(2);
	});
	it("never goes below 256 px, and is 0 for small tiles", () => {
		expect(downsampleSteps(128, 1)).toBe(0);
		expect(downsampleSteps(4096, 1)).toBe(4);
	});
});
