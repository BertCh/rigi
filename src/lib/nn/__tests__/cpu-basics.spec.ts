// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { expectArrayClose } from "#/test/helpers";
import {
	CpuNn,
	createNn,
	encodeSafetensors,
	floatToHalf,
	halfToFloat,
} from "../index";

const nn = new CpuNn();
const read = (t: Parameters<CpuNn["read"]>[0]) => nn.read(t);

describe("nn cpu basics", () => {
	it("createNn cpu", async () => {
		const n = await createNn({ backend: "cpu" });
		expect(n.backend.kind).toBe("cpu");
	});

	it("safetensors round trip with f16 widening", () => {
		const half = new Uint16Array(
			[1, -2.5, 65504, 0.000061035].map(floatToHalf),
		);
		const bytes = encodeSafetensors(
			{
				"a.weight": { shape: [2, 2], data: new Float32Array([1, 2, 3, 4]) },
				"b.bias": { shape: [4], data: half },
			},
			{ format: "pt" },
		);
		const w = nn.weightsFromBytes(bytes);
		expect(w.metadata.format).toBe("pt");
		expect(w.get("a.weight").shape).toEqual([2, 2]);
		expect([
			...(w.get("b.bias") as unknown as { data: Float32Array }).data,
		]).toEqual([...half].map(halfToFloat));
		expect(() => w.get("nope")).toThrow();
	});

	it("linear: x Wᵀ + b", async () => {
		const x = nn.fromArray([1, 2, 3, 4, 5, 6], [2, 3]);
		const w = nn.fromArray([1, 0, 0, 0, 1, 1], [2, 3]);
		const b = nn.fromArray([10, 20], [2]);
		expect([...(await read(nn.linear(x, w, b)))]).toEqual([11, 25, 14, 31]);
	});

	it("conv2d 3×3 pad 1 on a ramp", async () => {
		const x = nn.fromArray([1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 1, 3, 3]);
		const w = nn.fromArray(new Array(9).fill(1), [1, 1, 3, 3]);
		const y = nn.conv2d(x, w, null, { padding: 1 });
		expect(y.shape).toEqual([1, 1, 3, 3]);
		expect([...(await read(y))]).toEqual([12, 21, 16, 27, 45, 33, 24, 39, 28]);
	});

	it("softmax rows sum to 1", async () => {
		const y = nn.softmax(nn.fromArray([0, Math.log(3)], [1, 2]));
		expectArrayClose(await read(y), [0.25, 0.75], 1e-7);
	});

	it("topk sorted with indices", async () => {
		const r = nn.topk(nn.fromArray([3, 9, 1, 9, 5], [5]), 3);
		expect([...(await read(r.values))]).toEqual([9, 9, 5]);
		expect([...(await read(r.indices))]).toEqual([1, 3, 4]);
	});
});
