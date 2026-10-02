// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { seededRandom } from "#/test/helpers";
import {
	bitsOf,
	doubleOf,
	f32Bits,
	f32Value,
	f64Abs,
	f64Add,
	f64Div,
	f64DivSmall,
	f64FromF32,
	f64FromU32,
	f64GtPos,
	f64Is0,
	f64Max0,
	f64Mul,
	f64Neg,
	f64Sub,
	f64ToF32,
	mul32,
	u64Add,
	u64Clz,
	u64Is0,
	u64Lt,
	u64Shl,
	u64Shr,
	u64ShrSticky,
	u64Sub,
	type V2,
	wgslF64,
} from "../softf64";

const big = (v: V2) => (BigInt(v[1]) << 32n) | BigInt(v[0]);
const same = (got: V2, want: number) => {
	// NaN-free domain: compare bit patterns, treating -0 and 0 as distinct like hardware
	expect(big(got)).toBe(big(bitsOf(want)));
};
const randDouble = (rnd: () => number) =>
	(rnd() < 0.5 ? -1 : 1) * (1 + rnd()) * 2 ** Math.floor(rnd() * 80 - 40);

describe("u64 helpers", () => {
	it("match BigInt arithmetic", () => {
		const rnd = seededRandom(3);
		const mk = (): V2 => [
			Math.floor(rnd() * 2 ** 32) >>> 0,
			Math.floor(rnd() * 2 ** 32) >>> 0,
		];
		const M = (1n << 64n) - 1n;
		for (let i = 0; i < 100; i++) {
			const a = mk();
			const b = mk();
			expect(big(u64Add(a, b))).toBe((big(a) + big(b)) & M);
			expect(big(u64Sub(a, b))).toBe((big(a) - big(b)) & M);
			expect(u64Lt(a, b)).toBe(big(a) < big(b));
			const n = Math.floor(rnd() * 70);
			expect(big(u64Shl(a, n))).toBe(n >= 64 ? 0n : (big(a) << BigInt(n)) & M);
			expect(big(u64Shr(a, n))).toBe(n >= 64 ? 0n : big(a) >> BigInt(n));
			const sticky = big(u64ShrSticky(a, n));
			const lost =
				n > 0 && n < 64 && (big(a) & ((1n << BigInt(n)) - 1n)) !== 0n;
			const base = n >= 64 ? 0n : big(a) >> BigInt(n);
			if (n < 64) expect(sticky).toBe(base | (lost ? 1n : 0n));
			expect(big(mul32(a[0], b[0]))).toBe(BigInt(a[0]) * BigInt(b[0]));
		}
		expect(u64Is0([0, 0])).toBe(true);
		expect(u64Is0([0, 1])).toBe(false);
		expect(u64Clz([0, 1])).toBe(31);
		expect(u64Clz([1, 0])).toBe(63);
	});
});

describe("soft binary64", () => {
	it("bit conversions round trip", () => {
		expect(doubleOf(bitsOf(Math.PI))).toBe(Math.PI);
		expect(f32Value(f32Bits(0.1))).toBe(Math.fround(0.1));
		expect(wgslF64(1)).toBe("vec2<u32>(0x0u, 0x3ff00000u)");
	});
	it("add / sub / mul / div are correctly rounded", () => {
		const rnd = seededRandom(11);
		for (let i = 0; i < 400; i++) {
			const a = randDouble(rnd);
			const b =
				rnd() < 0.2 ? -a * (1 + (rnd() - 0.5) * 2 ** -30) : randDouble(rnd);
			same(f64Add(bitsOf(a), bitsOf(b)), a + b);
			same(f64Sub(bitsOf(a), bitsOf(b)), a - b);
			same(f64Mul(bitsOf(a), bitsOf(b)), a * b);
			same(f64Div(bitsOf(a), bitsOf(b)), a / b);
			const k = 1 + Math.floor(rnd() * 65534);
			same(f64DivSmall(bitsOf(a), k), a / k);
		}
	});
	it("handles zeros, signs and tiny / huge results", () => {
		same(f64Add(bitsOf(0), bitsOf(0)), 0);
		same(f64Add(bitsOf(-0), bitsOf(-0)), -0);
		same(f64Add(bitsOf(0), bitsOf(2.5)), 2.5);
		same(f64Add(bitsOf(2.5), bitsOf(0)), 2.5);
		same(f64Mul(bitsOf(1e200), bitsOf(1e200)), Number.POSITIVE_INFINITY);
		same(f64Mul(bitsOf(1e-200), bitsOf(1e-200)), 0);
		same(f64Mul(bitsOf(1e-160), bitsOf(1e-160)), 1e-320);
		same(f64DivSmall(bitsOf(0), 3), 0);
		expect(f64Is0(bitsOf(-0))).toBe(true);
		expect(doubleOf(f64Neg(bitsOf(2)))).toBe(-2);
		expect(doubleOf(f64Abs(bitsOf(-2)))).toBe(2);
		expect(doubleOf(f64Max0(bitsOf(-2)))).toBe(0);
		expect(doubleOf(f64Max0(bitsOf(2)))).toBe(2);
		expect(f64GtPos(bitsOf(3), bitsOf(2))).toBe(true);
	});
	it("f32 and u32 conversions", () => {
		const rnd = seededRandom(8);
		for (let i = 0; i < 300; i++) {
			const a = randDouble(rnd) * (rnd() < 0.1 ? 2 ** -90 : 1);
			expect(f64ToF32(bitsOf(a))).toBe(f32Bits(a));
			const x = Math.fround(a);
			same(f64FromF32(f32Bits(x)), x);
			const n = Math.floor(rnd() * 2 ** 32) >>> (rnd() * 31);
			same(f64FromU32(n), n);
		}
		same(f64FromF32(f32Bits(2 ** -149)), 2 ** -149);
		same(f64FromF32(0), 0);
		same(f64FromU32(0), 0);
		expect(f64ToF32(bitsOf(1e300))).toBe(0x7f800000);
		expect(f64ToF32(bitsOf(1e-300))).toBe(0);
		expect(f64ToF32(bitsOf(0))).toBe(0);
		expect(f64ToF32(bitsOf(2 ** -140))).toBe(f32Bits(2 ** -140));
	});
});
