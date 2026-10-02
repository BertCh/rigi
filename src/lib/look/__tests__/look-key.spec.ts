// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { CLASSIC } from "#/lib/style/defaults";
import { LOOK_PRESETS, PRESET_IDS, presetStyle } from "#/lib/style/presets";
import { mergeStyle } from "#/lib/style/schema";
import type { DeepPartial, ViewStyle } from "#/lib/style/types";
import {
	lookKey,
	needsPhotoSky,
	terrainDefines,
	withSlopeLayer,
} from "../look-key";

const style = (p: DeepPartial<ViewStyle>) => mergeStyle(CLASSIC, p);

describe("lookKey", () => {
	it("classic needs no defines (shader sources stay byte-identical)", () => {
		expect(lookKey(CLASSIC)).toEqual([]);
		expect(lookKey(CLASSIC).join()).toBe("");
	});
	it("each feature toggles exactly its own define", () => {
		expect(
			lookKey(style({ terrain: { albedo: { mode: "alpine", water: false } } })),
		).toEqual(["LOOK_ALPINE"]);
		expect(
			lookKey(style({ terrain: { albedo: { mode: "alpine", water: true } } })),
		).toEqual(["LOOK_ALPINE", "LOOK_WATER"]);
		expect(
			lookKey(style({ terrain: { atmosphere: { mode: "physical" } } })),
		).toEqual(["LOOK_ATMOSPHERE"]);
		expect(lookKey(style({ composite: { refine: true } }))).toEqual([
			"LOOK_REFINE",
		]);
		expect(lookKey(style({ composite: { ridges: "ink" } }))).toEqual([
			"LOOK_INK",
		]);
		expect(lookKey(style({ composite: { output: "neutral" } }))).toEqual([
			"LOOK_OUTPUT",
		]);
		expect(lookKey(style({ composite: { harmonize: 0.5 } }))).toEqual([
			"LOOK_HARMONIZE",
		]);
		expect(lookKey(style({ world: { drapeHarmonize: 0.5 } }))).toEqual([
			"LOOK_HARMONIZE",
		]);
		expect(lookKey(style({ terrain: { relief: { mode: "swiss" } } }))).toEqual([
			"LOOK_RELIEF",
		]);
		expect(
			lookKey(style({ overlay: { contours: { kind: "tanaka" } } })),
		).toEqual(["LOOK_TANAKA"]);
	});
	it("harmonize from both sources yields one define", () => {
		expect(
			lookKey(
				style({ composite: { harmonize: 1 }, world: { drapeHarmonize: 1 } }),
			),
		).toEqual(["LOOK_HARMONIZE"]);
	});
	it("is sorted and duplicate-free for every preset (a stable cache key)", () => {
		for (const id of PRESET_IDS) {
			const k = lookKey(presetStyle(id));
			expect(k, id).toEqual([...new Set(k)].sort());
		}
	});
	it("LOOK_PRESETS are exactly the presets that switch on a look feature", () => {
		for (const id of PRESET_IDS) {
			const on = lookKey(presetStyle(id)).length > 0;
			expect(on, id).toBe((LOOK_PRESETS as readonly string[]).includes(id));
		}
	});
});

describe("terrainDefines", () => {
	it("drops composite-only features", () => {
		const s = style({
			composite: {
				refine: true,
				output: "neutral",
				harmonize: 0.5,
				ridges: "ink",
			},
			terrain: { relief: { mode: "swiss" } },
		});
		expect(lookKey(s)).toEqual([
			"LOOK_HARMONIZE",
			"LOOK_INK",
			"LOOK_OUTPUT",
			"LOOK_REFINE",
			"LOOK_RELIEF",
		]);
		expect(terrainDefines(s)).toEqual(["LOOK_INK", "LOOK_RELIEF"]);
	});
	it("keeps LOOK_HARMONIZE only when the world drape harmonises", () => {
		expect(terrainDefines(style({ composite: { harmonize: 1 } }))).toEqual([]);
		expect(terrainDefines(style({ world: { drapeHarmonize: 1 } }))).toEqual([
			"LOOK_HARMONIZE",
		]);
	});
	it("classic stays empty", () => {
		expect(terrainDefines(CLASSIC)).toEqual([]);
	});
});

describe("withSlopeLayer", () => {
	it("adds LOOK_SLOPE in sorted position only when on, without mutating", () => {
		const base = lookKey(presetStyle("swiss"));
		const copy = [...base];
		const on = withSlopeLayer(base, true);
		expect(on).toContain("LOOK_SLOPE");
		expect(on).toEqual([...on].sort());
		expect(base).toEqual(copy);
		expect(withSlopeLayer(base, false)).toBe(base);
	});
});

describe("needsPhotoSky", () => {
	it("never for classic; yes for fitted airlight, photo sky or refine", () => {
		expect(needsPhotoSky(CLASSIC)).toBe(false);
		expect(
			needsPhotoSky(
				style({
					terrain: { atmosphere: { mode: "physical", airlight: "fitted" } },
				}),
			),
		).toBe(true);
		expect(
			needsPhotoSky(
				style({
					terrain: { atmosphere: { mode: "physical", airlight: "physical" } },
				}),
			),
		).toBe(false);
		expect(needsPhotoSky(style({ composite: { sky: "photo" } }))).toBe(true);
		expect(needsPhotoSky(style({ composite: { refine: true } }))).toBe(true);
	});
});
