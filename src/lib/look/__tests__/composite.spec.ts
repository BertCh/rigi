// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { CLASSIC } from "#/lib/style/defaults";
import { presetStyle } from "#/lib/style/presets";
import { mergeStyle } from "#/lib/style/schema";
import type { DeepPartial, ViewStyle } from "#/lib/style/types";
import { expectArrayClose } from "#/test/helpers";
import { N_BANDS, reduceBands } from "../color-stats";
import {
	blendCut,
	blendCutKey,
	compositeValues,
	gridSize,
	harmonizeValues,
	trustedRange,
} from "../composite";

describe("gridSize", () => {
	it("puts the long side on the long edge and keeps the aspect", () => {
		expect(gridSize(2, 512)).toEqual([512, 256]);
		expect(gridSize(1, 256)).toEqual([256, 256]);
		expect(gridSize(0.5, 512)).toEqual([256, 512]);
	});
	it("never collapses to zero", () => {
		expect(gridSize(1000, 256)).toEqual([256, 1]);
		expect(gridSize(0.001, 256)).toEqual([1, 256]);
	});
});

describe("trustedRange", () => {
	it("is 25 × the GPS accuracy, clamped to 150..500 m", () => {
		expect(trustedRange(10)).toBe(250);
		expect(trustedRange(1)).toBe(150);
		expect(trustedRange(100)).toBe(500);
	});
	it("assumes 20 m when unknown", () => {
		expect(trustedRange(null)).toBe(500);
		expect(trustedRange(undefined)).toBe(500);
	});
});

describe("blendCut", () => {
	const canvas = {} as HTMLCanvasElement;
	const range = (rangeKm: number, feather: number) => ({
		method: "range",
		rangeKm,
		feather,
	});
	it("keys: range encodes its parameters, brush its version, others are empty", () => {
		expect(blendCutKey(range(3, 0.2), 9)).toBe("range:3:0.2");
		expect(blendCutKey({ method: "brush", rangeKm: 3, feather: 0.2 }, 9)).toBe(
			"brush:9",
		);
		expect(blendCutKey({ method: "swipe", rangeKm: 3, feather: 0.2 }, 9)).toBe(
			"",
		);
	});
	it("swipe and lens have no cut", () => {
		expect(
			blendCut({ method: "swipe", rangeKm: 1, feather: 0.1 }, canvas, 0),
		).toBeNull();
		expect(
			blendCut({ method: "lens", rangeKm: 1, feather: 0.1 }, canvas, 0),
		).toBeNull();
	});
	it("a range cut is a smooth 0 -> 1 band around the range, 1 for sky", () => {
		const cut = blendCut(range(2, 0.1), canvas, 0);
		expect(cut?.key).toBe("range:2:0.1");
		const at = (r: number) => cut?.at(0, 0, r) ?? Number.NaN;
		expect(at(100)).toBe(0);
		expect(at(2000)).toBeCloseTo(0.5, 12);
		expect(at(50000)).toBe(1);
		// no range (0 or negative) counts as far away
		expect(at(0)).toBe(1);
		expect(at(-1)).toBe(1);
		let prev = -1;
		for (let r = 500; r <= 4000; r += 50) {
			expect(at(r)).toBeGreaterThanOrEqual(prev);
			prev = at(r);
		}
	});
	it("a zero feather still has a (tiny) transition instead of dividing by zero", () => {
		const cut = blendCut(range(2, 0), canvas, 0);
		for (const r of [1000, 1999, 2000, 2001, 3000])
			expect(Number.isFinite(cut?.at(0, 0, r))).toBe(true);
	});
	it("a brush cut reads the red channel of the canvas by uv", () => {
		const w = 4;
		const h = 2;
		const px = new Uint8ClampedArray(w * h * 4);
		for (let i = 0; i < w * h; i++) px[i * 4] = i * 30;
		const brush = {
			width: w,
			height: h,
			getContext: () => ({ getImageData: () => ({ data: px }) }),
		} as unknown as HTMLCanvasElement;
		const cut = blendCut({ method: "brush", rangeKm: 1, feather: 0 }, brush, 3);
		expect(cut?.key).toBe("brush:3");
		expect(cut?.at(0, 0, 0)).toBe(0);
		expect(cut?.at(0.99, 0, 0)).toBeCloseTo(90 / 255, 12);
		expect(cut?.at(0, 0.99, 0)).toBeCloseTo(120 / 255, 12);
		// uv = 1 clamps to the last texel
		expect(cut?.at(1, 1, 0)).toBeCloseTo(210 / 255, 12);
	});
});

