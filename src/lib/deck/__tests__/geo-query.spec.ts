// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { seededRandom } from "#/test/helpers";
import {
	bitsF32,
	cpuOcclusion,
	f32Bits,
	f32Floor,
	OCC_HIDDEN,
	OCC_STRIDE,
	OCC_UNDECIDED,
	OCC_VISIBLE,
	occThreshold,
	occThresholdF32,
	planOcclusion,
	resolveOcclusion,
	sampleState,
	sampleVisible,
	skylineFromRows,
	texelOf,
} from "../geo-query";
import { logRange, skylineRows } from "../geometry-source";

describe("f32 helpers", () => {
	it("round-trips bits", () => {
		for (const x of [0, 1, -2.5, 123456.75, 1e-30]) {
			expect(bitsF32(f32Bits(x))).toBe(Math.fround(x));
		}
		expect(f32Bits(1)).toBe(0x3f800000);
	});

	it("f32Floor is the largest float32 <= x", () => {
		const rnd = seededRandom(7);
		for (let i = 0; i < 300; i++) {
			const x = (rnd() - 0.5) * 1e6;
			const a = f32Floor(x);
			expect(Math.fround(a)).toBe(a);
			expect(a).toBeLessThanOrEqual(x);
			// the next float32 up is above x
			const next = bitsF32(f32Bits(a) + (a >= 0 ? 1 : -1));
			expect(next).toBeGreaterThan(x);
		}
		expect(Number.isNaN(f32Floor(Number.NaN))).toBe(true);
		expect(f32Floor(3)).toBe(3);
	});

	it("occThresholdF32 is finite and clamps", () => {
		expect(occThresholdF32(Number.NaN)).toBeGreaterThan(1e38);
		expect(occThresholdF32(1e300)).toBeLessThan(Number.POSITIVE_INFINITY);
		expect(occThresholdF32(-1e300)).toBeGreaterThan(Number.NEGATIVE_INFINITY);
		expect(occThresholdF32(1000)).toBe(1000);
	});
});

describe("occlusion", () => {
	it("threshold is range*0.97-50", () => {
		expect(occThreshold(1000)).toBeCloseTo(920);
	});

	it("texelOf rejects outside and NaN", () => {
		expect(texelOf(0.5, 0.5, 100, 50)).toEqual({ x: 50, y: 25 });
		expect(texelOf(-0.01, 0.5, 100, 50)).toBeNull();
		expect(texelOf(1, 0.5, 100, 50)).toBeNull();
		expect(texelOf(Number.NaN, 0.5, 100, 50)).toBeNull();
	});

	it("sampleVisible: sky and invalid are visible, near terrain hides", () => {
		expect(sampleVisible(0, 1000)).toBe(true); // sky
		expect(sampleVisible(Number.NaN, 1000)).toBe(true);
		expect(sampleVisible(500, 1000)).toBe(false); // terrain in front of peak
		expect(sampleVisible(990, 1000)).toBe(true); // at the peak
	});

	it("planOcclusion decides outside-buffer peaks on CPU and packs the rest", () => {
		const plan = planOcclusion(
			[{ u: 0.5, v: 0.5, range: 1000 }, null, { u: 2, v: 0.5, range: 1000 }],
			100,
			100,
		);
		expect(plan.decided).toEqual([null, null, true]);
		expect(plan.slots).toEqual([0]);
		expect(plan.words.length).toBe(OCC_STRIDE);
		expect(plan.detail[0].xy.length).toBe(4);
		expect(plan.words[4]).toBe(f32Bits(occThresholdF32(occThreshold(1000))));
	});

	it("sampleState classifies raw bits", () => {
		const a = 920;
		expect(sampleState(f32Bits(-5), a)).toBe(OCC_VISIBLE);
		expect(sampleState(0, a)).toBe(OCC_VISIBLE);
		expect(sampleState(0x7f800000, a)).toBe(OCC_VISIBLE); // inf
		expect(sampleState(1, a)).toBe(OCC_UNDECIDED); // denormal
		expect(sampleState(f32Bits(500), a)).toBe(OCC_HIDDEN);
		expect(sampleState(f32Bits(5000), a)).toBe(OCC_VISIBLE);
	});

	it("GPU decision path agrees with the CPU reference over random buffers", async () => {
		const rnd = seededRandom(11);
		const w = 32;
		const h = 24;
		const buf = new Float32Array(w * h);
		for (let i = 0; i < buf.length; i++)
			buf[i] = rnd() < 0.2 ? 0 : 100 + rnd() * 3000;
		const texel = (x: number, y: number) => buf[y * w + x];
		const peaks = Array.from({ length: 80 }, () => ({
			u: rnd() * 1.1 - 0.05,
			v: rnd() * 1.1 - 0.05,
			range: 200 + rnd() * 3000,
		}));
		const plan = planOcclusion(peaks, w, h);
		const codes = plan.slots.map((slot, s) => {
			const d = plan.detail[s];
			const a = occThresholdF32(d.T);
			let c = 0;
			for (let k = 0; k < 2; k++) {
				const bits = f32Bits(texel(d.xy[k * 2], d.xy[k * 2 + 1]));
				c |= sampleState(bits, a) << (k * 2);
			}
			void slot;
			return c;
		});
		const out = await resolveOcclusion(plan, codes, async () => null);
		peaks.forEach((p, i) => {
			expect(out?.[i]).toBe(cpuOcclusion(p, w, h, texel));
		});
	});

	it("resolveOcclusion fetches undecided samples, fails to null when the gather fails", async () => {
		const plan = planOcclusion([{ u: 0.5, v: 0.5, range: 1000 }], 10, 10);
		const codes = [OCC_UNDECIDED | (OCC_HIDDEN << 2)];
		expect(await resolveOcclusion(plan, codes, async () => null)).toBeNull();
		const hidden = new Float32Array([0, 0, 0, 100, 0, 0, 0, 100]);
		expect(await resolveOcclusion(plan, codes, async () => hidden)).toEqual([
			false,
		]);
		const sky = new Float32Array([0, 0, 0, 0, 0, 0, 0, 100]);
		expect(await resolveOcclusion(plan, codes, async () => sky)).toEqual([
			true,
		]);
	});
});

describe("skyline helpers", () => {
	it("skylineFromRows maps rows to fractions, 1 when none", () => {
		const out = skylineFromRows([0, 5, 10, 20], 10);
		expect(Array.from(out)).toEqual([0, 0.5, 1, 1]);
	});

	it("skylineRows finds the topmost finite row per column", () => {
		const range = new Float32Array([
			Number.POSITIVE_INFINITY,
			5,
			Number.POSITIVE_INFINITY,
			Number.POSITIVE_INFINITY,
			5,
			Number.POSITIVE_INFINITY,
			3,
			5,
			Number.POSITIVE_INFINITY,
		]);
		expect(Array.from(skylineRows({ width: 3, height: 3, range }))).toEqual([
			2, 0, -1,
		]);
	});

	it("logRange maps sky to 13.5", () => {
		expect(logRange(Number.POSITIVE_INFINITY)).toBe(13.5);
		expect(logRange(0)).toBe(13.5);
		expect(logRange(Math.E)).toBeCloseTo(1);
	});
});
