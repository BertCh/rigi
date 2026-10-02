// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { expectArrayClose, seededRandom } from "#/test/helpers";
import { expectTensor, nn, randomTensor, tensor, values } from "./util";

describe("softmax / logSoftmax", () => {
	it("last axis default", () => {
		// exp(0)=1, exp(ln3)=3 -> [0.25, 0.75]
		expectTensor(
			nn.softmax(tensor([0, Math.log(3)], [1, 2])),
			[1, 2],
			[0.25, 0.75],
		);
	});

	it("along axis 0 and negative axis", () => {
		const x = tensor([0, 0, Math.log(3), 0], [2, 2]);
		// column 0: [1, 3] -> [.25, .75]; column 1: [1, 1] -> [.5, .5]
		expectTensor(nn.softmax(x, 0), [2, 2], [0.25, 0.5, 0.75, 0.5]);
		expectTensor(nn.softmax(x, -2), [2, 2], [0.25, 0.5, 0.75, 0.5]);
	});

	it("is shift invariant and stable for large inputs", () => {
		expectTensor(
			nn.softmax(tensor([1000, 1000, 1000, 1000], [4])),
			[4],
			[0.25, 0.25, 0.25, 0.25],
		);
		expectTensor(
			nn.logSoftmax(tensor([1000, 1000], [2])),
			[2],
			[-Math.LN2, -Math.LN2],
		);
	});

	it("logSoftmax equals log of softmax; exp(logSoftmax) sums to 1", () => {
		const x = randomTensor(seededRandom(3), [2, 3, 4]);
		for (const axis of [0, 1, 2, -1]) {
			const sm = values(nn.softmax(x, axis));
			const ls = values(nn.logSoftmax(x, axis));
			expectArrayClose(ls.map(Math.exp), sm, 1e-6);
		}
		const rows = values(nn.softmax(x, 2));
		for (let r = 0; r < 6; r++) {
			let s = 0;
			for (let c = 0; c < 4; c++) s += rows[r * 4 + c];
			expect(s).toBeCloseTo(1, 6);
		}
	});

	it("handles -inf entries (masked logits)", () => {
		expectTensor(nn.softmax(tensor([0, -Infinity], [2])), [2], [1, 0]);
	});

	it("errors on a bad axis", () => {
		expect(() => nn.softmax(nn.zeros([2, 2]), 2)).toThrow();
		expect(() => nn.logSoftmax(nn.zeros([2, 2]), -3)).toThrow();
	});
});

describe("layerNorm", () => {
	it("normalises the last dim: x=[1,2,3,4] -> (x-2.5)/sqrt(1.25)", () => {
		// mean 2.5, var 1.25, std 1.1180340
		expectTensor(
			nn.layerNorm(tensor([1, 2, 3, 4], [1, 4]), null, null, 0),
			[1, 4],
			[-1.3416408, -0.4472136, 0.4472136, 1.3416408],
		);
	});

	it("weight and bias", () => {
		expectTensor(
			nn.layerNorm(
				tensor([1, 2, 3, 4], [4]),
				tensor([2, 2, 2, 2], [4]),
				tensor([1, 1, 1, 1], [4]),
				0,
			),
			[4],
			[-1.6832816, 0.1055728, 1.8944272, 3.6832816],
		);
	});

	it("default eps 1e-5 shifts a constant row to exactly 0 (bias passes through)", () => {
		expectTensor(
			nn.layerNorm(tensor([3, 3, 3], [3]), null, tensor([1, 2, 3], [3])),
			[3],
			[1, 2, 3],
		);
	});

	it("each row has mean 0 and variance ~1", () => {
		const x = randomTensor(seededRandom(8), [3, 2, 16]);
		const y = values(nn.layerNorm(x, null, null, 1e-9));
		for (let r = 0; r < 6; r++) {
			const row = y.slice(r * 16, (r + 1) * 16);
			const m = row.reduce((a, b) => a + b, 0) / 16;
			const v = row.reduce((a, b) => a + (b - m) ** 2, 0) / 16;
			expect(m).toBeCloseTo(0, 6);
			expect(v).toBeCloseTo(1, 5);
		}
	});

	it("errors on a wrong weight length", () => {
		expect(() => nn.layerNorm(nn.zeros([2, 4]), nn.zeros([3]))).toThrow();
		expect(() => nn.layerNorm(nn.zeros([2, 4]), null, nn.zeros([5]))).toThrow();
	});
});

