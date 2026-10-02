// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { seededRandom } from "#/test/helpers";
import {
	addF,
	axisTapsF64,
	constsTable,
	divF,
	f64Words,
	fromF32,
	fromF64,
	mulF,
	mulFull,
	normOne,
	prepRef,
	subF,
	toF32,
} from "../prep-ref";

const f32bits = (x: number) => new Uint32Array(new Float32Array([x]).buffer)[0];
const bitsF32 = (b: number) => new Float32Array(new Uint32Array([b]).buffer)[0];
const soft = (x: number) => {
	const [lo, hi] = f64Words(x);
	return fromF64(lo, hi);
};
const val = (a: ReturnType<typeof soft>) => (a.h * 2 ** 32 + a.l) * 2 ** a.e;

describe("sky prep soft float", () => {
	it("mulFull matches BigInt", () => {
		const rnd = seededRandom(2);
		for (let i = 0; i < 100; i++) {
			const a = Math.floor(rnd() * 2 ** 32) >>> 0;
			const b = Math.floor(rnd() * 2 ** 32) >>> 0;
			const [lo, hi] = mulFull(a, b);
			expect((BigInt(hi) << 32n) | BigInt(lo)).toBe(BigInt(a) * BigInt(b));
		}
	});
	it("f32 and f64 import is exact, toF32 is fround", () => {
		for (const x of [0.5, 0.123456789, 1, 3.75, 1e-5]) {
			const f = Math.fround(x);
			expect(val(fromF32(f32bits(f)))).toBe(f);
			expect(bitsF32(toF32(fromF32(f32bits(f))))).toBe(f);
			expect(val(soft(x))).toBe(x);
			expect(bitsF32(toF32(soft(x)))).toBe(f);
		}
		expect(fromF32(0)).toEqual({ h: 0, l: 0, e: 0 });
		expect(toF32(fromF32(0))).toBe(0);
		expect(toF32(soft(1e60))).toBe(0x7fc00000);
	});
	it("mul / add / sub / div are correctly rounded doubles", () => {
		const rnd = seededRandom(6);
		for (let i = 0; i < 200; i++) {
			const a = (1 + rnd()) * 2 ** Math.floor(rnd() * 10 - 5);
			const b = (1 + rnd()) * 2 ** Math.floor(rnd() * 10 - 5);
			expect(val(mulF(soft(a), soft(b)))).toBe(a * b);
			expect(val(addF(soft(a), soft(b)))).toBe(a + b);
			expect(val(divF(soft(a), soft(b)))).toBe(a / b);
			const big = Math.max(a, b);
			const small = Math.min(a, b);
			expect(val(subF(soft(big), soft(small)))).toBe(big - small);
		}
		expect(mulF(soft(0), soft(2))).toEqual({ h: 0, l: 0, e: 0 });
		expect(val(addF(soft(0), soft(2)))).toBe(2);
	});
});

describe("sky prep tables", () => {
	it("axis taps weights sum to the scale and cover the source", () => {
		const { table, scaleLo, scaleHi } = axisTapsF64(10, 4);
		expect(
			new Float64Array(new Uint32Array([scaleLo, scaleHi]).buffer)[0],
		).toBe(2.5);
		let covered = 0;
		for (let j = 0; j < 4; j++) {
			const start = table[2 * j];
			const count = table[2 * j + 1];
			let sum = 0;
			for (let t = 0; t < count; t++) {
				const o = start + 3 * t;
				sum += new Float64Array(
					new Uint32Array([table[o + 1], table[o + 2]]).buffer,
				)[0];
			}
			expect(sum).toBeCloseTo(2.5, 12);
			covered += count;
		}
		expect(covered).toBeGreaterThanOrEqual(10);
		const id = axisTapsF64(5, 5);
		expect(id.table[1]).toBe(1);
		expect(() => axisTapsF64(3, 5)).toThrow();
	});
	it("consts table holds scales, means and 1/std", () => {
		const k = constsTable([1, 2], [3, 4]);
		expect(k.length).toBe(16);
		expect(Array.from(k.subarray(0, 4))).toEqual([1, 2, 3, 4]);
		expect(new Float64Array(new Uint32Array([k[4], k[5]]).buffer)[0]).toBe(
			0.485,
		);
	});
});

describe("prepRef", () => {
	it("a flat image normalises to the per-channel constants; sign is kept", () => {
		const W = 6;
		const H = 4;
		const rgba = new Uint8Array(W * H * 4);
		for (let i = 0; i < W * H; i++) rgba.set([51, 102, 204, 255], 4 * i);
		const { lo, inp } = prepRef(rgba, W, H, 3, 2);
		const n = 6;
		const want = [51, 102, 204].map((v) => Math.fround(v / 255));
		const mean = [0.485, 0.456, 0.406];
		const std = [0.229, 0.224, 0.225];
		for (let c = 0; c < 3; c++)
			for (let i = 0; i < n; i++) {
				expect(bitsF32(lo[c * n + i])).toBe(want[c]);
				expect(bitsF32(inp[c * n + i])).toBeCloseTo(
					(want[c] - mean[c]) / std[c],
					5,
				);
			}
	});
	it("normOne maps zero to -mean/std", () => {
		const k = constsTable([1, 0], [1, 0]);
		expect(bitsF32(normOne(0, k, 0))).toBeCloseTo(-0.485 / 0.229, 5);
		expect(bitsF32(normOne(f32bits(1), k, 2))).toBeCloseTo(
			(1 - 0.406) / 0.225,
			5,
		);
	});
});
