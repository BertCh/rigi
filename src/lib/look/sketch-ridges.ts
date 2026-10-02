// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) vis.gl contributors
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Pencil / ink wobble for the ridge, skyline and crease lines (style.composite.sketch, 0 = off).
// The noise and the three terms (centre jitter, strength variation, paper grain) are the
// sketchStroke shading of luma.gl (visgl/luma.gl #3318, `@luma.gl/shadertools` sketchStroke,
// SPDX-FileCopyrightText: Copyright (c) vis.gl contributors), ported to the screen-space ridge pass:
// sketchStroke wants geometry-anchored stroke coordinates (distance along a segment, signed distance
// across it), and the ridge lines are found per pixel in the geometry target, so there is no stroke
// geometry to anchor to. The analogue here is a smooth 2D displacement of the lookup position
// (jitter), a slow strength modulation (variation) and a per-cell paper grain, all functions of the
// geometry texel position only, so the pencil stays on the picture and never swims with time.
// Display only: no pose, confidence or export reads this.
//
// One set of constants feeds the TS reference (checks), the GLSL (deck/composite-shader.ts) and the
// WGSL (deck-webgpu/layers/ridges.ts) text, so the engines agree by construction.

/** Jitter of the line centre, geometry texels at sketch = 1. */
export const SKETCH_JITTER = 0.9;
/** Weight of the strength variation (sketchStroke `variation`). */
export const SKETCH_VARIATION = 0.35;
/** Weight of the paper grain (sketchStroke `grain`). */
export const SKETCH_GRAIN = 0.45;

/** sketchStroke_noise: smooth 1D value noise, 0..1. */
export function sketchNoise(coordinate: number): number {
	const cell = Math.floor(coordinate);
	const fraction = coordinate - cell;
	const hash = (x: number) => {
		const v = Math.sin(x * 127.1) * 43758.5453;
		return v - Math.floor(v);
	};
	const t = fraction * fraction * (3 - 2 * fraction);
	return hash(cell) * (1 - t) + hash(cell + 1) * t;
}

export type SketchRidgeFactors = {
	/** lookup displacement in geometry texels */
	dx: number;
	dy: number;
	/** multiplier on the line strength, 1 at sketch = 0 */
	gain: number;
};

/** Reference of `ridge_sketch` / `ridgeSketch` for the geometry texel position `x`, `y`. */
export function sketchRidgeFactors(
	x: number,
	y: number,
	sketch: number,
): SketchRidgeFactors {
	const dx =
		(sketchNoise(y * 0.061 + x * 0.023 + 3.7) * 2 - 1) * SKETCH_JITTER * sketch;
	const dy =
		(sketchNoise(x * 0.061 - y * 0.023 + 11.3) * 2 - 1) *
		SKETCH_JITTER *
		sketch;
	const variation = 0.55 + sketchNoise(x * 0.11 + y * 0.09 + 5.1) * 0.75;
	const paper = sketchNoise(Math.floor(x * 0.5) + Math.floor(y * 0.5) * 7);
	const gain =
		(1 + (variation - 1) * SKETCH_VARIATION * sketch) *
		(1 - SKETCH_GRAIN * sketch * paper);
	return { dx, dy, gain };
}

const F = (n: number) => n.toFixed(4);

/**
 * Value noise (luma sketchStroke_noise): `sketchNoise(float)` / `sketch_noise(f32)`, 0..1. Shared by
 * the trail stroke (look/trail-stroke.ts); a shader splices it once, so it does not also carry
 * SKETCH_RIDGES_* (which embeds it).
 */
export const SKETCH_NOISE_GLSL = /* glsl */ `\
float sketchNoise(float coordinate) {
  float cell = floor(coordinate);
  float fraction = fract(coordinate);
  float first = fract(sin(cell * 127.1) * 43758.5453);
  float second = fract(sin((cell + 1.0) * 127.1) * 43758.5453);
  return mix(first, second, fraction * fraction * (3.0 - 2.0 * fraction));
}
`;
export const SKETCH_NOISE_WGSL = /* wgsl */ `\
fn sketch_noise(coordinate: f32) -> f32 {
  let cell = floor(coordinate);
  let fraction = fract(coordinate);
  let first = fract(sin(cell * 127.1) * 43758.5453);
  let second = fract(sin((cell + 1.0) * 127.1) * 43758.5453);
  return mix(first, second, fraction * fraction * (3.0 - 2.0 * fraction));
}
`;

/** GLSL: `vec3 ridgeSketch(vec2 pos, float sketch)` -> (dx, dy, gain), pos in geometry texels. */
export const SKETCH_RIDGES_GLSL = /* glsl */ `\
// luma sketchStroke_noise (visgl/luma.gl #3318), see look/sketch-ridges.ts
${SKETCH_NOISE_GLSL}
vec3 ridgeSketch(vec2 pos, float sketch) {
  float dx = (sketchNoise(pos.y * 0.061 + pos.x * 0.023 + 3.7) * 2.0 - 1.0) * ${F(SKETCH_JITTER)} * sketch;
  float dy = (sketchNoise(pos.x * 0.061 - pos.y * 0.023 + 11.3) * 2.0 - 1.0) * ${F(SKETCH_JITTER)} * sketch;
  float variation = 0.55 + sketchNoise(pos.x * 0.11 + pos.y * 0.09 + 5.1) * 0.75;
  float paper = sketchNoise(floor(pos.x * 0.5) + floor(pos.y * 0.5) * 7.0);
  float gain = (1.0 + (variation - 1.0) * ${F(SKETCH_VARIATION)} * sketch) * (1.0 - ${F(SKETCH_GRAIN)} * sketch * paper);
  return vec3(dx, dy, gain);
}
`;

/** WGSL twin: `ridge_sketch(pos, sketch) -> vec3` (dx, dy, gain). */
export const SKETCH_RIDGES_WGSL = /* wgsl */ `\
// luma sketchStroke_noise (visgl/luma.gl #3318), see look/sketch-ridges.ts
${SKETCH_NOISE_WGSL}
fn ridge_sketch(pos: vec2<f32>, sketch: f32) -> vec3<f32> {
  let dx = (sketch_noise(pos.y * 0.061 + pos.x * 0.023 + 3.7) * 2.0 - 1.0) * ${F(SKETCH_JITTER)} * sketch;
  let dy = (sketch_noise(pos.x * 0.061 - pos.y * 0.023 + 11.3) * 2.0 - 1.0) * ${F(SKETCH_JITTER)} * sketch;
  let variation = 0.55 + sketch_noise(pos.x * 0.11 + pos.y * 0.09 + 5.1) * 0.75;
  let paper = sketch_noise(floor(pos.x * 0.5) + floor(pos.y * 0.5) * 7.0);
  let gain = (1.0 + (variation - 1.0) * ${F(SKETCH_VARIATION)} * sketch) * (1.0 - ${F(SKETCH_GRAIN)} * sketch * paper);
  return vec3<f32>(dx, dy, gain);
}
`;