describe("batchNorm", () => {
	it("inference batch norm over axis 1 (NCHW)", () => {
		const x = tensor([1, 3, 2, 6], [1, 2, 1, 2]);
		const mean = tensor([2, 4], [2]);
		const variance = tensor([1, 4], [2]);
		// ch0: (x-2)/1 = [-1, 1]; ch1: (x-4)/2 = [-1, 1]
		expectTensor(
			nn.batchNorm(x, mean, variance, null, null, 0),
			[1, 2, 1, 2],
			[-1, 1, -1, 1],
		);
		// w = [2, 3], b = [1, 0]: ch0 [-1, 3], ch1 [-3, 3]
		expectTensor(
			nn.batchNorm(
				x,
				mean,
				variance,
				tensor([2, 3], [2]),
				tensor([1, 0], [2]),
				0,
			),
			[1, 2, 1, 2],
			[-1, 3, -3, 3],
		);
	});

	it("NC input and eps", () => {
		const x = tensor([1, 2, 3, 6], [2, 2]);
		expectTensor(
			nn.batchNorm(x, tensor([2, 4], [2]), tensor([1, 4], [2]), null, null, 0),
			[2, 2],
			[-1, -1, 1, 1],
		);
		// eps 3 on var 1 -> sqrt(4) = 2: (1-2)/2
		expectTensor(
			nn.batchNorm(
				tensor([1, 2], [1, 2]),
				tensor([2, 2], [2]),
				tensor([1, 1], [2]),
				null,
				null,
				3,
			),
			[1, 2],
			[-0.5, 0],
		);
	});
});

describe("groupNorm", () => {
	it("two groups over four channels", () => {
		// group 0 = [1,3] -> [-1, 1]; group 1 = [2,6]: mean 4, std 2 -> [-1, 1]
		const x = tensor([1, 3, 2, 6], [1, 4, 1, 1]);
		expectTensor(
			nn.groupNorm(x, 2, null, null, 0),
			[1, 4, 1, 1],
			[-1, 1, -1, 1],
		);
	});

	it("per-channel weight and bias", () => {
		const x = tensor([1, 3, 2, 6], [1, 4, 1, 1]);
		expectTensor(
			nn.groupNorm(
				x,
				2,
				tensor([1, 2, 3, 4], [4]),
				tensor([0, 0, 1, 1], [4]),
				0,
			),
			[1, 4, 1, 1],
			[-1, 2, -2, 5],
		);
	});

	it("one group equals layerNorm over C*H*W", () => {
		const x = randomTensor(seededRandom(4), [2, 2, 2, 2]);
		const g = values(nn.groupNorm(x, 1, null, null, 1e-5));
		const l = values(nn.layerNorm(nn.reshape(x, [2, 8]), null, null, 1e-5));
		expectArrayClose(g, l, 1e-6);
	});

	it("G = C normalises each channel over space", () => {
		const x = tensor([1, 3, 10, 14], [1, 2, 1, 2]);
		expectTensor(
			nn.groupNorm(x, 2, null, null, 0),
			[1, 2, 1, 2],
			[-1, 1, -1, 1],
		);
	});

	it("errors when C is not divisible by groups", () => {
		expect(() => nn.groupNorm(nn.zeros([1, 3, 2, 2]), 2)).toThrow();
	});
});

describe("l2Normalize", () => {
	it("3-4-5 triple, default axis 1", () => {
		expectTensor(
			nn.l2Normalize(tensor([3, 4, 0, 5], [2, 2])),
			[2, 2],
			[0.6, 0.8, 0, 1],
		);
	});

	it("axis 0 and negative axis", () => {
		const x = tensor([3, 0, 4, 5], [2, 2]);
		expectTensor(nn.l2Normalize(x, 0), [2, 2], [0.6, 0, 0.8, 1]);
		expectTensor(nn.l2Normalize(x, -2), [2, 2], [0.6, 0, 0.8, 1]);
	});

	it("zero vector stays zero (divides by eps)", () => {
		expectTensor(nn.l2Normalize(tensor([0, 0], [1, 2])), [1, 2], [0, 0]);
	});

	it("eps floors the norm: ||x|| = 0.5 < eps 2 -> x / 2", () => {
		expectTensor(
			nn.l2Normalize(tensor([0.3, 0.4], [1, 2]), 1, 2),
			[1, 2],
			[0.15, 0.2],
		);
	});
});

