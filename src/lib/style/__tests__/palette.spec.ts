// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { ALPINE_FNS } from "../../look/glsl/ramps";
import { CONTOUR_INK } from "../../terroir/classes";
import { HATCH_LK_INK } from "../../terroir/hatch-lk";
import { nameType } from "../../terroir/labels/names";
import { SWISSTOPO_WATER } from "../../terroir/labels/swisstopo";
import { CLASSIC } from "../defaults";
import {
	ALPINE_TINT,
	alpineBaseBody,
	CLASSIC_HAZE,
	CONTOUR_BROWN,
	COVER_INK,
	hexToBytes,
	shaderFloat,
	WARM_INK,
	WORLD_SKY,
} from "../palette";
import {
	PRESET_IDS,
	PRESET_INFO,
	PRESET_MAP_LAYERS,
	PRESET_OVERLAY_LAYER,
	presetIdFrom,
	presetStyle,
} from "../presets";
import { RAMPS } from "../ramps";
import { parseStoredState, urlPreset } from "../store";

describe("palette tokens", () => {
	it("hexToBytes reads #rrggbb (and ignores an alpha pair)", () => {
		expect(hexToBytes("#2b2724")).toEqual([43, 39, 36]);
		expect(hexToBytes("#3f7fb3cc")).toEqual([63, 127, 179]);
	});

	it("shaderFloat always writes a decimal point", () => {
		expect(shaderFloat(1)).toBe("1.0");
		expect(shaderFloat(900)).toBe("900.0");
		expect(shaderFloat(0.4)).toBe("0.4");
		expect(shaderFloat(-2)).toBe("-2.0");
	});

	it("contour inks and hachure inks are one source", () => {
		expect(CONTOUR_INK).toBe(COVER_INK);
		expect(HATCH_LK_INK.ROCK).toEqual(hexToBytes(COVER_INK.rock));
		expect(HATCH_LK_INK.ICE).toEqual(hexToBytes(COVER_INK.ice));
		expect(COVER_INK.soil).toBe(CONTOUR_BROWN.major);
	});

	it("CLASSIC's sky and haze are the palette's classic tokens", () => {
		expect(CLASSIC.world.sky.background).toBe(WORLD_SKY);
		expect(CLASSIC.terrain.hazeColor).toBe(CLASSIC_HAZE);
	});
});

describe("Alpine tint", () => {
	it("the patterson ramp uses the shader belt colours", () => {
		const ramp = RAMPS.patterson;
		if (ramp.kind !== "stops") throw new Error("patterson is a stop ramp");
		const belts = ALPINE_TINT.belts.map((b) => b.c);
		for (const stop of ramp.stops)
			expect(belts.some((c) => c === stop.c)).toBe(true);
	});

	it("emits one declaration per belt and one blend per step in both languages", () => {
		for (const lang of ["glsl", "wgsl"] as const) {
			const body = alpineBaseBody(lang, "srgb");
			for (let i = 0; i < ALPINE_TINT.belts.length; i++)
				expect(body).toContain(`c${i} = srgb(`);
			expect(body.match(/smoothstep/g)).toHaveLength(
				ALPINE_TINT.steps.length + 1,
			);
		}
		expect(alpineBaseBody("wgsl", "srgb")).toContain(
			"vec3<f32>(0.56, 0.66, 0.45)",
		);
	});

	it("the GLSL chunk carries the snow and lake tokens", () => {
		expect(ALPINE_FNS).toContain("rampSrgb(vec3(0.95, 0.97, 1.0))");
		expect(ALPINE_FNS).toContain("rampSrgb(vec3(0.33, 0.5, 0.6))");
	});
});

describe("preset registry", () => {
	it("derives ids, layer switches and labels from PRESET_INFO", () => {
		expect([...PRESET_IDS]).toEqual(Object.keys(PRESET_INFO));
		expect(PRESET_OVERLAY_LAYER).toEqual({ slope: "slope" });
		expect(Object.keys(PRESET_MAP_LAYERS).sort()).toEqual([
			"field-sketch",
			"terroir",
		]);
	});

	it("accepts landeskarte as the swiss preset in the URL and in storage", () => {
		expect(presetIdFrom("landeskarte")).toBe("swiss");
		expect(presetIdFrom("swiss")).toBe("swiss");
		expect(presetIdFrom("toString")).toBeNull();
		expect(urlPreset("?style=landeskarte")).toBe("swiss");
		expect(
			parseStoredState(
				JSON.stringify({ v: 1, preset: "landeskarte", overrides: {} }),
			).preset,
		).toBe("swiss");
	});

	it("the Swiss-look presets share the palette's contour brown and warm ink", () => {
		for (const id of ["swiss", "terroir", "field-sketch"] as const) {
			const s = presetStyle(id);
			expect(s.overlay.contours.color).toEqual({
				mode: "solid",
				...CONTOUR_BROWN,
			});
			expect(s.composite.ink.inner).toEqual(WARM_INK.inner);
			expect(s.composite.ink.skyline).toEqual(WARM_INK.skyline);
		}
	});

	it("field sketch is the terroir layer set with hatching instead of the sun path", () => {
		const t = presetStyle("terroir").terroir;
		const f = presetStyle("field-sketch").terroir;
		expect({ ...f, hatch: t.hatch, sunPath: t.sunPath }).toEqual(t);
		expect(f.hatch && !f.sunPath).toBe(true);
	});
});

describe("name typography", () => {
	it("Landeskarte names take the swisstopo table, the rest the terroir one", () => {
		expect(presetStyle("swiss").terroir.names.typography).toBe("swisstopo");
		expect(presetStyle("terroir").terroir.names.typography).toBe("terroir");
		expect(CLASSIC.terroir.names.typography).toBe("terroir");
		expect(nameType("lake", 12, "swisstopo").color).toBe(SWISSTOPO_WATER);
		expect(nameType("lake", 12).color).not.toBe(SWISSTOPO_WATER);
	});
});
