// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { intrinsicsFromPose } from "../../geom";
import {
	focalFromFy,
	focalFromVfov,
	intrinsicsFromFocal,
	solveFocalShift,
	solveShiftKnownFocal,
} from "../focal-shift";

/** An affine point map: net xyz = (uv·d/f, d − shift) for camera depths d, so uv = f·x/(z + shift). */
function syntheticPoints(focal: number, shift: number, n = 400) {
	const uv = new Float64Array(2 * n);
	const xyz = new Float64Array(3 * n);
	let seed = 7;
	const rnd = () => {
		seed = (seed * 1664525 + 1013904223) >>> 0;
		return seed / 2 ** 32;
	};
	for (let k = 0; k < n; k++) {
		const u = (rnd() - 0.5) * 1.2;
		const v = (rnd() - 0.5) * 0.9;
		const d = 3 + rnd() * 20;
		uv[2 * k] = u;
		uv[2 * k + 1] = v;
		xyz[3 * k] = (u * d) / focal;
		xyz[3 * k + 1] = (v * d) / focal;
		xyz[3 * k + 2] = d - shift;
	}
	return { uv, xyz, n };
}

describe("solveShiftKnownFocal", () => {
	it("recovers the shift for the true focal", () => {
		const { uv, xyz, n } = syntheticPoints(1.3, 1.7);
		const r = solveShiftKnownFocal(uv, xyz, n, 1.3);
		expect(r.focal).toBe(1.3);
		expect(r.shift).toBeCloseTo(1.7, 6);
	});

	it("agrees with the free solve when the known focal is the free solution", () => {
		const { uv, xyz, n } = syntheticPoints(0.9, -0.4);
		const free = solveFocalShift(uv, xyz, n);
		const fixed = solveShiftKnownFocal(uv, xyz, n, free.focal);
		expect(fixed.shift).toBeCloseTo(free.shift, 5);
	});

	it("stays finite and never crosses the pole for a wrong focal", () => {
		const { uv, xyz, n } = syntheticPoints(1.3, 1.7);
		for (const f of [1.1, 1.3 * 1.1, 2]) {
			const r = solveShiftKnownFocal(uv, xyz, n, f);
			expect(Number.isFinite(r.shift)).toBe(true);
			for (let k = 0; k < n; k++)
				expect(xyz[3 * k + 2] + r.shift).toBeGreaterThan(0);
		}
	});

	it("falls back on degenerate input", () => {
		expect(
			solveShiftKnownFocal(new Float64Array(0), new Float64Array(0), 0, 1.2),
		).toEqual({
			focal: 1.2,
			shift: 0,
		});
	});
});

describe("focal conversions", () => {
	it("focalFromVfov and focalFromFy invert intrinsicsFromFocal / intrinsicsFromPose", () => {
		const vfov = 53.06;
		const [w, h] = [1024, 768];
		const f = focalFromVfov(vfov, w, h);
		const K = intrinsicsFromFocal(f, w, h);
		const fromPose = intrinsicsFromPose({ vfov } as never, w / h);
		expect(K.fy).toBeCloseTo(fromPose.fy, 9);
		expect(K.fx).toBeCloseTo(fromPose.fx, 9);
		expect(focalFromFy(fromPose.fy, w, h)).toBeCloseTo(f, 9);
	});
});
