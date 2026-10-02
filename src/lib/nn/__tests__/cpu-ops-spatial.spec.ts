// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { seededRandom } from "#/test/helpers";
import { expectTensor, nn, randomTensor, tensor, values } from "./util";

describe("maxPool2d / avgPool2d", () => {
	const ramp4 = tensor(
		Array.from({ length: 16 }, (_, i) => i + 1),
		[1, 1, 4, 4],
	);
	const ramp3 = tensor([1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 1, 3, 3]);

	it("2x2 kernel, default stride = kernel", () => {
		expectTensor(
			nn.maxPool2d(ramp4, { kernel: 2 }),
			[1, 1, 2, 2],
			[6, 8, 14, 16],
		);
		// (1+2+5+6)/4 = 3.5, (3+4+7+8)/4 = 5.5, 11.5, 13.5
		expectTensor(
			nn.avgPool2d(ramp4, { kernel: 2 }),
			[1, 1, 2, 2],
			[3.5, 5.5, 11.5, 13.5],
		);
	});

	it("stride 1 overlapping windows", () => {
		expectTensor(
			nn.maxPool2d(ramp3, { kernel: 2, stride: 1 }),
			[1, 1, 2, 2],
			[5, 6, 8, 9],
		);
		expectTensor(
			nn.avgPool2d(ramp3, { kernel: 2, stride: 1 }),
			[1, 1, 2, 2],
			[3, 4, 6, 7],
		);
	});

	it("padding: max ignores padding; avg countIncludePad true vs false", () => {
		const o = { kernel: 2, stride: 2, padding: 1 };
		// windows: (0,0) {1}; (0,1) {2,3}; (1,0) {4,7}; (1,1) {5,6,8,9}
		expectTensor(nn.maxPool2d(ramp3, o), [1, 1, 2, 2], [1, 3, 7, 9]);
		// include pad: divisor 4 -> 1/4, 5/4, 11/4, 28/4
		expectTensor(nn.avgPool2d(ramp3, o), [1, 1, 2, 2], [0.25, 1.25, 2.75, 7]);
		expectTensor(
			nn.avgPool2d(ramp3, { ...o, countIncludePad: true }),
			[1, 1, 2, 2],
			[0.25, 1.25, 2.75, 7],
		);
		// exclude pad: divisors 1, 2, 2, 4 -> 1, 2.5, 5.5, 7
		expectTensor(
			nn.avgPool2d(ramp3, { ...o, countIncludePad: false }),
			[1, 1, 2, 2],
			[1, 2.5, 5.5, 7],
		);
	});

	it("3x3 window with padding 1 over a 2x2 input", () => {
		const x = tensor([1, 2, 3, 4], [1, 1, 2, 2]);
		const o = { kernel: 3, stride: 1, padding: 1 };
		expectTensor(nn.maxPool2d(x, o), [1, 1, 2, 2], [4, 4, 4, 4]);
		expectTensor(nn.avgPool2d(x, o), [1, 1, 2, 2], new Array(4).fill(10 / 9));
		expectTensor(
			nn.avgPool2d(x, { ...o, countIncludePad: false }),
			[1, 1, 2, 2],
			new Array(4).fill(2.5),
		);
	});

	it("ceilMode keeps the partial last window", () => {
		const x = tensor([1, 2, 3, 4, 5], [1, 1, 1, 5]);
		const o = {
			kernel: [1, 2] as [number, number],
			stride: [1, 2] as [number, number],
		};
		expectTensor(nn.maxPool2d(x, o), [1, 1, 1, 2], [2, 4]);
		expectTensor(
			nn.maxPool2d(x, { ...o, ceilMode: true }),
			[1, 1, 1, 3],
			[2, 4, 5],
		);
		// last window is clipped to the input: divisor 1
		expectTensor(
			nn.avgPool2d(x, { ...o, ceilMode: true }),
			[1, 1, 1, 3],
			[1.5, 3.5, 5],
		);
	});

	it("dilation", () => {
		const x = tensor([1, 2, 3, 4, 5], [1, 1, 1, 5]);
		// taps (i, i+2)
		expectTensor(
			nn.maxPool2d(x, { kernel: [1, 2], stride: 1, dilation: [1, 2] }),
			[1, 1, 1, 3],
			[3, 4, 5],
		);
		expectTensor(
			nn.avgPool2d(x, { kernel: [1, 2], stride: 1, dilation: [1, 2] }),
			[1, 1, 1, 3],
			[2, 3, 4],
		);
	});

	it("channels and batch pooled independently", () => {
		const x = tensor([1, 2, 3, 4, 10, 20, 30, 40], [1, 2, 2, 2]);
		expectTensor(nn.maxPool2d(x, { kernel: 2 }), [1, 2, 1, 1], [4, 40]);
	});

	it("errors on non-NCHW input", () => {
		expect(() => nn.maxPool2d(nn.zeros([2, 2]), { kernel: 2 })).toThrow();
	});
});

