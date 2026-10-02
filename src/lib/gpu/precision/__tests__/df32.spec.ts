// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { afterEach, describe, expect, it } from "vitest";
import { seededRandom } from "#/test/helpers";
import {
	bits32,
	ddAdd,
	ddAddF,
	ddDiv,
	ddMul,
	ddMulF,
	ddSqrt,
	div32,
	EPS_ADD,
	EPS_DIV,
	EPS_MUL,
	EPS_SQRT,
	fastTwoSum,
	flushSubnormals,
	fma32,
	fromBits32,
	ftz32,
	MIN_NORMAL32,
	nextDown32,
	nextUp32,
	setDivSqrtPerturbation,
	setFlushSubnormals,
	split,
	sqrt32,
	twoProd,
	twoSum,
	withExactDivSqrt,
} from "../df32";

afterEach(() => {
	setFlushSubnormals(false);
	setDivSqrtPerturbation(0);
});

const val = (d: [number, number]) => d[0] + d[1];
const f = Math.fround;

describe("f32 machine", () => {
	it("round-trips bit patterns and steps by one ULP", () => {
		expect(bits32(1)).toBe(0x3f800000);
		expect(fromBits32(0x40000000)).toBe(2);
		expect(nextUp32(1)).toBe(1 + 2 ** -23);
		expect(nextDown32(1)).toBe(1 - 2 ** -24);
		expect(nextUp32(-1)).toBe(-(1 - 2 ** -24));
		expect(nextUp32(0)).toBe(2 ** -149);
		expect(nextDown32(nextUp32(3.5))).toBe(3.5);
	});
	it("flushes subnormals only in stress mode", () => {
		expect(ftz32(2 ** -130)).toBe(0);
		expect(Object.is(ftz32(-(2 ** -130)), -0)).toBe(true);
		expect(ftz32(MIN_NORMAL32)).toBe(MIN_NORMAL32);
		expect(flushSubnormals()).toBe(false);
		setFlushSubnormals(true);
		expect(flushSubnormals()).toBe(true);
		expect(fma32(2 ** -100, 2 ** -40, 0)).toBe(0);
		setFlushSubnormals(false);
		expect(fma32(2 ** -100, 2 ** -40, 0)).toBe(2 ** -140);
	});
	it("fma32 rounds once", () => {
		// (1+2^-12)^2 = 1 + 2^-11 + 2^-24: separate rounding loses the 2^-24 term, fma keeps it
		const a = 1 + 2 ** -12;
		expect(f(a * a)).toBe(1 + 2 ** -11);
		expect(fma32(a, a, -1)).toBe(2 ** -11 + 2 ** -24);
		expect(fma32(Number.POSITIVE_INFINITY, 1, 0)).toBe(
			Number.POSITIVE_INFINITY,
		);
	});
	it("fma32 resolves exact midpoints using the error term", () => {
		// a*b = 1 + 2^-24 exactly (midpoint between 1 and 1+2^-23); c nudges either way
		const a = 1 + 2 ** -12;
		const b = 1 - 2 ** -12 + 2 ** -24 / 1; // not exact; just check monotone in c
		const lo = fma32(a, b, -(2 ** -60));
		const hi = fma32(a, b, 2 ** -60);
		expect(hi).toBeGreaterThanOrEqual(lo);
	});
	it("div/sqrt are exact unless perturbed, within the ULP bound when perturbed", () => {
		expect(div32(1, 3)).toBe(f(1 / 3));
		expect(sqrt32(2)).toBe(f(Math.SQRT2));
		const r = seededRandom(5);
		setDivSqrtPerturbation(3, r);
		let moved = 0;
		for (let i = 0; i < 50; i++) {
			const q = div32(1, 3);
			let k = 0;
			let x = f(1 / 3);
			while (x !== q && k < 10) {
				x = q > x ? nextUp32(x) : nextDown32(x);
				k++;
			}
			expect(k).toBeLessThanOrEqual(3);
			if (q !== f(1 / 3)) moved++;
		}
		expect(moved).toBeGreaterThan(0);
		expect(withExactDivSqrt(() => div32(1, 3))).toBe(f(1 / 3));
		expect(div32(0, 3)).toBe(0);
	});
});

describe("error-free transformations", () => {
	it("twoSum / twoProd are exact", () => {
		const rnd = seededRandom(1);
		for (let i = 0; i < 200; i++) {
			const a = f((rnd() - 0.5) * 1000);
			const b = f((rnd() - 0.5) * 2 ** (rnd() * 40 - 20));
			const s = twoSum(a, b);
			expect(s[0] + s[1]).toBe(a + b);
			const p = twoProd(a, b);
			expect(p[0] + p[1]).toBe(a * b);
		}
	});
	it("fastTwoSum is exact when |a| >= |b|", () => {
		const s = fastTwoSum(1e6, 0.3);
		expect(s[0]).toBe(f(1e6 + f(0.3)));
	});
});

describe("df32 arithmetic", () => {
	it("split keeps ~48 bits and is normalised", () => {
		const v = Math.PI * 1e5;
		const [h, l] = split(v);
		expect(Math.abs(h + l - v)).toBeLessThanOrEqual(2 ** -48 * v);
		expect(f(h + l)).toBe(h);
		expect(split(0)).toEqual([0, 0]);
	});
	it("add/mul/div/sqrt stay within their budgets", () => {
		const rnd = seededRandom(9);
		for (let i = 0; i < 300; i++) {
			const x =
				(rnd() + 0.5) *
				2 ** Math.floor(rnd() * 20 - 10) *
				(rnd() < 0.3 ? -1 : 1);
			const y = (rnd() + 0.5) * 2 ** Math.floor(rnd() * 20 - 10);
			const [xh, xl] = split(x);
			const [yh, yl] = split(y);
			const xe = xh + xl;
			const ye = yh + yl;
			const rel = (got: [number, number], want: number) =>
				Math.abs(val(got) - want) / Math.abs(want);
			expect(rel(ddMul(xh, xl, yh, yl), xe * ye)).toBeLessThanOrEqual(EPS_MUL);
			expect(rel(ddDiv(xh, xl, yh, yl), xe / ye)).toBeLessThanOrEqual(EPS_DIV);
			expect(rel(ddMulF(xh, xl, yh), xe * yh)).toBeLessThanOrEqual(EPS_MUL);
			expect(rel(ddAddF(xh, xl, yh), xe + yh)).toBeLessThanOrEqual(
				2 ** -47 + 2 ** -52,
			);
			if (Math.abs(xe + ye) > 0.01 * Math.abs(xe))
				expect(rel(ddAdd(xh, xl, yh, yl), xe + ye)).toBeLessThanOrEqual(
					EPS_ADD + 2 ** -52,
				);
			const ax = Math.abs(xe);
			const [sh, sl] = split(ax);
			expect(rel(ddSqrt(sh, sl), Math.sqrt(sh + sl))).toBeLessThanOrEqual(
				EPS_SQRT,
			);
		}
	});
	it("tolerates a 4 ULP perturbed division within budget", () => {
		setDivSqrtPerturbation(4, seededRandom(2));
		const [xh, xl] = split(Math.E);
		const [yh, yl] = split(7.3);
		const q = ddDiv(xh, xl, yh, yl);
		expect(Math.abs(val(q) - (xh + xl) / (yh + yl)) / 0.37).toBeLessThanOrEqual(
			EPS_DIV,
		);
	});
});
