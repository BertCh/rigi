// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { expectArrayClose } from "#/test/helpers";
import {
	deckCompositeStyle,
	deckElevRange,
	deckWorldStyle,
	rampU,
	rawColor,
	rgba255,
	TRAIL_CLASSES,
	trailClass,
	trailPalette,
} from "../deck-apply";
import { CLASSIC } from "../defaults";
import { presetStyle } from "../presets";
import { RAMPS, turbo } from "../ramps";

describe("rawColor", () => {
	it("passes float tuples exactly and linearises hex strings", () => {
		expect(rawColor([0.1, 0.2, 0.3])).toEqual([0.1, 0.2, 0.3]);
		expectArrayClose(rawColor("#808080"), [0.21586, 0.21586, 0.21586], 1e-4);
		expect(rawColor("#ffffff")).toEqual([1, 1, 1]);
	});
});

describe("rgba255", () => {
	it("scales alpha and rounds to bytes", () => {
		expect(rgba255("#ff8000")).toEqual([255, 128, 0, 255]);
		expect(rgba255("#ffffff", 0.5)).toEqual([255, 255, 255, 128]);
		expect(rgba255([1, 1, 1, 0.5], 0.5)).toEqual([255, 255, 255, 64]);
	});
});

describe("rampU", () => {
	it("packs a stop ramp into three-column-major blocks", () => {
		const u = rampU("cool");
		expect(u.n).toBe(5);
		expect(u.c0).toHaveLength(16);
		expect(u.c1).toHaveLength(16);
		expect(u.de).toHaveLength(16);
		expectArrayClose(u.c0.slice(0, 4), [0.1, 0.85, 0.8, 0]);
		expectArrayClose(u.c0.slice(4, 8), [0.3, 0.55, 1, 0.25]);
		// stop 4 = last; slots beyond n repeat the last stop
		expectArrayClose(u.c1.slice(0, 4), [1, 0.95, 0.85, 1]);
		expectArrayClose(u.c1.slice(12, 16), [1, 0.95, 0.85, 1]);
	});
	it("segment divisors are the t-gaps; smooth flags follow ease", () => {
		const u = rampU("hypso-classic");
		const D = u.de.slice(0, 8);
		const E = u.de.slice(8, 16);
		expect(D[0]).toBe(1);
		expect(D[1]).toBeCloseTo(0.25, 12);
		expect(D[4]).toBeCloseTo(0.13, 12);
		expect(E.slice(0, 5)).toEqual([0, 0, 0, 0, 1]);
		expect(E.slice(5)).toEqual([0, 0, 0]);
		// out-of-range slots get the neutral divisor 1
		expect(D.slice(5)).toEqual([1, 1, 1]);
	});
	it("turbo is sampled at 8 even stops", () => {
		const u = rampU("turbo");
		expect(u.n).toBe(8);
		expectArrayClose(u.c1.slice(12, 16), [...turbo(1), 1]);
		expectArrayClose(u.c0.slice(4, 8), [...turbo(1 / 7), 1 / 7]);
	});
	it("every named ramp packs without NaN", () => {
		for (const name of Object.keys(RAMPS) as (keyof typeof RAMPS)[]) {
			const u = rampU(name);
			expect([...u.c0, ...u.c1, ...u.de].every(Number.isFinite), name).toBe(
				true,
			);
			expect(u.n).toBeGreaterThanOrEqual(2);
			expect(u.n).toBeLessThanOrEqual(8);
		}
	});
});

describe("deckElevRange", () => {
	it("is the local range in local mode", () => {
		expect(deckElevRange(CLASSIC, [500, 2500])).toEqual([500, 2500]);
		expect(deckElevRange(CLASSIC, null)).toBeNull();
	});
	it("is the style's range in absolute mode and never degenerate", () => {
		const abs = (lo: number, hi: number) => ({
			...CLASSIC,
			terrain: {
				...CLASSIC.terrain,
				rampRange: { mode: "absolute" as const, lo, hi },
			},
		});
		expect(deckElevRange(abs(400, 3500), [1, 2])).toEqual([400, 3500]);
		expect(deckElevRange(abs(1000, 1000), null)).toEqual([1000, 1001]);
		expect(deckElevRange(abs(1000, 900), null)).toEqual([1000, 1001]);
	});
});

describe("trailClass / trailPalette", () => {
	it("maps the SAC scale to the four classes", () => {
		expect(trailClass("hiking")).toBe(0);
		expect(trailClass("mountain_hiking")).toBe(1);
		expect(trailClass("demanding_mountain_hiking")).toBe(1);
		expect(trailClass("alpine_hiking")).toBe(2);
		expect(trailClass("demanding_alpine_hiking")).toBe(2);
		expect(trailClass("difficult_alpine_hiking")).toBe(2);
		for (const other of [null, undefined, "", "path", "casual"])
			expect(trailClass(other)).toBe(3);
	});
	it("palette has one linear colour per class, indexed by trailClass", () => {
		const pal = trailPalette(CLASSIC);
		expect(pal).toHaveLength(TRAIL_CLASSES.length);
		// classic trail colours are float tuples, passed through exactly
		expect(pal[0]).toEqual([1, 0.82, 0.25]);
		expect(pal[trailClass("alpine_hiking")]).toEqual([0.3, 0.67, 0.97]);
		expect(pal[3]).toEqual([1, 1, 1]);
	});
});

describe("deckCompositeStyle", () => {
	it("classic: turbo depth tint swaps in viridis stops with kind 0", () => {
		const c = deckCompositeStyle(CLASSIC);
		expect(c.depthRampKind).toBe(0);
		expect(c.ridgeInner).toEqual([1, 0.95, 0.85]);
		expect(c.ridgeGainO).toBe(0.9);
		expect(c.ridgeGainR).toBe(0.5);
		expect(c.ridgeSketch).toBe(0);
		expect(c.depthLuma).toEqual([0.35, 0.65]);
	});
	it("depthLog is (ln near, 1/(ln far - ln near)) in float32", () => {
		const c = deckCompositeStyle(CLASSIC);
		expect(c.depthLog[0]).toBeCloseTo(Math.log(200), 5);
		expect(c.depthLog[1]).toBeCloseTo(1 / (Math.log(80000) - Math.log(200)), 5);
		expect(c.depthLog[0]).toBe(Math.fround(c.depthLog[0]));
	});
	it("hairline alpha multiplies the colour's own alpha", () => {
		const s = {
			...CLASSIC,
			replace: {
				...CLASSIC.replace,
				hairline: { color: "#ffffff80" as const, alpha: 0.5 },
			},
		};
		expect(deckCompositeStyle(s).hair[3]).toBeCloseTo(0.5 * (128 / 255), 12);
	});
	it("every preset yields finite values", () => {
		for (const id of ["night", "swiss", "berann", "field-sketch"] as const) {
			const c = deckCompositeStyle(presetStyle(id));
			expect(
				Object.values(c)
					.flat(2)
					.every((v) => typeof v !== "number" || Number.isFinite(v)),
				id,
			).toBe(true);
		}
	});
});

describe("deckWorldStyle", () => {
	it("converts the sky to CSS and the frame colours to bytes", () => {
		const w = deckWorldStyle(CLASSIC);
		expect(w.sky).toBe("rgb(169,194,218)");
		expect(w.lineColor).toEqual([255, 255, 255, 230]);
		expect(w.pinColor).toEqual([255, 85, 51, 255]);
		expect(w.pinRadiusM).toBe(18);
		expect(w.planeOpacity).toBe(0.95);
	});
});