describe("attention", () => {
	it("hand example, scale 1: softmax([1,0]) . [10,20]", () => {
		const q = tensor([1, 0], [1, 1, 1, 2]);
		const k = tensor([1, 0, 0, 1], [1, 1, 2, 2]);
		const v = tensor([10, 20], [1, 1, 2, 1]);
		// p = [e/(e+1), 1/(e+1)] = [0.7310586, 0.2689414]; out = 7.310586 + 5.378828
		expectTensor(
			nn.attention(q, k, v, { scale: 1 }),
			[1, 1, 1, 1],
			[12.689414],
		);
	});

	it("additive mask removes a key", () => {
		const q = tensor([1, 0], [1, 1, 1, 2]);
		const k = tensor([1, 0, 0, 1], [1, 1, 2, 2]);
		const v = tensor([10, 20], [1, 1, 2, 1]);
		const mask = tensor([0, -1e9], [1, 1, 1, 2]);
		expectTensor(nn.attention(q, k, v, { mask, scale: 1 }), [1, 1, 1, 1], [10]);
	});

	it("equals softmax(q kT * scale + mask) v from matmul/softmax", () => {
		const rand = seededRandom(17);
		const q = randomTensor(rand, [2, 2, 3, 4]);
		const k = randomTensor(rand, [2, 2, 5, 4]);
		const v = randomTensor(rand, [2, 2, 5, 3]);
		const mask = randomTensor(rand, [1, 1, 3, 5]); // broadcast over B and H
		for (const scale of [undefined, 0.3]) {
			const got = nn.attention(q, k, v, { mask, scale });
			const s = scale ?? 1 / Math.sqrt(4);
			const logits = nn.add(
				nn.scale(nn.matmul(q, k, { transposeB: true }), s),
				mask,
			);
			const ref = nn.matmul(nn.softmax(logits, -1), v);
			expectTensor(got, [2, 2, 3, 3], values(ref), 1e-6);
		}
	});

	it("errors on mismatched shapes", () => {
		const q = nn.zeros([1, 1, 2, 4]);
		expect(() =>
			nn.attention(q, nn.zeros([1, 1, 3, 5]), nn.zeros([1, 1, 3, 2])),
		).toThrow();
		expect(() =>
			nn.attention(q, nn.zeros([1, 1, 3, 4]), nn.zeros([1, 1, 4, 2])),
		).toThrow();
		expect(() =>
			nn.attention(nn.zeros([2, 4]), nn.zeros([3, 4]), nn.zeros([3, 2])),
		).toThrow();
		expect(() =>
			nn.attention(q, nn.zeros([1, 1, 3, 4]), nn.zeros([1, 1, 3, 2]), {
				mask: nn.zeros([3, 3]),
			}),
		).toThrow();
	});
});

describe("rotaryEmbed", () => {
	const x = tensor([1, 2, 3, 4], [1, 1, 1, 4]);
	const ones = nn.full([4], 1);
	const zeros = nn.zeros([4]);

	it("cos=1, sin=0 is the identity (both layouts)", () => {
		expectTensor(nn.rotaryEmbed(x, ones, zeros), [1, 1, 1, 4], [1, 2, 3, 4]);
		expectTensor(
			nn.rotaryEmbed(x, ones, zeros, { interleaved: false }),
			[1, 1, 1, 4],
			[1, 2, 3, 4],
		);
	});

	it("interleaved 90 degrees maps pairs (a,b) -> (-b,a)", () => {
		expectTensor(nn.rotaryEmbed(x, zeros, ones), [1, 1, 1, 4], [-2, 1, -4, 3]);
	});

	it("half layout 90 degrees: rotate_half = [-x2, x1]", () => {
		expectTensor(
			nn.rotaryEmbed(x, zeros, ones, { interleaved: false }),
			[1, 1, 1, 4],
			[-3, -4, 1, 2],
		);
	});

	it("general cos/sin, per-dim broadcast", () => {
		// x*0.5 = [.5,1,1.5,2]; rot*2 = [-4,2,-8,6]
		expectTensor(
			nn.rotaryEmbed(x, nn.full([4], 0.5), nn.full([4], 2)),
			[1, 1, 1, 4],
			[-3.5, 3, -6.5, 8],
		);
		// per-dim cos varies: cos=[1,2,3,4], sin=0 -> x*cos
		expectTensor(
			nn.rotaryEmbed(x, tensor([1, 2, 3, 4], [4]), zeros),
			[1, 1, 1, 4],
			[1, 4, 9, 16],
		);
	});

	it("preserves the norm of each pair for cos^2+sin^2=1", () => {
		const c = Math.cos(0.7);
		const s = Math.sin(0.7);
		const y = values(nn.rotaryEmbed(x, nn.full([4], c), nn.full([4], s)));
		expect(y[0] ** 2 + y[1] ** 2).toBeCloseTo(5, 5);
		expect(y[2] ** 2 + y[3] ** 2).toBeCloseTo(25, 5);
	});

	it("errors: odd D, cos not broadcastable", () => {
		expect(() =>
			nn.rotaryEmbed(nn.zeros([3]), nn.zeros([3]), nn.zeros([3])),
		).toThrow();
		expect(() => nn.rotaryEmbed(x, nn.zeros([5]), zeros)).toThrow();
		expect(() => nn.rotaryEmbed(x, ones, nn.zeros([2, 4]))).toThrow();
	});
});
