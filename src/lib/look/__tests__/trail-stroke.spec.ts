// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import {
	GLOW_CORE_WHITEN,
	GLOW_HALO,
	GLOW_REACH,
	PENCIL_ALONG_M,
	PENCIL_GRAIN,
	PENCIL_JITTER,
	PENCIL_MIN_AA,
	PENCIL_VARIATION,
	strokeCoverage,
	strokeKind,
	strokePadPx,
	TRAIL_STROKE_GLSL,
	TRAIL_STROKE_MODE,
	TRAIL_STROKE_WGSL,
} from "../trail-stroke";

describe("strokeKind", () => {
	it("maps unknown or missing values to solid", () => {
		expect(strokeKind("pencil")).toBe("pencil");
		expect(strokeKind("glow")).toBe("glow");
		for (const v of [undefined, "", "solid", "neon", "PENCIL"])
			expect(strokeKind(v)).toBe("solid");
	});
	it("shader modes are 0, 1, 2 in a fixed order", () => {
		expect(TRAIL_STROKE_MODE).toEqual({ solid: 0, pencil: 1, glow: 2 });
	});
});

describe("strokePadPx", () => {
	it("is 0 for solid and grows with width for pencil and glow", () => {
		expect(strokePadPx("solid", 10)).toBe(0);
		for (const k of ["pencil", "glow"] as const) {
			expect(strokePadPx(k, 4)).toBeGreaterThan(0);
			expect(strokePadPx(k, 8)).toBeGreaterThan(strokePadPx(k, 4));
		}
	});
	it("the quad is wide enough for the halo to fade out (glow) and the jitter (pencil)", () => {
		const w = 6;
		const pad = strokePadPx("glow", w);
		// halo alpha at the quad edge is already below 1 %
		const at = strokeCoverage("glow", w / 2 + pad, 0, w).coverage;
		expect(at).toBeLessThan(0.01);
		const padP = strokePadPx("pencil", w);
		expect(padP).toBeGreaterThan(PENCIL_JITTER * w + w * 0.075);
	});
});

describe("strokeCoverage", () => {
	it("solid is fully covered with no core", () => {
		expect(strokeCoverage("solid", 3, 100, 4)).toEqual({
			coverage: 1,
			core: 0,
		});
	});
	it("glow: opaque core on the centre line, a Gaussian halo outside, symmetric", () => {
		const w = 4;
		const c = strokeCoverage("glow", 0, 0, w);
		expect(c.core).toBe(1);
		expect(c.coverage).toBe(1);
		const edge = strokeCoverage("glow", w / 2 + 0.6, 0, w);
		expect(edge.core).toBe(0);
		expect(edge.coverage).toBeLessThan(GLOW_HALO + 1e-12);
		expect(edge.coverage).toBeGreaterThan(0.2);
		expect(strokeCoverage("glow", -3, 0, w).coverage).toBeCloseTo(
			strokeCoverage("glow", 3, 0, w).coverage,
			12,
		);
		// monotone decay outside the core
		let prev = 1;
		for (let d = w / 2 + 0.6; d < 3 * w; d += 0.25) {
			const v = strokeCoverage("glow", d, 0, w).coverage;
			expect(v).toBeLessThanOrEqual(prev + 1e-12);
			prev = v;
		}
		// halo at one reach beyond the core: GLOW_HALO * exp(-2)
		const w2 = 4;
		expect(
			strokeCoverage("glow", w2 / 2 + w2 * GLOW_REACH, 0, w2).coverage,
		).toBeCloseTo(GLOW_HALO * Math.exp(-2), 6);
		expect(GLOW_CORE_WHITEN).toBeGreaterThan(0);
	});
	it("pencil: covered on the line, empty far away, never above 1 and deterministic along the trail", () => {
		const w = 4;
		let hit = 0;
		for (let along = 0; along < 5000; along += 37) {
			const centre = strokeCoverage("pencil", 0, along, w, 1, 1).coverage;
			expect(centre).toBeLessThanOrEqual(1);
			expect(centre).toBeGreaterThanOrEqual(0);
			if (centre > 0.3) hit++;
			expect(strokeCoverage("pencil", 4 * w, along, w).coverage).toBe(0);
			expect(strokeCoverage("pencil", 0, along, w, 1, 1)).toEqual(
				strokeCoverage("pencil", 0, along, w, 1, 1),
			);
		}
		expect(hit).toBeGreaterThan(100 * 0.9);
	});
	it("pencil grain fade 0 removes the paper texture", () => {
		let reduced = 0;
		for (let along = 0; along < 3000; along += 11) {
			const a = strokeCoverage("pencil", 0, along, 4, 1, 0).coverage;
			const b = strokeCoverage("pencil", 0, along, 4, 1, 1).coverage;
			expect(b).toBeLessThanOrEqual(a + 1e-12);
			if (b < a - 1e-6) reduced++;
		}
		expect(reduced).toBeGreaterThan(0);
	});
});

describe("shader twins", () => {
	it("GLSL and WGSL carry the same constants as the TS reference", () => {
		for (const v of [
			PENCIL_ALONG_M,
			PENCIL_JITTER,
			PENCIL_VARIATION,
			PENCIL_GRAIN,
			PENCIL_MIN_AA,
			GLOW_REACH,
			GLOW_HALO,
		]) {
			const s = v.toFixed(4);
			expect(TRAIL_STROKE_GLSL, s).toContain(s);
			expect(TRAIL_STROKE_WGSL, s).toContain(s);
		}
	});
	it("declare their entry points", () => {
		expect(TRAIL_STROKE_GLSL).toContain("float trailStroke(");
		expect(TRAIL_STROKE_WGSL).toContain("fn trail_stroke(");
	});
});
