// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { seededRandom } from "#/test/helpers";
import { dot, expectTensor, nn, randomTensor, tensor, values } from "./util";

describe("conv2d", () => {
	const ramp = tensor([1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 1, 3, 3]);

	it("2x2 kernel, no padding", () => {
		// out(i,j) = 1*x(i,j) + 2*x(i,j+1) + 3*x(i+1,j) + 4*x(i+1,j+1)
		// (0,0): 1+4+12+20 = 37, (0,1): 2+6+15+24 = 47, (1,0): 4+10+21+32 = 67, (1,1): 5+12+24+36 = 77
		const w = tensor([1, 2, 3, 4], [1, 1, 2, 2]);
		expectTensor(nn.conv2d(ramp, w), [1, 1, 2, 2], [37, 47, 67, 77]);
	});

	it("3x3 ones, padding 1, stride 2 samples the corners of the padded sums", () => {
		const w = tensor(new Array(9).fill(1), [1, 1, 3, 3]);
		// full padded output is [12,21,16,27,45,33,24,39,28]; stride 2 keeps (0,0) (0,2) (2,0) (2,2)
		expectTensor(
			nn.conv2d(ramp, w, null, { padding: 1, stride: 2 }),
			[1, 1, 2, 2],
			[12, 16, 24, 28],
		);
	});

	it("dilation 2 taps the four corners", () => {
		const w = tensor([1, 1, 1, 1], [1, 1, 2, 2]);
		// Ho = 3 - 2*1 - 1 + 1 = 1; taps (0,0) (0,2) (2,0) (2,2) = 1+3+7+9
		expectTensor(nn.conv2d(ramp, w, null, { dilation: 2 }), [1, 1, 1, 1], [20]);
	});

	it("pair options: asymmetric stride, padding", () => {
		const x = tensor([1, 2, 3, 4], [1, 1, 1, 4]);
		const w = tensor([1, 1, 1], [1, 1, 1, 3]);
		// padding (0,1): padded row [0,1,2,3,4,0], windows of 3 stride (1,2): 0+1+2, 2+3+4
		expectTensor(
			nn.conv2d(x, w, null, { padding: [0, 1], stride: [1, 2] }),
			[1, 1, 1, 2],
			[3, 9],
		);
	});

	it("multi-channel 1x1 with bias", () => {
		const x = tensor([1, 2, 3, 4], [1, 2, 1, 2]); // ch0 [1,2], ch1 [3,4]
		const w = tensor([1, 1, 1, -1], [2, 2, 1, 1]);
		const b = tensor([10, 20], [2]);
		// o0 = ch0+ch1 = [4,6]; o1 = ch0-ch1 = [-2,-2]
		expectTensor(nn.conv2d(x, w, b), [1, 2, 1, 2], [14, 16, 18, 18]);
	});

	it("batch dimension is independent", () => {
		const x = tensor([1, 2, 3, 4], [2, 1, 1, 2]);
		const w = tensor([2], [1, 1, 1, 1]);
		expectTensor(nn.conv2d(x, w), [2, 1, 1, 2], [2, 4, 6, 8]);
	});

	it("groups = 2 (depthwise 1x1)", () => {
		const x = tensor([1, 2, 3, 4], [1, 2, 1, 2]);
		const w = tensor([2, 3], [2, 1, 1, 1]);
		expectTensor(
			nn.conv2d(x, w, null, { groups: 2 }),
			[1, 2, 1, 2],
			[2, 4, 9, 12],
		);
	});

	it("groups equals split + separate convs + concat", () => {
		const rand = seededRandom(11);
		const x = randomTensor(rand, [2, 4, 5, 5]);
		const w = randomTensor(rand, [6, 2, 3, 3]);
		const b = randomTensor(rand, [6]);
		const opts = { padding: 1, stride: 1, groups: 2 };
		const grouped = nn.conv2d(x, w, b, opts);
		const xs = nn.split(x, 2, 1);
		const ws = nn.split(w, 2, 0);
		const bs = nn.split(b, 2, 0);
		const parts = xs.map((xi, i) =>
			nn.conv2d(xi, ws[i], bs[i], { padding: 1, stride: 1 }),
		);
		const ref = nn.concat(parts, 1);
		expectTensor(grouped, [2, 6, 5, 5], values(ref), 1e-6);
	});

	it("throws on channel / bias mismatch", () => {
		const x = tensor([1, 2, 3, 4], [1, 2, 1, 2]);
		expect(() => nn.conv2d(x, nn.zeros([1, 3, 1, 1]))).toThrow();
		expect(() => nn.conv2d(x, nn.zeros([2, 2, 1, 1]), nn.zeros([3]))).toThrow();
		expect(() => nn.conv2d(nn.zeros([2, 2]), nn.zeros([1, 1, 1, 1]))).toThrow();
		expect(() =>
			nn.conv2d(x, nn.zeros([3, 1, 1, 1]), null, { groups: 2 }),
		).toThrow();
	});
});

