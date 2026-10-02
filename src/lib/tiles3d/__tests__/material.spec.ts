// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { EARTH_R, REFRACTION_K } from "../../geodesy";
import {
	makeTileMaterial,
	makeTileSharedUniforms,
	REFRACTION_LIFT,
	TILE_GLSL_COMMON,
} from "../material";

describe("makeTileSharedUniforms", () => {
	it("starts with fill off, no textures and the documented fade and clear ranges", () => {
		const u = makeTileSharedUniforms();
		expect(u.uFill.value).toBe(0);
		expect(u.uPhotoRange.value).toBeNull();
		expect(u.uPhotoFg.value).toBeNull();
		expect(u.uPhotoFgOn.value).toBe(0);
		expect(u.uOpacity.value).toBe(1);
		expect(u.uTruth.value).toBe(0);
		expect(u.uFade.value.toArray()).toEqual([2200, 3000]);
		expect(u.uClear.value.toArray()).toEqual([25, 40]);
	});
	it("returns fresh objects each call so sets never share state", () => {
		const a = makeTileSharedUniforms();
		const b = makeTileSharedUniforms();
		a.uEye.value.set(1, 2, 3);
		a.uFill.value = 1;
		expect(b.uEye.value.toArray()).toEqual([0, 0, 0]);
		expect(b.uFill.value).toBe(0);
		expect(a.uPhotoViewProj).not.toBe(b.uPhotoViewProj);
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

describe("makeTileMaterial", () => {
	const shared = makeTileSharedUniforms();
	it("shares the set's uniform objects, so updating one updates every tile", () => {
		const m = makeTileMaterial(shared, {
			map: null,
			color: [0.1, 0.2, 0.3],
			vertexColors: false,
			depthBias: 0.99,
		});
		expect(m.name).toBe("tiles3d");
		expect(m.uniforms.uFill).toBe(shared.uFill);
		expect(m.uniforms.uEye).toBe(shared.uEye);
		shared.uFill.value = 1;
		expect(m.uniforms.uFill.value).toBe(1);
		shared.uFill.value = 0;
	});
	it("flags a texture, carries the colour, bias and lift, and draws both sides", () => {
		const tex = new THREE.Texture();
		const textured = makeTileMaterial(shared, {
			map: tex,
			color: [1, 0, 0],
			vertexColors: true,
			depthBias: 0.97,
		});
		expect(textured.uniforms.uHasMap.value).toBe(1);
		expect(textured.uniforms.uMap.value).toBe(tex);
		expect(textured.uniforms.uDepthBias.value).toBe(0.97);
		expect(textured.uniforms.uLift.value).toBe(REFRACTION_LIFT);
		expect(textured.vertexColors).toBe(true);
		expect(textured.side).toBe(THREE.DoubleSide);
		const flat = makeTileMaterial(shared, {
			map: null,
			color: [0.2, 0.4, 0.6],
			vertexColors: false,
			depthBias: 0.99,
		});
		expect(flat.uniforms.uHasMap.value).toBe(0);
		const c = flat.uniforms.uColor.value as THREE.Color;
		expect([c.r, c.g, c.b]).toEqual([
			expect.closeTo(0.2, 5),
			expect.closeTo(0.4, 5),
			expect.closeTo(0.6, 5),
		]);
	});
	it("compiles the shared GLSL into both shaders' source text", () => {
		const m = makeTileMaterial(shared, {
			map: null,
			color: [1, 1, 1],
			vertexColors: false,
			depthBias: 1,
		});
		expect(TILE_GLSL_COMMON.length).toBeGreaterThan(100);
		expect(m.vertexShader).toContain("uLift");
		expect(m.fragmentShader).toContain("uFill");
	});
});
