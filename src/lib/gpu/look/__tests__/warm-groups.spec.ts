// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// CR-27 / CR-37: the look warm-up groups. The default group ("look", what warmLook's ungrouped
// call compiles) must never hold a subgroup kernel, and each kernel is defined once.
import { describe, expect, it } from "vitest";
import { definedKernels } from "#/lib/gpu/core/kernel";
import { K_BAND_STATS_SG, LOOK_SUBGROUP_GROUP } from "../color-stats";
import { LOOK_GROUP } from "../kernel";
import "../haze";
import "../textures";

describe("look warm-up groups", () => {
	it("keeps subgroup kernels out of the default look group", () => {
		const plain = definedKernels(LOOK_GROUP);
		expect(plain.length).toBeGreaterThan(0);
		expect(plain).not.toContain(K_BAND_STATS_SG);
		expect(plain.some((s) => /-sg$/.test(s.label))).toBe(false);
		expect(definedKernels(LOOK_SUBGROUP_GROUP)).toContain(K_BAND_STATS_SG);
	});

	it("defines each look kernel label once", () => {
		const labels = definedKernels()
			.filter((s) => s.label.startsWith("look-"))
			.map((s) => s.label);
		expect(new Set(labels).size).toBe(labels.length);
	});

	it("defines each look kernel id once (textures.ts shares the array-path specs)", () => {
		const ids = definedKernels()
			.filter((s) => s.label.startsWith("look-"))
			.map((s) => s.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("keeps texture subgroup kernels out of the texture group", () => {
		const tex = definedKernels("look-tex");
		expect(tex.length).toBeGreaterThan(0);
		expect(tex.some((s) => /-sg$/.test(s.label))).toBe(false);
	});
});
