// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { EARTH_R, REFRACTION_K } from "../../geodesy";
import {
	makeTileSharedUniforms,
	REFRACTION_LIFT,
	TILE_GLSL_COMMON,
} from "../material";

describe("makeTileSharedUniforms", () => {
	it("starts with the documented fade and clear ranges and the eye at the origin", () => {
		const u = makeTileSharedUniforms();
		expect(u.fade).toEqual([2200, 3000]);
		expect(u.clear).toEqual([25, 40]);
		expect(u.eye).toEqual([0, 0, 0]);
	});
	it("returns fresh objects each call so sets never share state", () => {
		const a = makeTileSharedUniforms();
		const b = makeTileSharedUniforms();
		a.eye[0] = 5;
		a.fade[1] = 1;
		expect(b.eye).toEqual([0, 0, 0]);
		expect(b.fade).toEqual([2200, 3000]);
	});
});

describe("REFRACTION_LIFT", () => {
	it("is k / 2R: about 1 m of lift at 10 km", () => {
		expect(REFRACTION_LIFT).toBe(REFRACTION_K / (2 * EARTH_R));
		const at10km = REFRACTION_LIFT * 10_000 ** 2;
		expect(at10km).toBeGreaterThan(0.5);
		expect(at10km).toBeLessThan(2);
	});
});

describe("TILE_GLSL_COMMON", () => {
	it("defines the dither, the fill test's visibility rule and derivative shading", () => {
		for (const fn of ["tileDither", "tileShade", "tileCoveredByPhoto"])
			expect(TILE_GLSL_COMMON).toContain(fn);
	});
	it("keeps the tile where the photo is occluded or masked, drops it where the photo covers", () => {
		// the occlusion margin (8% + 25 m) and the 0.4% frame-edge feather are part of the look
		expect(TILE_GLSL_COMMON).toContain("seen * 1.08 + 25.0");
		expect(TILE_GLSL_COMMON).toContain("smoothstep(0.0, 0.004");
	});
});
