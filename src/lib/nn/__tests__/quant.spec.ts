// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { expectArrayClose } from "#/test/helpers";
import { CpuNn, encodeSafetensors, floatToHalf } from "../index";
import {
	dequantize,
	packedBytes,
	quantize,
	readQuantTable,
	splitQuantized,
} from "../quant";
import { halfToFloat32, parseSafetensors } from "../safetensors";

const ramp = (n: number, scale = 1) =>
	Float32Array.from({ length: n }, (_, i) => Math.sin(i * 0.37) * scale);

describe("nn quantized weights", () => {
	it("int8 packs two's complement bytes, one scale per group", () => {
		const x = new Float32Array([1, -1, 0.5, -0.25, 2, -2, 0, 1]);
		const { q, scale, info } = quantize(x, [2, 4], 8, 4);
		expect(q.length).toBe(8);
		expect(scale.length).toBe(2);
		// row 0: absmax 1 → q = round(v · 127)
		expect([...q.slice(0, 4)]).toEqual([127, 256 - 127, 64, 256 - 32]);
		const back = dequantize(q, halfToFloat32(scale), info);
		expectArrayClose(back, x, 2 / 127);
	});

	it("int4 packs element 2k in the low nibble, offset 8", () => {
		const x = new Float32Array([7, -7, 0, 1, -1]);
		const { q, info } = quantize(x, [1, 5], 4, 5);
		expect(q.length).toBe(packedBytes(5, 4));
		// absmax 7 → scale 1, exact, so the clip search keeps it: 7 → 15, -7 → 1, -1 → 7, pad nibble 0
		expect(q[0] & 15).toBe(15);
		expect(q[0] >> 4).toBe(1);
		expect([...q.slice(1)]).toEqual([8 | (9 << 4), 7]);
		expect(info).toEqual({ bits: 4, group: 5, shape: [1, 5] });
	});

	it("int4 round trip stays within half a step per group", () => {
		const shape = [6, 64];
		const x = ramp(6 * 64, 0.3);
		const { q, scale, info } = quantize(x, shape, 4, 32);
		const s = halfToFloat32(scale);
		const back = dequantize(q, s, info);
		for (let i = 0; i < x.length; i++) {
			const step = s[Math.floor(i / 32)];
			// half a step, plus whatever the clip search cut off the group's ends
			const clipped = Math.max(0, Math.abs(x[i]) - 7 * step);
			expect(Math.abs(back[i] - x[i])).toBeLessThanOrEqual(
				0.5 * step + clipped + 1e-6,
			);
		}
	});

	it("rejects a group that does not tile the rows", () => {
		expect(() => quantize(ramp(10), [2, 5], 8, 4)).toThrow(/group/);
	});

	it("the CPU loader expands quantized pairs and keeps plain tensors", () => {
		const w = ramp(4 * 6);
		const { q, scale, info } = quantize(w, [4, 6], 8, 6);
		const bytes = encodeSafetensors(
			{
				"lin.weight.qweight": { shape: [q.length], data: q },
				"lin.weight.qscale": { shape: [4, 1], data: scale },
				"lin.bias": {
					shape: [4],
					data: Uint16Array.from([1, 2, 3, 4], floatToHalf),
				},
			},
			{ quant: JSON.stringify({ "lin.weight": info }) },
		);
		const st = parseSafetensors(bytes);
		expect(st.entries.get("lin.weight.qweight")?.dtype).toBe("u8");
		expect(readQuantTable(st.metadata).get("lin.weight")?.bits).toBe(8);
		const { plain, quantized } = splitQuantized(st.entries, st.metadata);
		expect(plain.map((e) => e.name)).toEqual(["lin.bias"]);
		expect(quantized.map((e) => e.name)).toEqual(["lin.weight"]);

		const nn = new CpuNn();
		const ws = nn.weightsFromBytes(bytes);
		expect([...ws.names].sort()).toEqual(["lin.bias", "lin.weight"]);
		expect([...ws.get("lin.weight").shape]).toEqual([4, 6]);
		expectArrayClose(
			(ws.get("lin.weight") as unknown as { data: Float32Array }).data,
			w,
			1 / 127,
		);
	});

	it("a file without a quant table loads unchanged", () => {
		const st = parseSafetensors(
			encodeSafetensors({ a: { shape: [2], data: new Float32Array([1, 2]) } }),
		);
		const { plain, quantized } = splitQuantized(st.entries, st.metadata);
		expect(plain.length).toBe(1);
		expect(quantized.length).toBe(0);
	});
});
