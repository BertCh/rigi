// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { fft, ifft } from "../fft";
import {
	fourStepForward,
	fourStepInverse,
	permutedIndex,
	planFourStep,
	twiddleTable,
} from "../fourstep";

/** Deterministic LCG in [-1, 1). */
function rng(seed: number) {
	let s = seed >>> 0;
	return () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		return (s / 2 ** 32) * 2 - 1;
	};
}

describe("planFourStep", () => {
	it("splits M = N1·N2 with N2 ≤ 2048", () => {
		expect(planFourStep(8192)).toEqual({ M: 8192, N1: 4, N2: 2048 });
		expect(planFourStep(2048)).toEqual({ M: 2048, N1: 1, N2: 2048 });
		expect(planFourStep(512)).toEqual({ M: 512, N1: 1, N2: 512 });
		expect(planFourStep(2048 * 2048)?.N1).toBe(2048);
	});
	it("refuses non powers of two and sizes beyond 2048²", () => {
		expect(planFourStep(3000)).toBeNull();
		expect(planFourStep(1)).toBeNull();
		expect(planFourStep(2 ** 23)).toBeNull();
	});
});

describe("four-step FFT index mapping (CPU emulation)", () => {
	for (const M of [512, 2048, 8192, 16384]) {
		it(`forward equals fft.ts at M=${M}, permuted order`, () => {
			const plan = planFourStep(M);
			if (!plan) throw new Error("plan");
			const r = rng(M);
			const x = Float64Array.from({ length: M }, r);
			const ref = { re: Float64Array.from(x), im: new Float64Array(M) };
			fft(ref.re, ref.im);
			const got = fourStepForward(x, plan);
			let worst = 0;
			for (let k = 0; k < M; k++) {
				const j = permutedIndex(k, plan);
				worst = Math.max(
					worst,
					Math.abs(got.re[j] - ref.re[k]),
					Math.abs(got.im[j] - ref.im[k]),
				);
			}
			expect(worst).toBeLessThan(1e-9);
		});
		it(`inverse equals ifft at M=${M} (scale 1/M)`, () => {
			const plan = planFourStep(M);
			if (!plan) throw new Error("plan");
			const r = rng(M + 1);
			const nat = {
				re: Float64Array.from({ length: M }, r),
				im: Float64Array.from({ length: M }, r),
			};
			const perm = { re: new Float64Array(M), im: new Float64Array(M) };
			for (let k = 0; k < M; k++) {
				perm.re[permutedIndex(k, plan)] = nat.re[k];
				perm.im[permutedIndex(k, plan)] = nat.im[k];
			}
			const ref = {
				re: Float64Array.from(nat.re),
				im: Float64Array.from(nat.im),
			};
			ifft(ref.re, ref.im);
			const got = fourStepInverse(perm, plan);
			let worst = 0;
			for (let n = 0; n < M; n++)
				worst = Math.max(
					worst,
					Math.abs(got.re[n] - ref.re[n]),
					Math.abs(got.im[n] - ref.im[n]),
				);
			expect(worst).toBeLessThan(1e-9);
		});
	}
});

describe("twiddleTable", () => {
	it("is e^(-2πi j/M) in float32", () => {
		const M = 8192;
		const t = twiddleTable(M);
		expect(t).toHaveLength(2 * M);
		for (const j of [0, 1, 1000, 2048, 8191]) {
			expect(t[2 * j]).toBeCloseTo(Math.cos((2 * Math.PI * j) / M), 6);
			expect(t[2 * j + 1]).toBeCloseTo(-Math.sin((2 * Math.PI * j) / M), 6);
		}
	});
});