describe("convTranspose2d", () => {
	it("stride 1, 2x2 ones kernel: overlapping sums", () => {
		const x = tensor([1, 2, 3, 4], [1, 1, 2, 2]);
		const w = tensor([1, 1, 1, 1], [1, 1, 2, 2]);
		expectTensor(
			nn.convTranspose2d(x, w),
			[1, 1, 3, 3],
			[1, 3, 2, 4, 10, 6, 3, 7, 4],
		);
	});

	it("stride 2, kernel 2: tiles scaled kernels", () => {
		const x = tensor([1, 2, 3, 4], [1, 1, 2, 2]);
		const w = tensor([1, 2, 3, 4], [1, 1, 2, 2]);
		expectTensor(
			nn.convTranspose2d(x, w, null, { stride: 2 }),
			[1, 1, 4, 4],
			[1, 2, 2, 4, 3, 4, 6, 8, 3, 6, 4, 8, 9, 12, 12, 16],
		);
	});

	it("padding 1 with a 3x3 kernel on a single pixel keeps the centre tap", () => {
		const x = tensor([5], [1, 1, 1, 1]);
		const w = tensor([1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 1, 3, 3]);
		const b = tensor([1], [1]);
		// Ho = 0 - 2 + 2 + 1 = 1; 5 * w[1][1] + bias = 25 + 1
		expectTensor(
			nn.convTranspose2d(x, w, b, { padding: 1 }),
			[1, 1, 1, 1],
			[26],
		);
	});

	it("outputPadding adds trailing zeros", () => {
		const x = tensor([1, 2], [1, 1, 1, 2]);
		const w = tensor([3], [1, 1, 1, 1]);
		// Wo = (2-1)*2 + 0 + 1 + 1 = 4
		expectTensor(
			nn.convTranspose2d(x, w, null, { stride: [1, 2], outputPadding: [0, 1] }),
			[1, 1, 1, 4],
			[3, 0, 6, 0],
		);
	});

	it("groups: each input channel group maps to its own output group", () => {
		const x = tensor([1, 2], [1, 2, 1, 1]);
		const w = tensor([10, 20], [2, 1, 1, 1]);
		expectTensor(
			nn.convTranspose2d(x, w, null, { groups: 2 }),
			[1, 2, 1, 1],
			[10, 40],
		);
	});

	it("is the adjoint of conv2d: <conv(x), y> = <x, convT(y)>", () => {
		const rand = seededRandom(5);
		for (const cfg of [
			{
				shape: [1, 4, 5, 6],
				w: [2, 2, 3, 3],
				groups: 2,
				stride: 2,
				padding: 1,
				op: [0, 1],
			},
			{
				shape: [2, 3, 7, 7],
				w: [4, 3, 3, 3],
				groups: 1,
				stride: 1,
				padding: 2,
				op: [0, 0],
			},
			{
				shape: [1, 2, 6, 6],
				w: [2, 2, 2, 2],
				groups: 1,
				stride: 2,
				padding: 0,
				op: [0, 0],
			},
		]) {
			const x = randomTensor(rand, cfg.shape);
			const w = randomTensor(rand, cfg.w);
			const o = {
				groups: cfg.groups,
				stride: cfg.stride,
				padding: cfg.padding,
			};
			const cx = nn.conv2d(x, w, null, o);
			const y = randomTensor(rand, cx.shape);
			const ty = nn.convTranspose2d(y, w, null, {
				...o,
				outputPadding: cfg.op as [number, number],
			});
			expect([...ty.shape]).toEqual(cfg.shape);
			expect(dot(cx, y)).toBeCloseTo(dot(x, ty), 5);
		}
	});

	it("throws when the weight's Cin does not match", () => {
		expect(() =>
			nn.convTranspose2d(nn.zeros([1, 2, 2, 2]), nn.zeros([3, 1, 1, 1])),
		).toThrow();
	});
});