describe("nmsMaxPool", () => {
	it("keeps only the window maximum", () => {
		const x = tensor([1, 2, 3, 4, 9, 6, 7, 8, 5], [1, 1, 3, 3]);
		expectTensor(
			nn.nmsMaxPool(x, 1),
			[1, 1, 3, 3],
			[0, 0, 0, 0, 9, 0, 0, 0, 0],
		);
	});

	it("radius 0 is the identity; radius 1 on 2x2", () => {
		const x = tensor([5, 1, 1, 1], [1, 1, 2, 2]);
		expectTensor(nn.nmsMaxPool(x, 0), [1, 1, 2, 2], [5, 1, 1, 1]);
		expectTensor(nn.nmsMaxPool(x, 1), [1, 1, 2, 2], [5, 0, 0, 0]);
	});

	it("ties are all kept; far maxima survive; channels independent", () => {
		expectTensor(
			nn.nmsMaxPool(tensor([2, 2], [1, 1, 1, 2]), 1),
			[1, 1, 1, 2],
			[2, 2],
		);
		const row = tensor([5, 0, 0, 0, 7, 0, 0, 0, 3, 1, 1, 1], [1, 2, 1, 6]);
		// radius 1: channel 0 [5,0,0,0,7,0] -> 5 and 7 survive; channel 1 [0,0,3,1,1,1] -> 3 survives, plus 1 at idx 3? no (3 in window)
		expectTensor(
			nn.nmsMaxPool(row, 1),
			[1, 2, 1, 6],
			[5, 0, 0, 0, 7, 0, 0, 0, 3, 0, 1, 1],
		);
	});

	it("errors on non-NCHW", () => {
		expect(() => nn.nmsMaxPool(nn.zeros([3, 3]), 1)).toThrow();
	});
});

