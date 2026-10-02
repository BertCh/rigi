// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The CPU fast paths (tiled conv, same-shape binary, relu, resize, pooling) against the naive loops.

import { describe, expect, it } from "vitest";
import { seededRandom } from "#/test/helpers";
import { CpuNn, type CpuTensor } from "../cpu";
import { conv2dFast, conv2dReference } from "../cpu-conv";
import { convParams } from "../shape";
import type { Tensor } from "../types";

const rand = seededRandom(7);
const random = (n: number) =>
	Float32Array.from({ length: n }, () => rand() * 2 - 1);

type Case = {
	name: string;
	x: number[];
	w: number[];
	o: Parameters<typeof convParams>[2];
};
const CASES: Case[] = [
	{ name: "3x3 pad 1", x: [1, 5, 9, 11], w: [6, 5, 3, 3], o: { padding: 1 } },
	{
		name: "3x3 dilation 4, width tail",
		x: [1, 4, 12, 10],
		w: [8, 4, 3, 3],
		o: { padding: 4, dilation: 4 },
	},
	{
		name: "stride 2, cout tail",
		x: [2, 3, 16, 13],
		w: [7, 3, 3, 3],
		o: { padding: 1, stride: 2 },
	},
	{ name: "1x1", x: [1, 9, 6, 7], w: [5, 9, 1, 1], o: {} },
	{
		name: "7x7 stride 2 pad 3",
		x: [1, 3, 20, 21],
		w: [4, 3, 7, 7],
		o: { padding: 3, stride: 2 },
	},
	{
		name: "groups 2",
		x: [1, 8, 9, 9],
		w: [6, 4, 3, 3],
		o: { padding: 1, groups: 2 },
	},
	{
		name: "depthwise",
		x: [1, 6, 10, 9],
		w: [6, 1, 3, 3],
		o: { padding: 1, groups: 6 },
	},
	{
		name: "one output channel",
		x: [1, 12, 5, 19],
		w: [1, 12, 3, 3],
		o: { padding: 1 },
	},
	{
		name: "asymmetric",
		x: [1, 3, 8, 14],
		w: [5, 3, 1, 3],
		o: { padding: [0, 1], stride: [1, 2] },
	},
];

describe("conv2dFast", () => {
	for (const c of CASES)
		it(`matches the reference: ${c.name}`, () => {
			const p = convParams(c.x, c.w, c.o);
			const n = (s: number[]) => s.reduce((a, b) => a * b, 1);
			const X = random(n(c.x));
			const W = random(n(c.w));
			const b = random(p.Cout);
			for (const bias of [b, null]) {
				const ref = conv2dReference(X, W, bias, p);
				const got = conv2dFast(X, W, bias, p);
				expect(got.length).toBe(ref.length);
				let peak = 0;
				let err = 0;
				for (let i = 0; i < ref.length; i++) {
					peak = Math.max(peak, Math.abs(ref[i]));
					err = Math.max(err, Math.abs(ref[i] - got[i]));
				}
				expect(err / peak).toBeLessThanOrEqual(1e-5);
			}
		});

	it("reuses packed weights across calls (same results twice)", () => {
		const p = convParams([1, 4, 8, 8], [8, 4, 3, 3], { padding: 1 });
		const X = random(4 * 64);
		const W = random(8 * 4 * 9);
		expect(conv2dFast(X, W, null, p)).toEqual(conv2dFast(X, W, null, p));
	});
});

describe("CpuNn fast paths are identical to the naive ops", () => {
	const fast = new CpuNn();
	const slow = new CpuNn();
	slow.fastConv = false;
	const both = (shape: number[], f: (nn: CpuNn, x: Tensor) => Tensor) => {
		const data = random(shape.reduce((a, b) => a * b, 1));
		const a = (f(fast, fast.fromArray(data, shape)) as CpuTensor).data;
		const b = (f(slow, slow.fromArray(data, shape)) as CpuTensor).data;
		expect(a.length).toBe(b.length);
		expect(Array.from(a)).toEqual(Array.from(b));
	};

	it("relu", () => both([1, 3, 5, 7], (nn, x) => nn.relu(x)));
	it("add / sub / mul, same shape", () => {
		for (const op of ["add", "sub", "mul"] as const)
			both([2, 3, 4, 5], (nn, x) => nn[op](x, nn.relu(x)));
	});
	it("bilinear resize up and down", () => {
		both([1, 2, 6, 9], (nn, x) =>
			nn.interpolate(x, {
				size: [13, 20],
				mode: "bilinear",
				alignCorners: false,
			}),
		);
		both([1, 2, 12, 9], (nn, x) =>
			nn.interpolate(x, { size: [5, 4], mode: "bilinear", alignCorners: true }),
		);
	});
	it("nearest resize", () =>
		both([1, 2, 5, 4], (nn, x) =>
			nn.interpolate(x, { size: [11, 8], mode: "nearest" }),
		));
	it("2x2 max pool, floor and ceil", () => {
		both([1, 3, 8, 8], (nn, x) =>
			nn.maxPool2d(x, { kernel: 2, stride: 2, ceilMode: false }),
		);
		both([1, 3, 7, 9], (nn, x) =>
			nn.maxPool2d(x, { kernel: 2, stride: 2, ceilMode: true }),
		);
		both([1, 2, 9, 9], (nn, x) =>
			nn.maxPool2d(x, { kernel: 3, stride: 1, padding: 1 }),
		);
	});
});
