// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { expectTensor, nn, tensor, values } from "./util";

describe("binary ops", () => {
	const a = tensor([1, 2, 3, 4, 5, 6], [2, 3]);

	it("add/sub/mul/div with equal shapes", () => {
		const b = tensor([6, 5, 4, 3, 2, 1], [2, 3]);
		expectTensor(nn.add(a, b), [2, 3], [7, 7, 7, 7, 7, 7]);
		expectTensor(nn.sub(a, b), [2, 3], [-5, -3, -1, 1, 3, 5]);
		expectTensor(nn.mul(a, b), [2, 3], [6, 10, 12, 12, 10, 6]);
		expectTensor(
			nn.div(a, tensor([1, 2, 3, 8, 10, 12], [2, 3])),
			[2, 3],
			[1, 1, 1, 0.5, 0.5, 0.5],
		);
	});

	it("broadcasts [2,1] with [1,3] and a rank-1 operand", () => {
		expectTensor(
			nn.add(tensor([10, 20], [2, 1]), tensor([1, 2, 3], [1, 3])),
			[2, 3],
			[11, 12, 13, 21, 22, 23],
		);
		expectTensor(
			nn.mul(a, tensor([1, 0, -1], [3])),
			[2, 3],
			[1, 0, -3, 4, 0, -6],
		);
		expectTensor(
			nn.sub(tensor([1, 2, 3], [3]), tensor([1, 2], [2, 1])),
			[2, 3],
			[0, 1, 2, -1, 0, 1],
		);
	});

	it("scalars on either side keep operand order", () => {
		expectTensor(nn.sub(10, a), [2, 3], [9, 8, 7, 6, 5, 4]);
		expectTensor(nn.sub(a, 10), [2, 3], [-9, -8, -7, -6, -5, -4]);
		expectTensor(nn.div(12, a), [2, 3], [12, 6, 4, 3, 2.4, 2]);
		expectTensor(nn.div(a, 2), [2, 3], [0.5, 1, 1.5, 2, 2.5, 3]);
	});

	it("pow", () => {
		expectTensor(nn.binary("pow", tensor([2, 3, 4], [3]), 2), [3], [4, 9, 16]);
		expectTensor(nn.binary("pow", 2, tensor([0, 1, 3], [3])), [3], [1, 2, 8]);
	});

	it("maximum / minimum with tensors and scalars", () => {
		const x = tensor([-1, 0, 5, 2], [4]);
		expectTensor(nn.maximum(x, 1), [4], [1, 1, 5, 2]);
		expectTensor(nn.maximum(1, x), [4], [1, 1, 5, 2]);
		expectTensor(nn.minimum(x, 1), [4], [-1, 0, 1, 1]);
		expectTensor(nn.minimum(1, x), [4], [-1, 0, 1, 1]);
		expectTensor(nn.maximum(x, tensor([0, 0, 9, 1], [4])), [4], [0, 0, 9, 2]);
		expectTensor(nn.minimum(x, tensor([0, 0, 9, 1], [4])), [4], [-1, 0, 5, 1]);
	});

	it("max / min propagate NaN like torch", () => {
		const x = tensor([Number.NaN, 1], [2]);
		const r1 = nn.maximum(x, 0);
		const r2 = nn.maximum(0, x);
		expect(Number.isNaN(values(r1)[0])).toBe(true);
		expect(values(r1)[1]).toBe(1);
		expect(Number.isNaN(values(r2)[0])).toBe(true);
	});

	it("compare gives 0 / 1 for every operator, scalar on either side", () => {
		const x = tensor([1, 2, 3], [3]);
		expectTensor(nn.compare("eq", x, 2), [3], [0, 1, 0]);
		expectTensor(nn.compare("ne", x, 2), [3], [1, 0, 1]);
		expectTensor(nn.compare("gt", x, 2), [3], [0, 0, 1]);
		expectTensor(nn.compare("ge", x, 2), [3], [0, 1, 1]);
		expectTensor(nn.compare("lt", x, 2), [3], [1, 0, 0]);
		expectTensor(nn.compare("le", x, 2), [3], [1, 1, 0]);
		// scalar on the left flips the sense
		expectTensor(nn.compare("gt", 2, x), [3], [1, 0, 0]);
		expectTensor(nn.compare("le", 2, x), [3], [0, 1, 1]);
		// broadcast compare
		expectTensor(
			nn.compare("lt", tensor([1, 2], [2, 1]), tensor([1, 2, 3], [1, 3])),
			[2, 3],
			[0, 1, 1, 0, 0, 1],
		);
	});

	it("where selects by cond != 0, with scalar branches and broadcasting", () => {
		const cond = tensor([1, 0, 2, 0], [4]);
		expectTensor(
			nn.where(cond, tensor([1, 2, 3, 4], [4]), tensor([10, 20, 30, 40], [4])),
			[4],
			[1, 20, 3, 40],
		);
		expectTensor(nn.where(cond, 7, 0), [4], [7, 0, 7, 0]);
		expectTensor(
			nn.where(cond, tensor([1, 2, 3, 4], [4]), -1),
			[4],
			[1, -1, 3, -1],
		);
		expectTensor(
			nn.where(cond, -1, tensor([1, 2, 3, 4], [4])),
			[4],
			[-1, 2, -1, 4],
		);
		expectTensor(
			nn.where(tensor([1, 0], [2, 1]), tensor([1, 2, 3], [3]), 0),
			[2, 3],
			[1, 2, 3, 0, 0, 0],
		);
	});

	it("errors: incompatible shapes, two scalars", () => {
		expect(() => nn.add(tensor([1, 2, 3], [3]), tensor([1, 2], [2]))).toThrow();
		expect(() =>
			nn.compare("eq", nn.zeros([2, 3]), nn.zeros([3, 2])),
		).toThrow();
		expect(() => nn.add(1, 2)).toThrow();
		expect(() => nn.where(nn.zeros([2]), nn.zeros([3]), 0)).toThrow();
	});
});

