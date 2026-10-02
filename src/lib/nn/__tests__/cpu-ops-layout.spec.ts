// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import type { Nn } from "../types";
import { expectTensor, nn, tensor, values } from "./util";

describe("creation and plumbing", () => {
	it("zeros / full / fromArray", () => {
		expectTensor(nn.zeros([2, 2]), [2, 2], [0, 0, 0, 0]);
		expectTensor(nn.full([3], 2.5), [3], [2.5, 2.5, 2.5]);
		const t = nn.fromArray(new Float32Array([1, 2, 3]), [3]);
		expect(t.dtype).toBe("f32");
		expect(() => nn.fromArray([1, 2, 3], [2, 2])).toThrow();
	});

	it("fromArray copies its input", () => {
		const src = new Float32Array([1, 2]);
		const t = nn.fromArray(src, [2]);
		src[0] = 99;
		expect(values(t)).toEqual([1, 2]);
	});

	it("read returns a copy", async () => {
		const t = tensor([1, 2], [2]);
		(await nn.read(t))[0] = 99;
		expect(values(t)).toEqual([1, 2]);
	});

	it("forward runs eagerly and returns the callback result; dispose is a no-op", async () => {
		const r = await nn.forward(() => nn.add(tensor([1], [1]), 1));
		expect(values(r)).toEqual([2]);
		expect(() => (nn as Nn).dispose(r)).not.toThrow();
		expect(() => (nn as Nn).dispose([r])).not.toThrow();
	});
});

describe("reshape / permute / transpose", () => {
	const m = tensor([1, 2, 3, 4, 5, 6], [2, 3]);

	it("reshape with -1", () => {
		expectTensor(nn.reshape(m, [3, -1]), [3, 2], [1, 2, 3, 4, 5, 6]);
		expectTensor(nn.reshape(m, [-1]), [6], [1, 2, 3, 4, 5, 6]);
		expectTensor(nn.reshape(m, [1, -1, 3]), [1, 2, 3], [1, 2, 3, 4, 5, 6]);
	});

	it("reshape errors on a size mismatch", () => {
		expect(() => nn.reshape(m, [4, 2])).toThrow();
		expect(() => nn.reshape(m, [4, -1])).toThrow();
	});

	it("permute 2-D is a transpose", () => {
		expectTensor(nn.permute(m, [1, 0]), [3, 2], [1, 4, 2, 5, 3, 6]);
		expectTensor(nn.permute(m, [0, 1]), [2, 3], [1, 2, 3, 4, 5, 6]);
	});

	it("permute 3-D: out[i][j][k] = x[j][k][i]", () => {
		const x = tensor([0, 1, 2, 3, 4, 5, 6, 7], [2, 2, 2]);
		expectTensor(nn.permute(x, [2, 0, 1]), [2, 2, 2], [0, 2, 4, 6, 1, 3, 5, 7]);
		expectTensor(
			nn.permute(x, [-1, 0, 1]),
			[2, 2, 2],
			[0, 2, 4, 6, 1, 3, 5, 7],
		);
	});

	it("permute changes the shape for non-cubic tensors", () => {
		const x = tensor(
			Array.from({ length: 24 }, (_, i) => i),
			[2, 3, 4],
		);
		const y = nn.permute(x, [1, 2, 0]);
		expect([...y.shape]).toEqual([3, 4, 2]);
		// y[j][k][i] = x[i][j][k]: y[1][2][1] = x[1][1][2] = 12 + 4 + 2 = 18
		expect(values(y)[(1 * 4 + 2) * 2 + 1]).toBe(18);
	});

	it("permute errors", () => {
		expect(() => nn.permute(m, [0])).toThrow();
		expect(() => nn.permute(m, [0, 0])).toThrow();
		expect(() => nn.permute(m, [0, 2])).toThrow();
	});

	it("transpose swaps two axes (negative ok, identical axes = identity)", () => {
		expectTensor(nn.transpose(m, 0, 1), [3, 2], [1, 4, 2, 5, 3, 6]);
		expectTensor(nn.transpose(m, -1, -2), [3, 2], [1, 4, 2, 5, 3, 6]);
		expectTensor(nn.transpose(m, 1, 1), [2, 3], [1, 2, 3, 4, 5, 6]);
		const x = tensor([0, 1, 2, 3, 4, 5, 6, 7], [2, 2, 2]);
		// swap axes 0 and 2: out[i][j][k] = x[k][j][i]
		expectTensor(nn.transpose(x, 0, 2), [2, 2, 2], [0, 4, 2, 6, 1, 5, 3, 7]);
	});
});