describe("deformConv2d", () => {
	it("fractional x offset samples bilinearly with zeros outside; mask scales", () => {
		const x = tensor([1, 2, 3, 4], [1, 1, 2, 2]);
		const w = tensor([1], [1, 1, 1, 1]);
		// offset channels: (dy, dx); dx = 0.5 everywhere
		const offset = tensor([0, 0, 0, 0, 0.5, 0.5, 0.5, 0.5], [1, 2, 2, 2]);
		// row0: x=0.5 -> 1.5; x=1.5 -> 0.5*2 + 0.5*0 = 1; row1: 3.5, 2
		expectTensor(
			nn.deformConv2d(x, offset, null, w),
			[1, 1, 2, 2],
			[1.5, 1, 3.5, 2],
		);
		const mask = tensor([0.5, 0.5, 0.5, 0.5], [1, 1, 2, 2]);
		expectTensor(
			nn.deformConv2d(x, offset, mask, w),
			[1, 1, 2, 2],
			[0.75, 0.5, 1.75, 1],
		);
	});

	it("zero offset and mask 1 equals conv2d (with groups, bias, stride)", () => {
		const rand = seededRandom(21);
		const x = randomTensor(rand, [1, 4, 5, 5]);
		const w = randomTensor(rand, [4, 2, 3, 3]);
		const b = randomTensor(rand, [4]);
		const o = { padding: 1, stride: 2, groups: 2 };
		const ref = nn.conv2d(x, w, b, o);
		const [, , Ho, Wo] = ref.shape;
		const offset = nn.zeros([1, 18, Ho, Wo]);
		const mask = nn.full([1, 9, Ho, Wo], 1);
		const got = nn.deformConv2d(x, offset, mask, w, b, o);
		expectTensor(got, ref.shape, values(ref), 1e-6);
		const noMask = nn.deformConv2d(x, offset, null, w, b, o);
		expectTensor(noMask, ref.shape, values(ref), 1e-6);
	});

	it("integer offset dx=+1 equals conv2d on the input shifted left (interior columns)", () => {
		const rand = seededRandom(33);
		const [H, W] = [4, 5];
		const x = randomTensor(rand, [1, 1, H, W]);
		const w = randomTensor(rand, [1, 1, 3, 3]);
		const xd = values(x);
		const shifted = new Float32Array(H * W);
		for (let y = 0; y < H; y++)
			for (let c = 0; c < W - 1; c++) shifted[y * W + c] = xd[y * W + c + 1];
		const ref = nn.conv2d(tensor(Array.from(shifted), [1, 1, H, W]), w, null, {
			padding: 1,
		});
		const od = new Array<number>(18 * H * W).fill(0);
		for (let k = 0; k < 9; k++)
			od.fill(1, (2 * k + 1) * H * W, (2 * k + 2) * H * W);
		const offset = tensor(od, [1, 18, H, W]);
		const got = nn.deformConv2d(x, offset, null, w, null, { padding: 1 });
		const g = values(got);
		const r = values(ref);
		for (let y = 0; y < H; y++)
			for (let c = 1; c < W - 1; c++)
				expect(g[y * W + c]).toBeCloseTo(r[y * W + c], 6);
	});

	it("throws on bad offset / mask shapes", () => {
		const x = nn.zeros([1, 1, 2, 2]);
		const w = nn.zeros([1, 1, 1, 1]);
		expect(() => nn.deformConv2d(x, nn.zeros([1, 4, 2, 2]), null, w)).toThrow();
		expect(() =>
			nn.deformConv2d(x, nn.zeros([1, 2, 2, 2]), nn.zeros([1, 2, 2, 2]), w),
		).toThrow();
	});
});

describe("linear and matmul", () => {
	it("linear over leading dims", () => {
		const x = tensor([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], [2, 2, 3]);
		const w = tensor([1, 0, 0, 0, 1, 0], [2, 3]); // picks features 0 and 1
		expectTensor(nn.linear(x, w), [2, 2, 2], [1, 2, 4, 5, 7, 8, 10, 11]);
	});

	it("linear errors", () => {
		expect(() => nn.linear(nn.zeros([2, 3]), nn.zeros([2, 4]))).toThrow();
		expect(() => nn.linear(nn.zeros([2, 3]), nn.zeros([3]))).toThrow();
		expect(() =>
			nn.linear(nn.zeros([2, 3]), nn.zeros([2, 3]), nn.zeros([3])),
		).toThrow();
	});

	it("matmul with a shared right-hand matrix", () => {
		const a = tensor([1, 2, 3, 4, 0, 1, 1, 0], [2, 2, 2]);
		const b = tensor([1, 2, 3, 4], [2, 2]);
		// a0 b = [[1+6, 2+8],[3+12, 6+16]]; a1 b = [[3,4],[1,2]]
		const expected = [7, 10, 15, 22, 3, 4, 1, 2];
		expectTensor(nn.matmul(a, b), [2, 2, 2], expected);
		// transposeB takes b as [N, K]
		expectTensor(
			nn.matmul(a, tensor([1, 3, 2, 4], [2, 2]), { transposeB: true }),
			[2, 2, 2],
			expected,
		);
	});

	it("matmul broadcasts batch dims on both sides", () => {
		const rand = seededRandom(2);
		const a = randomTensor(rand, [2, 1, 2, 3]);
		const b = randomTensor(rand, [3, 3, 4]);
		const c = nn.matmul(a, b);
		expect([...c.shape]).toEqual([2, 3, 2, 4]);
		const ad = values(a);
		const bd = values(b);
		const cd = values(c);
		for (let i = 0; i < 2; i++)
			for (let j = 0; j < 3; j++)
				for (let m = 0; m < 2; m++)
					for (let n = 0; n < 4; n++) {
						let s = 0;
						for (let k = 0; k < 3; k++)
							s += ad[(i * 2 + m) * 3 + k] * bd[(j * 3 + k) * 4 + n];
						expect(cd[((i * 3 + j) * 2 + m) * 4 + n]).toBeCloseTo(s, 6);
					}
	});

	it("matmul errors", () => {
		expect(() => nn.matmul(nn.zeros([2, 3]), nn.zeros([2, 3]))).toThrow();
		expect(() => nn.matmul(nn.zeros([3]), nn.zeros([3, 2]))).toThrow();
		expect(() => nn.matmul(nn.zeros([2, 2, 3]), nn.zeros([3, 3, 2]))).toThrow();
	});
});
