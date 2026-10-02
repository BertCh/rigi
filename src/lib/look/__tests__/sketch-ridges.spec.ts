// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { seededRandom } from "#/test/helpers";
import {
	SKETCH_GRAIN,
	SKETCH_JITTER,
	SKETCH_RIDGES_GLSL,
	SKETCH_RIDGES_WGSL,
	SKETCH_VARIATION,
	sketchNoise,
	sketchRidgeFactors,
} from "../sketch-ridges";

describe("sketchNoise", () => {
	it("is in [0, 1) and deterministic", () => {
		const rand = seededRandom(7);
		for (let i = 0; i < 2000; i++) {
			const x = (rand() - 0.5) * 2000;
			const n = sketchNoise(x);
			expect(n).toBeGreaterThanOrEqual(0);
			expect(n).toBeLessThan(1);
			expect(sketchNoise(x)).toBe(n);
		}
	});
	it("is continuous across integer cells and smooth inside them", () => {
		for (const cell of [-5, 0, 3, 41]) {
			expect(sketchNoise(cell - 1e-9)).toBeCloseTo(sketchNoise(cell), 6);
			expect(sketchNoise(cell + 1e-9)).toBeCloseTo(sketchNoise(cell), 6);
		}
		// Lipschitz: the smoothstep blend of two values in [0,1) has slope at most 1.5
		for (let x = 0; x < 20; x += 0.013)
			expect(Math.abs(sketchNoise(x + 0.001) - sketchNoise(x))).toBeLessThan(
				0.0016,
			);
	});
	it("interpolates its lattice values: at a cell it equals the cell hash", () => {
		const hash = (x: number) => {
			const v = Math.sin(x * 127.1) * 43758.5453;
			return v - Math.floor(v);
		};
		expect(sketchNoise(4)).toBeCloseTo(hash(4), 12);
		expect(sketchNoise(4.5)).toBeCloseTo((hash(4) + hash(5)) / 2, 12);
	});
});

describe("sketchRidgeFactors", () => {
	it("is the identity at sketch = 0", () => {
		const f = sketchRidgeFactors(123.4, 56.7, 0);
		expect(f.dx).toBeCloseTo(0, 12);
		expect(f.dy).toBeCloseTo(0, 12);
		expect(f.gain).toBe(1);
	});
	it("displacement is bounded by the jitter and scales linearly with sketch", () => {
		const rand = seededRandom(11);
		for (let i = 0; i < 500; i++) {
			const x = rand() * 512;
			const y = rand() * 512;
			const full = sketchRidgeFactors(x, y, 1);
			const half = sketchRidgeFactors(x, y, 0.5);
			expect(Math.abs(full.dx)).toBeLessThanOrEqual(SKETCH_JITTER);
			expect(Math.abs(full.dy)).toBeLessThanOrEqual(SKETCH_JITTER);
			expect(half.dx).toBeCloseTo(full.dx / 2, 12);
			expect(half.dy).toBeCloseTo(full.dy / 2, 12);
		}
	});
	it("gain stays positive and never exceeds the variation headroom", () => {
		const rand = seededRandom(13);
		const maxGain = 1 + (1.3 - 1) * SKETCH_VARIATION;
		const minGain = (1 + (0.55 - 1) * SKETCH_VARIATION) * (1 - SKETCH_GRAIN);
		for (let i = 0; i < 2000; i++) {
			const g = sketchRidgeFactors(rand() * 4000, rand() * 4000, 1).gain;
			expect(g).toBeGreaterThanOrEqual(minGain - 1e-9);
			expect(g).toBeLessThanOrEqual(maxGain + 1e-9);
		}
	});
	it("depends only on position (the pencil does not swim)", () => {
		expect(sketchRidgeFactors(10, 20, 0.7)).toEqual(
			sketchRidgeFactors(10, 20, 0.7),
		);
		expect(sketchRidgeFactors(10, 20, 0.7)).not.toEqual(
			sketchRidgeFactors(11, 20, 0.7),
		);
	});
});

describe("shader twins", () => {
	it("GLSL and WGSL embed the same constants as the TS reference", () => {
		for (const [name, v] of [
			["jitter", SKETCH_JITTER],
			["variation", SKETCH_VARIATION],
			["grain", SKETCH_GRAIN],
		] as const) {
			const s = v.toFixed(4);
			expect(SKETCH_RIDGES_GLSL, name).toContain(s);
			expect(SKETCH_RIDGES_WGSL, name).toContain(s);
		}
	});
	it("both define their entry points and the same literal offsets", () => {
		expect(SKETCH_RIDGES_GLSL).toContain(
			"vec3 ridgeSketch(vec2 pos, float sketch)",
		);
		expect(SKETCH_RIDGES_WGSL).toContain(
			"fn ridge_sketch(pos: vec2<f32>, sketch: f32)",
		);
		for (const lit of [
			"0.061",
			"0.023",
			"3.7",
			"11.3",
			"0.11",
			"0.09",
			"5.1",
			"127.1",
			"43758.5453",
		]) {
			expect(SKETCH_RIDGES_GLSL, lit).toContain(lit);
			expect(SKETCH_RIDGES_WGSL, lit).toContain(lit);
		}
	});
});