describe("interpolate", () => {
	// x = [[1,2],[3,4]]; both axes interpolate linearly, so out(i,j) = 1 + c_j + 2 r_i
	const x = tensor([1, 2, 3, 4], [1, 1, 2, 2]);

	it("bilinear 2x2 -> 4x4, align_corners=false (src = (d+.5)/2 - .5, clamped at 0)", () => {
		// 1-D fractions: d=0 -> -0.25 -> 0; d=1 -> .25; d=2 -> .75; d=3 -> 1.25 -> 1
		expectTensor(
			nn.interpolate(x, { size: [4, 4], mode: "bilinear" }),
			[1, 1, 4, 4],
			[
				1, 1.25, 1.75, 2, 1.5, 1.75, 2.25, 2.5, 2.5, 2.75, 3.25, 3.5, 3, 3.25,
				3.75, 4,
			],
		);
	});

	it("bilinear align_corners=true (src = d/3)", () => {
		const t = 1 / 3;
		const c = [0, t, 2 * t, 1];
		const expected: number[] = [];
		for (const r of c) for (const q of c) expected.push(1 + q + 2 * r);
		expectTensor(
			nn.interpolate(x, { size: [4, 4], mode: "bilinear", alignCorners: true }),
			[1, 1, 4, 4],
			expected,
		);
		// spot-check literals: corners and centre of the first row
		const v = values(
			nn.interpolate(x, { size: [4, 4], mode: "bilinear", alignCorners: true }),
		);
		expect([v[0], v[3], v[12], v[15]]).toEqual([1, 2, 3, 4]);
		expect(v[1]).toBeCloseTo(1.3333333, 6);
	});

	it("bilinear via scale factor matches size", () => {
		expectTensor(
			nn.interpolate(x, { scale: 2, mode: "bilinear" }),
			[1, 1, 4, 4],
			values(nn.interpolate(x, { size: [4, 4], mode: "bilinear" })),
		);
	});

	it("bilinear downsample 4 -> 2 averages neighbour pairs", () => {
		const row = tensor([1, 2, 3, 4], [1, 1, 1, 4]);
		// src = (d+.5)*2 - .5 = 0.5, 2.5
		expectTensor(
			nn.interpolate(row, { size: [1, 2], mode: "bilinear" }),
			[1, 1, 1, 2],
			[1.5, 3.5],
		);
	});

	it("nearest 2x2 -> 4x4 replicates (src = floor(d/2))", () => {
		expectTensor(
			nn.interpolate(x, { size: [4, 4], mode: "nearest" }),
			[1, 1, 4, 4],
			[1, 1, 2, 2, 1, 1, 2, 2, 3, 3, 4, 4, 3, 3, 4, 4],
		);
		expectTensor(
			nn.interpolate(x, { scale: 2, mode: "nearest" }),
			[1, 1, 4, 4],
			[1, 1, 2, 2, 1, 1, 2, 2, 3, 3, 4, 4, 3, 3, 4, 4],
		);
	});

	it("nearest ignores alignCorners and handles non-integer scales", () => {
		const row = tensor([1, 2, 3, 4], [1, 1, 1, 4]);
		expectTensor(
			nn.interpolate(row, {
				size: [1, 2],
				mode: "nearest",
				alignCorners: true,
			}),
			[1, 1, 1, 2],
			[1, 3],
		);
		// 4 -> 6: floor(d * 4/6) = 0,0,1,2,2,3
		expectTensor(
			nn.interpolate(row, { size: [1, 6], mode: "nearest" }),
			[1, 1, 1, 6],
			[1, 1, 2, 3, 3, 4],
		);
	});

	it("bicubic same size is the identity (weights [0,1,0,0])", () => {
		const r = randomTensor(seededRandom(6), [1, 2, 3, 4]);
		expectTensor(
			nn.interpolate(r, { size: [3, 4], mode: "bicubic" }),
			[1, 2, 3, 4],
			values(r),
		);
	});

	it("bicubic A=-0.75 at t=0.25 on [0,1,2,3]", () => {
		// weights c2(1.25), c1(.25), c1(.75), c2(1.75) = [-0.10546875, 0.87890625, 0.26171875, -0.03515625]
		// (A=-0.75 is not linear-exact): 0.87890625 + 2*0.26171875 - 3*0.03515625 = 1.296875
		const ramp = tensor([0, 1, 2, 3], [1, 1, 1, 4]);
		// 4 -> 8: src = (d+.5)/2 - .5; d=3 -> 1.25, d=4 -> 1.75 (mirror weights): 1.703125
		const v = values(nn.interpolate(ramp, { size: [1, 8], mode: "bicubic" }));
		expect(v[3]).toBeCloseTo(1.296875, 6);
		expect(v[4]).toBeCloseTo(1.703125, 6);
	});

	it("bicubic weights at t=0.5 are [-0.09375, 0.59375, 0.59375, -0.09375]", () => {
		// 4 -> 2: src = 0.5 and 2.5; clamped edge index -1 -> 0
		const row = tensor([0, 1, 0, 0], [1, 1, 1, 4]);
		expectTensor(
			nn.interpolate(row, { size: [1, 2], mode: "bicubic" }),
			[1, 1, 1, 2],
			[0.59375, -0.09375],
		);
	});

	it("bicubic of a constant stays constant", () => {
		expectTensor(
			nn.interpolate(nn.full([1, 1, 2, 2], 3), {
				size: [5, 5],
				mode: "bicubic",
			}),
			[1, 1, 5, 5],
			new Array(25).fill(3),
		);
	});

	it("errors without size or scale, and for non-NCHW", () => {
		expect(() => nn.interpolate(x, { mode: "bilinear" })).toThrow();
		expect(() =>
			nn.interpolate(nn.zeros([2, 2]), { size: [4, 4], mode: "nearest" }),
		).toThrow();
	});
});

