// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { CpuNn, encodeSafetensors } from "#/lib/nn";
import { expectArrayClose } from "#/test/helpers";
import { resampleBilinear } from "../people";
import { bindTfliteNet, runTfliteNet } from "../tflite-net";

const nn = new CpuNn();

/** A tflite-net over a hand-written program; `input` is the NHWC input tensor name (`t0`). */
function net(
	program: unknown[],
	tensors: Record<string, { shape: number[]; data: number[] }> = {},
	output = "t9",
) {
	const t: Record<string, { shape: number[]; data: Float32Array }> = {};
	for (const [k, v] of Object.entries(tensors))
		t[k] = { shape: v.shape, data: new Float32Array(v.data) };
	if (!Object.keys(t).length)
		t.unused = { shape: [1], data: new Float32Array(1) };
	return bindTfliteNet(
		nn.weightsFromBytes(
			encodeSafetensors(t, {
				layout: "rigi-tflite-1",
				input: "t0",
				output,
				inputShape: "[1,1,1,1]",
				outputShape: "[1,1,1,1]",
				mean: "0",
				std: "1",
				program: JSON.stringify(program),
			}),
		),
	);
}
const run = (n: ReturnType<typeof net>, data: number[], shape: number[]) => {
	const r = runTfliteNet(nn, n, nn.fromArray(data, shape));
	return {
		shape: [...r.output.shape],
		data: Array.from((r.output as unknown as { data: Float32Array }).data),
	};
};

