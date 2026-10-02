// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { CLASSIC } from "../defaults";
import {
	isPresetId,
	LOOK_PRESETS,
	PRESET_IDS,
	PRESET_LABELS,
	PRESET_MAP_LAYERS,
	PRESET_OVERLAY_LAYER,
	PRESETS,
	presetStyle,
	resolveStyle,
	stateFromStyle,
} from "../presets";
import { diffStyle, pruneOverrides, validateStyle } from "../schema";

describe("preset tables", () => {
	it("ids, labels and definitions cover the same set, without duplicates", () => {
		expect(new Set(PRESET_IDS).size).toBe(PRESET_IDS.length);
		expect(Object.keys(PRESET_LABELS).sort()).toEqual([...PRESET_IDS].sort());
		expect(Object.keys(PRESETS).sort()).toEqual([...PRESET_IDS].sort());
		for (const id of PRESET_IDS)
			expect(PRESET_LABELS[id].length).toBeGreaterThan(0);
		expect(new Set(Object.values(PRESET_LABELS)).size).toBe(PRESET_IDS.length);
	});
	it("secondary tables only mention real presets", () => {
		for (const id of LOOK_PRESETS) expect(isPresetId(id)).toBe(true);
		for (const id of Object.keys(PRESET_OVERLAY_LAYER))
			expect(isPresetId(id)).toBe(true);
		for (const id of Object.keys(PRESET_MAP_LAYERS))
			expect(isPresetId(id)).toBe(true);
		expect(LOOK_PRESETS).not.toContain("classic");
	});
	it("isPresetId accepts only listed ids", () => {
		for (const id of PRESET_IDS) expect(isPresetId(id)).toBe(true);
		for (const bad of ["Classic", "", "three", 1, null, undefined, "toString"])
			expect(isPresetId(bad)).toBe(false);
	});
});

describe("preset contents", () => {
	it("classic adds nothing", () => {
		expect(PRESETS.classic).toEqual({});
		expect(presetStyle("classic")).toBe(CLASSIC);
	});
	it("every preset is fully valid: pruning loses nothing, resolving is a valid style", () => {
		for (const id of PRESET_IDS) {
			expect(pruneOverrides(PRESETS[id]), id).toEqual(
				pruneOverrides(pruneOverrides(PRESETS[id])),
			);
			// nothing the preset names may be rejected or clamped by the schema
			const partial = PRESETS[id];
			const kept = pruneOverrides(partial);
			expect(JSON.stringify(sortKeys(kept)), id).toBe(
				JSON.stringify(sortKeys(stripV(partial))),
			);
			expect(validateStyle(presetStyle(id)), id).toEqual(presetStyle(id));
		}
	});
	it("non-classic presets actually differ from classic; presets are mutually distinct", () => {
		const seen = new Map<string, string>();
		for (const id of PRESET_IDS) {
			const key = JSON.stringify(presetStyle(id));
			expect(
				seen.get(key),
				`${id} duplicates ${seen.get(key)}`,
			).toBeUndefined();
			seen.set(key, id);
			if (id !== "classic")
				expect(
					Object.keys(diffStyle(CLASSIC, presetStyle(id))).length,
					id,
				).toBeGreaterThan(0);
		}
	});
	it("presetStyle is cached", () => {
		expect(presetStyle("night")).toBe(presetStyle("night"));
	});
});

describe("resolveStyle / stateFromStyle", () => {
	it("no overrides gives the preset itself", () => {
		expect(resolveStyle({ preset: "night", overrides: {} })).toBe(
			presetStyle("night"),
		);
	});
	it("an unknown preset falls back to classic", () => {
		expect(resolveStyle({ preset: "bogus" as never, overrides: {} })).toBe(
			CLASSIC,
		);
	});
	it("overrides win over the preset and survive a preset switch", () => {
		const overrides = { terrain: { ambient: 0.11 } };
		for (const id of ["classic", "night", "swiss"] as const)
			expect(resolveStyle({ preset: id, overrides }).terrain.ambient).toBe(
				0.11,
			);
	});
	it("stateFromStyle stores the diff and drops values equal to the preset", () => {
		const base = presetStyle("night");
		const edited = resolveStyle({
			preset: "night",
			overrides: { terrain: { ambient: 0.11 } },
		});
		const st = stateFromStyle("night", edited);
		expect(st.preset).toBe("night");
		expect(st.overrides).toEqual({ terrain: { ambient: 0.11 } });
		expect(stateFromStyle("night", base).overrides).toEqual({});
		expect(resolveStyle(st)).toEqual(edited);
	});
});

function stripV(o: unknown) {
	const c = structuredClone(o) as Record<string, unknown>;
	delete c.v;
	return c;
}
function sortKeys(v: unknown): unknown {
	if (Array.isArray(v)) return v.map(sortKeys);
	if (v && typeof v === "object")
		return Object.fromEntries(
			Object.entries(v as object)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([k, x]) => [k, sortKeys(x)]),
		);
	return v;
}
