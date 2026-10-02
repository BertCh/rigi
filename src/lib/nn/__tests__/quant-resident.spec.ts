// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import {
	canStayResident,
	dequantize,
	packResident,
	quantize,
	RESIDENT_HEADER_WORDS,
} from "../quant";
import { halfToFloat32 } from "../safetensors";

const ramp = (n: number) =>
	Float32Array.from(
		{ length: n },
		(_, i) => Math.sin(i * 0.37) * (1 + (i % 5)),
	);

/** The shader's ld_<n>(i) in JS (gpu/wgsl.ts q8Loaders). */
function loadResident(words: Uint32Array, i: number): number {
	const cols = words[0];
	const group = words[1];
	const row = Math.floor(i / cols);
	const s = row * (cols / group) + Math.floor((i - row * cols) / group);
	const half = new Uint16Array(words.buffer)[words[2] * 2 + s];
	const byte = new Int8Array(words.buffer)[RESIDENT_HEADER_WORDS * 4 + i];
	return byte * halfToFloat32(Uint16Array.of(half))[0];
}

describe("resident q8 packing", () => {
	it("eligibility needs int8, rank >= 2 and cols / group multiples of 4", () => {
		const q = (shape: number[], bits: 4 | 8, group: number) =>
			quantize(ramp(shape.reduce((a, b) => a * b, 1)), shape, bits, group).info;
		expect(canStayResident(q([6, 16], 8, 16))).toBe(true);
		expect(canStayResident(q([6, 16], 8, 8))).toBe(true);
		expect(canStayResident(q([6, 16], 4, 16))).toBe(false);
		expect(canStayResident(q([6, 18], 8, 18))).toBe(false);
		expect(canStayResident(q([6, 12], 8, 6))).toBe(false);
		expect(canStayResident({ bits: 8, group: 1, shape: [24] })).toBe(false);
	});

	it("is self-describing and dequantizes element by element like the CPU loader", () => {
		for (const [shape, group] of [
			[[5, 24], 24],
			[[5, 24], 8],
			[[3, 2, 3, 4], 12],
		] as [number[], number][]) {
			const n = shape.reduce((a, b) => a * b, 1);
			const { q, scale, info } = quantize(ramp(n), shape, 8, group);
			const words = packResident(q, scale, info);
			const cols = n / shape[0];
			expect([words[0], words[1], words[3]]).toEqual([
				cols,
				group,
				cols / group,
			]);
			// scales start right after the bytes and fill the buffer to the word
			expect(words[2]).toBe(RESIDENT_HEADER_WORDS + n / 4);
			expect(words.length).toBe(words[2] + Math.ceil(scale.length / 2));
			const want = dequantize(q, halfToFloat32(scale), info);
			for (let i = 0; i < n; i++)
				expect(loadResident(words, i)).toBeCloseTo(want[i], 6);
		}
	});

	it("an odd number of scales pads the last word", () => {
		const { q, scale, info } = quantize(ramp(12), [3, 4], 8, 4);
		expect(scale.length).toBe(3);
		const words = packResident(q, scale, info);
		expect(words.length).toBe(RESIDENT_HEADER_WORDS + 3 + 2);
	});

	it("rejects mismatched sizes and ineligible tensors", () => {
		const a = quantize(ramp(24), [4, 6], 8, 6);
		expect(() => packResident(a.q, a.scale, a.info)).toThrow();
		const b = quantize(ramp(32), [4, 8], 8, 8);
		expect(() => packResident(b.q.slice(1), b.scale, b.info)).toThrow();
	});
});