describe("gridSample", () => {
	const x = tensor([1, 2, 3, 4, 5, 6], [1, 1, 2, 3]);

	it("identity grid reproduces the input (align_corners true)", () => {
		const grid = tensor(
			[-1, -1, 0, -1, 1, -1, -1, 1, 0, 1, 1, 1],
			[1, 2, 3, 2],
		);
		expectTensor(
			nn.gridSample(x, grid, { alignCorners: true }),
			[1, 1, 2, 3],
			[1, 2, 3, 4, 5, 6],
		);
	});

	it("identity grid reproduces the input (align_corners false, pixel centres)", () => {
		// pixel centres: x = (2i+1)/3 - 1 = -2/3, 0, 2/3; y = -0.5, 0.5
		const gx = [-2 / 3, 0, 2 / 3];
		const gy = [-0.5, 0.5];
		const g: number[] = [];
		for (const y of gy) for (const xx of gx) g.push(xx, y);
		expectTensor(
			nn.gridSample(x, tensor(g, [1, 2, 3, 2])),
			[1, 1, 2, 3],
			[1, 2, 3, 4, 5, 6],
		);
	});

	it("bilinear midpoint (align_corners true): centre of [[1,2],[3,4]] = 2.5", () => {
		const x2 = tensor([1, 2, 3, 4], [1, 1, 2, 2]);
		expectTensor(
			nn.gridSample(x2, tensor([0, 0], [1, 1, 1, 2]), { alignCorners: true }),
			[1, 1, 1, 1],
			[2.5],
		);
	});

	it("zeros padding fades out; border padding clamps", () => {
		const x2 = tensor([1, 2, 3, 4], [1, 1, 2, 2]);
		// x = 1.5, y = -1 (align true): fx = 1.25, fy = 0 -> .75*2 + .25*0
		const g = tensor([1.5, -1], [1, 1, 1, 2]);
		expectTensor(
			nn.gridSample(x2, g, { alignCorners: true }),
			[1, 1, 1, 1],
			[1.5],
		);
		expectTensor(
			nn.gridSample(x2, g, { alignCorners: true, padding: "border" }),
			[1, 1, 1, 1],
			[2],
		);
		// fully outside -> 0
		expectTensor(
			nn.gridSample(x2, tensor([5, 5], [1, 1, 1, 2]), { alignCorners: true }),
			[1, 1, 1, 1],
			[0],
		);
	});

	it("nearest rounds to the closest pixel, ties to even", () => {
		const x2 = tensor([1, 2, 3, 4], [1, 1, 2, 2]);
		// x = 0.1 -> fx = .55 -> 1 ; y = -1 -> row 0 => 2
		expectTensor(
			nn.gridSample(x2, tensor([0.1, -1], [1, 1, 1, 2]), {
				mode: "nearest",
				alignCorners: true,
			}),
			[1, 1, 1, 1],
			[2],
		);
		// x = 0 -> fx = .5 -> tie -> 0 (even) => 1
		expectTensor(
			nn.gridSample(x2, tensor([0, -1], [1, 1, 1, 2]), {
				mode: "nearest",
				alignCorners: true,
			}),
			[1, 1, 1, 1],
			[1],
		);
	});

	it("samples every channel of every batch element", () => {
		const xb = tensor([1, 2, 3, 4, 10, 20, 30, 40], [2, 1, 2, 2]);
		const grid = tensor([-1, -1, 1, 1], [2, 1, 1, 2]);
		expectTensor(
			nn.gridSample(xb, grid, { alignCorners: true }),
			[2, 1, 1, 1],
			[1, 40],
		);
	});

	it("errors on bad grid shapes", () => {
		expect(() => nn.gridSample(x, nn.zeros([1, 1, 1, 3]))).toThrow();
		expect(() => nn.gridSample(x, nn.zeros([2, 1, 1, 2]))).toThrow();
		expect(() =>
			nn.gridSample(nn.zeros([2, 2]), nn.zeros([1, 1, 1, 2])),
		).toThrow();
	});
});
