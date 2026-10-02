// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { groundVars } from "../viz/ground";
import { GIPFELBUCH_PHOTO_IDS } from "../viz/real";

describe("Tafel and figure ground", () => {
	it("resolves the wash and terrain ink for every demo photo", () => {
		for (const id of GIPFELBUCH_PHOTO_IDS) {
			const vars = groundVars(id);
			expect(vars["--fig-wash"], id).toMatch(/^#[0-9a-f]{6}$/i);
			expect(vars["--fig-terrain-ink"], id).toMatch(/^#[0-9a-f]{6}$/i);
		}
	});

	it("is empty for an unknown photo so the CSS fallbacks apply", () => {
		expect(groundVars("demo-99")).toEqual({});
	});
});