describe("slice / split / concat", () => {
	const v = tensor([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [10]);

	it("slice with start, end, step", () => {
		expectTensor(nn.slice(v, 0, 2, 8, 3), [2], [2, 5]);
		expectTensor(nn.slice(v, 0, 2, 5), [3], [2, 3, 4]);
		expectTensor(nn.slice(v, 0, 7), [3], [7, 8, 9]);
		expectTensor(nn.slice(v, 0, 0, 10, 4), [3], [0, 4, 8]);
	});

	it("slice with negative indices", () => {
		expectTensor(nn.slice(v, 0, -3), [3], [7, 8, 9]);
		expectTensor(nn.slice(v, 0, 0, -1), [9], [0, 1, 2, 3, 4, 5, 6, 7, 8]);
		expectTensor(nn.slice(v, 0, -4, -1), [3], [6, 7, 8]);
		expectTensor(nn.slice(v, -1, -9, -1, 2), [4], [1, 3, 5, 7]);
	});

	it("slice clamps out-of-range bounds and can be empty", () => {
		expectTensor(nn.slice(v, 0, 5, 100), [5], [5, 6, 7, 8, 9]);
		expectTensor(nn.slice(v, 0, -100, 2), [2], [0, 1]);
		expect([...nn.slice(v, 0, 6, 3).shape]).toEqual([0]);
	});

	it("slice along an inner axis with a step", () => {
		const x = tensor([0, 1, 2, 3, 4, 5, 6, 7], [2, 4]);
		expectTensor(nn.slice(x, 1, 1, undefined, 2), [2, 2], [1, 3, 5, 7]);
		expectTensor(nn.slice(x, 0, 1, 2), [1, 4], [4, 5, 6, 7]);
	});

	it("slice errors on step < 1 and bad axis", () => {
		expect(() => nn.slice(v, 0, 0, 5, 0)).toThrow();
		expect(() => nn.slice(v, 1, 0, 1)).toThrow();
	});

	it("split into equal chunks", () => {
		const parts = nn.split(tensor([1, 2, 3, 4, 5, 6], [6]), 3, 0);
		expect(parts.map(values)).toEqual([
			[1, 2],
			[3, 4],
			[5, 6],
		]);
	});

	it("split chunk count follows torch.chunk for uneven sizes", () => {
		// chunk(6, 4): ceil(6/4)=2 -> three chunks of 2; chunk(5, 2): [3, 2]
		const six = nn.split(tensor([1, 2, 3, 4, 5, 6], [6]), 4, 0);
		expect(six.map((t) => t.shape[0])).toEqual([2, 2, 2]);
		const five = nn.split(tensor([1, 2, 3, 4, 5], [5]), 2, 0);
		expect(five.map(values)).toEqual([
			[1, 2, 3],
			[4, 5],
		]);
	});

	it("split with explicit sizes, on a negative axis", () => {
		const x = tensor([1, 2, 3, 4, 5, 6], [2, 3]);
		const [a, b] = nn.split(x, [1, 2], -1);
		expectTensor(a, [2, 1], [1, 4]);
		expectTensor(b, [2, 2], [2, 3, 5, 6]);
	});

	it("split errors when sizes do not add up", () => {
		expect(() => nn.split(tensor([1, 2, 3], [3]), [1, 1], 0)).toThrow();
	});

	it("concat along each axis", () => {
		const a = tensor([1, 2, 3, 4], [2, 2]);
		const b = tensor([5, 6], [1, 2]);
		expectTensor(nn.concat([a, b], 0), [3, 2], [1, 2, 3, 4, 5, 6]);
		const c = tensor([7, 8], [2, 1]);
		expectTensor(nn.concat([a, c], 1), [2, 3], [1, 2, 7, 3, 4, 8]);
		expectTensor(nn.concat([a, c], -1), [2, 3], [1, 2, 7, 3, 4, 8]);
		expectTensor(nn.concat([a], 0), [2, 2], [1, 2, 3, 4]);
	});

	it("concat is the inverse of split", () => {
		const x = tensor(
			Array.from({ length: 12 }, (_, i) => i),
			[2, 6],
		);
		expectTensor(nn.concat(nn.split(x, 3, 1), 1), [2, 6], values(x));
	});

	it("concat errors", () => {
		expect(() => nn.concat([], 0)).toThrow();
		expect(() => nn.concat([nn.zeros([2, 2]), nn.zeros([3, 2])], 1)).toThrow();
		expect(() => nn.concat([nn.zeros([2, 2]), nn.zeros([2])], 0)).toThrow();
	});
});

describe("gather / pad / expand", () => {
	const x = tensor([1, 2, 3, 4, 5, 6], [3, 2]);

	it("gather along axis 0 and 1", () => {
		expectTensor(nn.gather(x, tensor([2, 0], [2]), 0), [2, 2], [5, 6, 1, 2]);
		expectTensor(
			nn.gather(x, tensor([1, 1, 0], [3]), 1),
			[3, 3],
			[2, 2, 1, 4, 4, 3, 6, 6, 5],
		);
	});

	it("gather accepts negative indices and multi-dim index tensors", () => {
		expectTensor(nn.gather(x, tensor([-1], [1]), 0), [1, 2], [5, 6]);
		// out shape = x.shape[:1] + idx.shape = [3, 2, 2]
		expectTensor(
			nn.gather(x, tensor([0, 1, 1, 0], [2, 2]), 1),
			[3, 2, 2],
			[1, 2, 2, 1, 3, 4, 4, 3, 5, 6, 6, 5],
		);
	});

	it("gather errors on an out-of-range index", () => {
		expect(() => nn.gather(x, tensor([3], [1]), 0)).toThrow();
		expect(() => nn.gather(x, tensor([-4], [1]), 0)).toThrow();
	});

	it("pad constant, F.pad order (last dim first)", () => {
		expectTensor(
			nn.pad(tensor([1, 2, 3], [3]), [1, 2], { value: 9 }),
			[6],
			[9, 1, 2, 3, 9, 9],
		);
		const m = tensor([1, 2, 3, 4], [2, 2]);
		// [left 1, right 0, top 0, bottom 1]
		expectTensor(nn.pad(m, [1, 0, 0, 1]), [3, 3], [0, 1, 2, 0, 3, 4, 0, 0, 0]);
		// [left 0, right 0, top 1, bottom 0]
		expectTensor(nn.pad(m, [0, 0, 1, 0]), [3, 2], [0, 0, 1, 2, 3, 4]);
	});

	it("pad reflect (edge not repeated)", () => {
		expectTensor(
			nn.pad(tensor([1, 2, 3, 4], [4]), [2, 1], { mode: "reflect" }),
			[7],
			[3, 2, 1, 2, 3, 4, 3],
		);
		expectTensor(
			nn.pad(tensor([1, 2, 3, 4], [2, 2]), [1, 1, 1, 1], { mode: "reflect" }),
			[4, 4],
			[4, 3, 4, 3, 2, 1, 2, 1, 4, 3, 4, 3, 2, 1, 2, 1],
		);
	});

	it("pad replicate (edge repeated)", () => {
		expectTensor(
			nn.pad(tensor([1, 2, 3, 4], [4]), [2, 2], { mode: "replicate" }),
			[8],
			[1, 1, 1, 2, 3, 4, 4, 4],
		);
		expectTensor(
			nn.pad(tensor([1, 2, 3, 4], [2, 2]), [1, 0, 0, 1], { mode: "replicate" }),
			[3, 3],
			[1, 1, 2, 3, 3, 4, 3, 3, 4],
		);
	});

	it("pad errors", () => {
		expect(() => nn.pad(x, [1])).toThrow();
		expect(() => nn.pad(x, [1, 1, 1, 1, 1, 1])).toThrow();
		expect(() =>
			nn.pad(tensor([1, 2], [2]), [2, 0], { mode: "reflect" }),
		).toThrow();
		expect(() => nn.pad(x, [-1, 0])).toThrow();
	});

	it("expand materialises the broadcast", () => {
		expectTensor(
			nn.expand(tensor([1, 2, 3], [3, 1]), [3, 2]),
			[3, 2],
			[1, 1, 2, 2, 3, 3],
		);
		expectTensor(
			nn.expand(tensor([1, 2], [1, 2]), [2, 2]),
			[2, 2],
			[1, 2, 1, 2],
		);
		expectTensor(
			nn.expand(tensor([1, 2], [2]), [3, 2]),
			[3, 2],
			[1, 2, 1, 2, 1, 2],
		);
		expectTensor(nn.expand(tensor([1, 2], [2]), [2]), [2], [1, 2]);
	});

	it("expand errors", () => {
		expect(() => nn.expand(tensor([1, 2], [2]), [3])).toThrow();
		expect(() => nn.expand(tensor([1, 2], [2]), [1])).toThrow();
	});
});

describe("reductions", () => {
	const m = tensor([1, 5, 3, 4, 2, 6], [2, 3]);

	it("sum / mean / max / min along each axis", () => {
		expectTensor(nn.sum(m, 0), [3], [5, 7, 9]);
		expectTensor(nn.sum(m, 1), [2], [9, 12]);
		expectTensor(nn.mean(m, 1), [2], [3, 4]);
		expectTensor(nn.mean(m, 0), [3], [2.5, 3.5, 4.5]);
		expectTensor(nn.max(m, 1), [2], [5, 6]);
		expectTensor(nn.max(m, 0), [3], [4, 5, 6]);
		expectTensor(nn.min(m, 1), [2], [1, 2]);
		expectTensor(nn.min(m, 0), [3], [1, 2, 3]);
	});

	it("keepDim keeps a size-1 axis", () => {
		expectTensor(nn.sum(m, 1, true), [2, 1], [9, 12]);
		expectTensor(nn.max(m, 0, true), [1, 3], [4, 5, 6]);
		expectTensor(nn.mean(m, -1, true), [2, 1], [3, 4]);
		expectTensor(nn.min(m, 0, true), [1, 3], [1, 2, 3]);
		expectTensor(nn.argmax(m, 1, true), [2, 1], [1, 2]);
	});

	it("argmax with negative axis, ties -> first index", () => {
		expectTensor(nn.argmax(m, 1), [2], [1, 2]);
		expectTensor(nn.argmax(m, 0), [3], [1, 0, 1]);
		expectTensor(nn.argmax(m, -1), [2], [1, 2]);
		expectTensor(nn.argmax(tensor([2, 7, 7, 1], [4]), 0), [], [1]);
	});

	it("reduce() dispatches by op and handles a middle axis", () => {
		const x = tensor([1, 2, 3, 4, 5, 6, 7, 8], [2, 2, 2]);
		// axis 1: out[a][c] = x[a][0][c] + x[a][1][c]
		expectTensor(nn.reduce("sum", x, 1), [2, 2], [4, 6, 12, 14]);
		expectTensor(nn.reduce("mean", x, 1), [2, 2], [2, 3, 6, 7]);
		expectTensor(nn.reduce("max", x, 1), [2, 2], [3, 4, 7, 8]);
		expectTensor(nn.reduce("min", x, 1, true), [2, 1, 2], [1, 2, 5, 6]);
	});

	it("errors on a bad axis", () => {
		expect(() => nn.sum(m, 2)).toThrow();
		expect(() => nn.max(m, -3)).toThrow();
	});
});

describe("topk", () => {
	it("last axis (default), descending with lower index first on ties", () => {
		const r = nn.topk(tensor([3, 9, 1, 9, 5], [5]), 3);
		expectTensor(r.values, [3], [9, 9, 5]);
		expectTensor(r.indices, [3], [1, 3, 4]);
	});

	it("along a non-last axis", () => {
		const x = tensor([1, 9, 5, 2, 3, 7], [3, 2]);
		// column 0 = [1,5,3] -> [5,3] at [1,2]; column 1 = [9,2,7] -> [9,7] at [0,2]
		const r = nn.topk(x, 2, 0);
		expectTensor(r.values, [2, 2], [5, 9, 3, 7]);
		expectTensor(r.indices, [2, 2], [1, 0, 2, 2]);
		const neg = nn.topk(x, 2, -2);
		expectTensor(neg.values, [2, 2], [5, 9, 3, 7]);
	});

	it("rows are independent; k = len sorts everything", () => {
		const r = nn.topk(tensor([1, 3, 2, 6, 4, 5], [2, 3]), 3);
		expectTensor(r.values, [2, 3], [3, 2, 1, 6, 5, 4]);
		expectTensor(r.indices, [2, 3], [1, 2, 0, 0, 2, 1]);
	});

	it("errors for k out of range", () => {
		expect(() => nn.topk(tensor([1, 2], [2]), 3)).toThrow();
		expect(() => nn.topk(tensor([1, 2], [2]), 0)).toThrow();
	});
});