describe("compositeValues", () => {
	const opts = {
		outW: 2800,
		outH: 1400,
		refine: true,
		cut: true,
		crease: true,
		premul: false,
		noise: 0.02,
		photoW: 5600,
	};
	const neutral = (p: DeepPartial<ViewStyle> = {}): ViewStyle =>
		mergeStyle(CLASSIC, { composite: { output: "neutral" } }, p);

	it("switches refine / cut / premul / crease flags", () => {
		const v = compositeValues(CLASSIC, opts);
		expect([v.refine, v.cut, v.premul]).toEqual([1, 1, 0]);
		const off = compositeValues(CLASSIC, {
			...opts,
			refine: false,
			premul: true,
			crease: false,
		});
		expect([off.refine, off.cut, off.premul]).toEqual([0, 0, 1]);
		expect(off.inkCrease).toBe(0);
	});
	it("scales ink width past 1400 px output only", () => {
		expect(compositeValues(CLASSIC, { ...opts, outW: 700 }).inkWidth).toBe(
			CLASSIC.composite.ink.width,
		);
		expect(
			compositeValues(CLASSIC, { ...opts, outW: 2800 }).inkWidth,
		).toBeCloseTo(2 * CLASSIC.composite.ink.width, 12);
	});
	it("clamps the ink fade to the visibility range and doubles it for dark ink", () => {
		const f = (visibility: number | undefined, s = CLASSIC) =>
			compositeValues(s, { ...opts, visibility }).inkFade;
		expect(f(undefined)).toBe(60000);
		expect(f(1000)).toBe(25000);
		expect(f(1e7)).toBe(150000);
		const darkInk = mergeStyle(CLASSIC, {
			composite: { ink: { inner: [0, 0, 0] } },
		} as DeepPartial<ViewStyle>);
		expect(f(40000, darkInk)).toBe(80000);
	});
	it("grain only for neutral output, reduced by photo minification", () => {
		expect(compositeValues(CLASSIC, opts).grain).toBe(0);
		expect(compositeValues(neutral(), opts).grain).toBeCloseTo(0.01, 12);
		// the photo is smaller than the output: no amplification
		expect(
			compositeValues(neutral(), { ...opts, photoW: 1400 }).grain,
		).toBeCloseTo(0.02, 12);
	});
	it("linearises hex ink colours, passes float tuples through", () => {
		expect(compositeValues(CLASSIC, opts).inkInner).toEqual(
			CLASSIC.composite.ink.inner,
		);
		const hex = mergeStyle(CLASSIC, {
			composite: { ink: { inner: "#ffffff" } },
		} as DeepPartial<ViewStyle>);
		expectArrayClose(compositeValues(hex, opts).inkInner, [1, 1, 1], 1e-9);
	});
	it("works for every look preset", () => {
		for (const id of ["swiss", "photo-matched", "terroir"] as const) {
			const v = compositeValues(presetStyle(id), opts);
			expect(Object.values(v).flat().every(Number.isFinite), id).toBe(true);
		}
	});
});

describe("harmonizeValues", () => {
	it("is the identity block without valid stats or amount", () => {
		for (const [stats, amount] of [
			[null, 1],
			[{ ...reduceBands(new Float32Array(40), new Float32Array(40), 10) }, 1],
		] as const) {
			const v = harmonizeValues(stats, amount);
			expect(v.amount).toBe(0);
			expect(v.pm.every((x) => x === 0)).toBe(true);
			expect(v.ps.filter((_, i) => i % 4 !== 3).every((x) => x === 1)).toBe(
				true,
			);
		}
	});
	it("packs band statistics one band per mat4 column with w = 0", () => {
		const n = 200;
		const a = new Float32Array(n * 4);
		const b = new Float32Array(n * 4);
		for (let band = 0; band < N_BANDS; band++)
			for (let i = 0; i < 50; i++) {
				const o = (band * 50 + i) * 4;
				a.set(
					[
						0.1 * (band + 1),
						0.01 * band,
						-0.01 * band,
						Math.log10([500, 3000, 10000, 50000][band]),
					],
					o,
				);
				b.set([0.05 * (band + 1), 0, 0, 1], o);
			}
		const stats = reduceBands(a, b, n, 10);
		expect(stats.valid).toBe(true);
		const v = harmonizeValues(stats, 0.7);
		expect(v.amount).toBe(0.7);
		expect(v.chroma).toBe(0.6);
		expect(v.pm).toHaveLength(16);
		for (let band = 0; band < N_BANDS; band++) {
			expect(v.pm[band * 4]).toBeCloseTo(0.1 * (band + 1), 5);
			expect(v.lm[band * 4]).toBeCloseTo(0.05 * (band + 1), 5);
			expect(v.pm[band * 4 + 3]).toBe(0);
		}
	});
	it("amount 0 turns valid stats off", () => {
		const v = harmonizeValues(
			{
				...reduceBands(new Float32Array(4), new Float32Array(4), 0),
				valid: true,
			},
			0,
		);
		expect(v.amount).toBe(0);
	});
});