describe("tflite-net", () => {
	it("a 1x1 conv on the NHWC input is a linear over channels, with relu6", () => {
		const n = net(
			[["conv", "t9", "t0", "c1", 1, [0, 0, 0, 0], 1, 1, "relu6"]],
			{
				"c1.w": { shape: [2, 2, 1, 1], data: [1, 1, 2, 0] },
				"c1.b": { shape: [2], data: [0, 10] },
			},
		);
		// pixels (1, 2) and (3, -4): out = (x0 + x1, 2 x0 + 10) -> (3, 12), (-1, 16) -> relu6
		const r = run(n, [1, 2, 3, -4], [1, 1, 2, 2]);
		expect(r.shape).toEqual([1, 2, 1, 2]);
		expectArrayClose(r.data, [3, 0, 6, 6]);
	});

	it("a stride-2 3x3 conv with asymmetric SAME padding", () => {
		const n = net([["conv", "t9", "t0", "c1", 2, [0, 1, 0, 1], 1, 1, ""]], {
			"c1.w": { shape: [1, 1, 3, 3], data: new Array(9).fill(1) },
			"c1.b": { shape: [1], data: [0] },
		});
		const r = run(n, new Array(16).fill(1), [1, 4, 4, 1]);
		expect(r.shape).toEqual([1, 1, 2, 2]);
		expectArrayClose(r.data, [9, 6, 6, 4]);
	});

	it("depthwise conv keeps channels apart", () => {
		const n = net([["conv", "t9", "t0", "c1", 1, [0, 0, 0, 0], 1, 2, ""]], {
			"c1.w": { shape: [2, 1, 1, 1], data: [2, -1] },
			"c1.b": { shape: [2], data: [1, 0] },
		});
		const r = run(n, [1, 5, 2, 6], [1, 1, 2, 2]);
		// ch0 = 2 x + 1, ch1 = -x
		expectArrayClose(r.data, [3, 5, -5, -6]);
	});

	it("sum / transpose / softmax run on the NHWC view", () => {
		const n = net(
			[
				["sum", "t1", "t0", 2],
				["transpose", "t2", "t1", [0, 2, 1, 3]],
				["softmax", "t3", "t2"],
				["reshape", "t9", "t3", [1, 1, 2, 2]],
			],
			{},
		);
		// input [1,2,2,2]: sum over W -> [[1+3, 2+4], [5+7, 6+8]] = [[4,6],[12,14]] as [1,2,1,2]
		const r = run(n, [1, 2, 3, 4, 5, 6, 7, 8], [1, 2, 2, 2]);
		// transposed to [1,1,2,2] = rows (4,6) and (12,14); softmax over the channel pair
		const s = (a: number, b: number) => 1 / (1 + Math.exp(b - a));
		expect(r.shape).toEqual([1, 2, 1, 2]);
		const exp = [s(4, 6), 1 - s(4, 6), s(12, 14), 1 - s(12, 14)];
		// output is NCHW of [1,1,2,2]: ch0 = (p00, p10), ch1 = (p01, p11)
		expectArrayClose(r.data, [exp[0], exp[2], exp[1], exp[3]], 1e-6);
	});

	it("add with a per-channel constant, in NCHW after a conv and in NHWC after a reshape", () => {
		const n = net(
			[
				["conv", "t1", "t0", "c1", 1, [0, 0, 0, 0], 1, 1, ""],
				["add", "t2", "t1", "c5", ""],
				["mul", "t9", "t2", "c6", "relu"],
			],
			{
				"c1.w": { shape: [2, 1, 1, 1], data: [1, 2] },
				"c1.b": { shape: [2], data: [0, 0] },
				c5: { shape: [2], data: [10, 20] },
				c6: { shape: [2], data: [1, -1] },
			},
		);
		const r = run(n, [1, 2], [1, 1, 2, 1]);
		// t1 channels: (1, 2) and (2, 4); +c5 -> (11, 12) / (22, 24); * c6 -> (11, 22), (-12, -24); relu
		expectArrayClose(r.data, [11, 12, 0, 0]);
	});

	it("resize (align corners and nearest), global average pool, concat", () => {
		const bil = net([["resize", "t9", "t0", [1, 3], "bilinear", true]]);
		expectArrayClose(run(bil, [0, 1], [1, 1, 2, 1]).data, [0, 0.5, 1]);
		const near = net([["resize", "t9", "t0", [1, 4], "nearest", false]]);
		expectArrayClose(run(near, [7, 9], [1, 1, 2, 1]).data, [7, 7, 9, 9]);
		const gap = net([
			["gap", "t1", "t0"],
			["resize", "t2", "t1", [2, 2], "nearest", false],
			["cat", "t9", ["t0", "t2"], 3],
		]);
		const r = run(gap, [1, 2, 3, 4], [1, 2, 2, 1]);
		// the input and its mean (2.5) broadcast back, concatenated on channels (NCHW out)
		expect(r.shape).toEqual([1, 2, 2, 2]);
		expectArrayClose(r.data, [1, 2, 3, 4, 2.5, 2.5, 2.5, 2.5]);
	});

	it("a 2x2 stride-2 transposed conv", () => {
		const n = net([["tconv", "t9", "t0", "c1", 2, ""]], {
			"c1.w": { shape: [1, 1, 2, 2], data: [1, 2, 3, 4] },
			"c1.b": { shape: [1], data: [0.5] },
		});
		const r = run(n, [2], [1, 1, 1, 1]);
		expectArrayClose(r.data, [2.5, 4.5, 6.5, 8.5]);
	});

	it("rejects a weights file that is not rigi-tflite-1", () => {
		const bad = nn.weightsFromBytes(
			encodeSafetensors({ a: { shape: [1], data: new Float32Array(1) } }, {}),
		);
		expect(() => bindTfliteNet(bad)).toThrow(/rigi-tflite-1/);
	});
});

describe("resampleBilinear", () => {
	it("is the identity at the same size and uses half-pixel centres", () => {
		expectArrayClose(
			resampleBilinear([1, 2, 3, 4], 2, 2, 1, 2, 2),
			[1, 2, 3, 4],
		);
		expectArrayClose(
			resampleBilinear([0, 1], 2, 1, 1, 4, 1),
			[0, 0.25, 0.75, 1],
		);
	});

	it("reads an RGBA stride and maps values", () => {
		const out = resampleBilinear(
			[10, 20, 30, 255],
			1,
			1,
			3,
			1,
			1,
			4,
			(v) => v / 10,
		);
		expectArrayClose(out, [1, 2, 3]);
	});
});
