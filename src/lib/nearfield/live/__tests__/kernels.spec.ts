// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import {
	DEPTH_WGSL,
	LIFT_WGSL,
	LIVE_MAX_KNOTS,
	LIVE_PRM,
	packLiveCurve,
} from "../kernels";

/** Field names of `struct Prm { … };` in WGSL order. */
function structFields(wgsl: string): string[] {
	const body = /struct Prm \{([\s\S]*?)\};/.exec(wgsl)?.[1] ?? "";
	return [...body.matchAll(/(\w+):\s*(?:u32|f32)/g)].map((m) => m[1]);
}

describe("live kernels", () => {
	it("the uniform block mirrors the WGSL Prm struct field for field", () => {
		const fields = structFields(LIFT_WGSL);
		expect(fields.length).toBeGreaterThan(40);
		expect(structFields(DEPTH_WGSL)).toEqual(fields);
		const offsets = fields.map((f) => LIVE_PRM.offsetOf(f as never));
		// all scalars: each field one word after the previous, in WGSL order
		const step = offsets[1] - offsets[0];
		for (let i = 1; i < offsets.length; i++)
			expect(offsets[i] - offsets[i - 1]).toBe(step);
	});

	it("packs the curve knots and thins long curves keeping both ends", () => {
		const { words, n } = packLiveCurve({ x: [1, 2, 3], y: [10, 20, 30] });
		expect(n).toBe(3);
		expect(Array.from(words.slice(0, 6))).toEqual([1, 10, 2, 20, 3, 30]);
		const x = Array.from({ length: 40 }, (_, i) => i);
		const thin = packLiveCurve({ x, y: x.map((v) => 2 * v) });
		expect(thin.n).toBe(LIVE_MAX_KNOTS);
		expect(thin.words[0]).toBe(0);
		expect(thin.words[2 * (LIVE_MAX_KNOTS - 1)]).toBe(39);
		expect(packLiveCurve(undefined).n).toBe(0);
	});
});