describe("unary ops", () => {
	const un = (
		op: Parameters<typeof nn.unary>[0],
		xs: number[],
		expected: number[],
		tol = 1e-6,
	) =>
		expectTensor(
			nn.unary(op, tensor(xs, [xs.length])),
			[xs.length],
			expected,
			tol,
		);

	it("relu", () => {
		un("relu", [-2, 0, 3], [0, 0, 3]);
		expectTensor(nn.relu(tensor([-1, 1], [2])), [2], [0, 1]);
	});

	it("gelu (erf): gelu(1) = 0.8413447", () => {
		un("gelu", [0, 1, -1, 2], [0, 0.8413447, -0.1586553, 1.9544997]);
		expectTensor(nn.gelu(tensor([1], [1])), [1], [0.8413447]);
	});

	it("geluTanh: gelu(1) ~ 0.8411920 and approximate option", () => {
		un("geluTanh", [0, 1, -1], [0, 0.841192, -0.158808]);
		expectTensor(
			nn.gelu(tensor([1], [1]), { approximate: "tanh" }),
			[1],
			[0.841192],
		);
	});

	it("silu / sigmoid / tanh", () => {
		un("silu", [0, 1, -1], [0, 0.7310586, -0.2689414]);
		un("sigmoid", [0, 1, -1], [0.5, 0.7310586, 0.2689414]);
		un("tanh", [0, 1, -1], [0, 0.7615942, -0.7615942]);
		expectTensor(nn.silu(tensor([1], [1])), [1], [0.7310586]);
		expectTensor(nn.sigmoid(tensor([1], [1])), [1], [0.7310586]);
		expectTensor(nn.tanh(tensor([1], [1])), [1], [0.7615942]);
	});

	it("elu: alpha 1 default, custom alpha", () => {
		// e^-1 - 1 = -0.6321206
		un("elu", [2, -1], [2, -0.6321206]);
		expectTensor(nn.elu(tensor([2, -1], [2])), [2], [2, -0.6321206]);
		expectTensor(nn.elu(tensor([2, -1], [2]), 2), [2], [2, -1.2642411]);
	});

	it("selu: scale 1.0507010, alpha 1.6732632", () => {
		// selu(1) = 1.0507010; selu(-1) = 1.0507010 * 1.6732632 * (e^-1 - 1) = -1.1113307
		un("selu", [1, -1, 0], [1.050701, -1.1113307, 0]);
		expectTensor(nn.selu(tensor([1], [1])), [1], [1.050701]);
	});

	it("leakyRelu: default slope 0.01 and custom", () => {
		expectTensor(nn.leakyRelu(tensor([-2, 3], [2])), [2], [-0.02, 3]);
		expectTensor(nn.leakyRelu(tensor([-2, 3], [2]), 0.2), [2], [-0.4, 3]);
	});

	it("softplus and logSigmoid", () => {
		// softplus(x) = ln(1+e^x); logSigmoid(x) = -softplus(-x)
		un("softplus", [0, 1, -1, 30], [Math.LN2, 1.3132617, 0.3132617, 30]);
		un("logSigmoid", [0, 1, -1, -30], [-Math.LN2, -0.3132617, -1.3132617, -30]);
	});

	it("exp / log / sqrt / rsqrt / abs / neg / square / recip", () => {
		un("exp", [0, 1], [1, Math.E]);
		un("log", [1, Math.E], [0, 1]);
		un("sqrt", [4, 9], [2, 3]);
		un("rsqrt", [4, 16], [0.5, 0.25]);
		un("abs", [-3, 2], [3, 2]);
		un("neg", [-3, 2], [3, -2]);
		un("square", [-3, 0.5], [9, 0.25]);
		un("recip", [4, -0.5], [0.25, -2]);
	});

	it("floor and round (half to even)", () => {
		un("floor", [-1.5, 1.5, 2], [-2, 1, 2]);
		un(
			"round",
			[0.5, 1.5, 2.5, -0.5, -1.5, -2.5, 1.4],
			[0, 2, 2, 0, -2, -2, 1],
		);
	});

	it("clamp and scale", () => {
		expectTensor(
			nn.clamp(tensor([-5, 0, 5, 1], [4]), -1, 2),
			[4],
			[-1, 0, 2, 1],
		);
		expectTensor(nn.scale(tensor([1, -2], [2]), 3), [2], [3, -6]);
	});

	it("preserves shape", () => {
		expect([...nn.relu(nn.zeros([2, 3, 4])).shape]).toEqual([2, 3, 4]);
	});
});
