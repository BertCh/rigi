// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) vis.gl contributors
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Trail stroke styles (style.trails.stroke): 'solid' (default, the flat screen-space quad), 'pencil'
// and 'glow'. Display only.
//   pencil  sketchStroke_getCoverage of luma.gl (visgl/luma.gl #3318, `@luma.gl/shadertools`
//           sketchStroke, SPDX-FileCopyrightText: Copyright (c) vis.gl contributors): centre jitter,
//           width variation and paper grain as functions of the metres along the trail, so the pencil
//           is anchored to the path and never swims. The quad is widened by the jitter, and the
//           stroke ends are not modelled (the segments are one continuous trail).
//   glow    a bright core and a soft Gaussian halo across the line (the idea of luma's pointGlow,
//           stretched along a path). The quad is widened for the halo.
// `makeStrokeGeometry` (luma.gl #3322) builds CPU stroke meshes; the trails here are instanced
// screen-space quads built per frame from segment ends, so only the shading is shared.
// One set of constants feeds the TS reference (checks), the GLSL (deck/trail-layer.ts) and the WGSL
// (deck-webgpu/layers/trail.ts) text.
import { smoothstep } from "../math";
import {
	SKETCH_NOISE_GLSL,
	SKETCH_NOISE_WGSL,
	sketchNoise,
} from "./sketch-ridges";

export type TrailStrokeKind = "solid" | "pencil" | "glow";

/** Shader mode id per kind (uniform `stroke`). */
export const TRAIL_STROKE_MODE: Record<TrailStrokeKind, number> = {
	solid: 0,
	pencil: 1,
	glow: 2,
};

/** Pencil: jitter of the centre, fraction of the width (sketchStroke `jitter` 0.7 px at width 2). */
export const PENCIL_JITTER = 0.2;
export const PENCIL_VARIATION = 0.25;
export const PENCIL_GRAIN = 0.45;
/** Minimum antialias width in px (sketchStroke `minimumAntialias`). */
export const PENCIL_MIN_AA = 0.7;
/** Metres per sketchStroke "segment": noise cells are 1 / 17 of it. */
export const PENCIL_ALONG_M = 250;
/** Glow: Gaussian halo scale in widths (alpha exp(-2 (d/reach)^2)); peak halo alpha. */
export const GLOW_REACH = 1.0;
export const GLOW_HALO = 0.4;
export const GLOW_CORE_WHITEN = 0.35;

export function strokeKind(v: string | undefined): TrailStrokeKind {
	return v === "pencil" || v === "glow" ? v : "solid";
}

/** Extra half-width (target px) the quad needs for the stroke style; 0 for solid. */
export function strokePadPx(kind: TrailStrokeKind, widthPx: number): number {
	if (kind === "pencil")
		return widthPx * (0.075 + PENCIL_JITTER) + PENCIL_MIN_AA + 0.5;
	if (kind === "glow") return widthPx * GLOW_REACH * 1.5 + 1;
	return 0;
}

/**
 * Reference coverage (0..1) of the stroke at `side` px across the centre and `along` metres along
 * the trail; `glow` also returns the core amount used to whiten the colour. `aa` is the pixel
 * footprint (fwidth) the shader derives.
 */
export function strokeCoverage(
	kind: TrailStrokeKind,
	side: number,
	along: number,
	widthPx: number,
	aa = 1,
	grainFade = 1,
): { coverage: number; core: number } {
	if (kind === "pencil") {
		const t = along / PENCIL_ALONG_M;
		const jitter = PENCIL_JITTER * widthPx;
		const center = (sketchNoise(t * 17) * 2 - 1) * jitter;
		const variation =
			1 + (0.55 + sketchNoise(t * 31 + 7) * 0.75 - 1) * PENCIL_VARIATION;
		const radius = widthPx * 0.5 * variation;
		const distance = Math.abs(side - center) - radius;
		const a = Math.max(aa, PENCIL_MIN_AA);
		const cover = 1 - smoothstep(-a * 0.5, a * 0.5, distance);
		const paper = sketchNoise(t * 237 + Math.floor(side * 3) * 13);
		return {
			coverage: cover * (1 - PENCIL_GRAIN * grainFade * paper),
			core: 0,
		};
	}
	if (kind === "glow") {
		const half = widthPx * 0.5;
		const d = Math.abs(side);
		const core = 1 - smoothstep(half - 0.5, half + 0.5, d);
		const reach = Math.max(widthPx * GLOW_REACH, 1e-3);
		const x = Math.max(d - half, 0) / reach;
		const halo = Math.exp(-x * x * 2) * GLOW_HALO;
		return { coverage: Math.max(core, halo), core };
	}
	return { coverage: 1, core: 0 };
}

const F = (n: number) => n.toFixed(4);

/**
 * GLSL: `float trailStroke(float mode, float side, float along, float width, float grainFade, out float core)`;
 * derivatives of `side` / `along` must be taken by the caller in uniform control flow (aa, grainFade).
 */
export const TRAIL_STROKE_GLSL = /* glsl */ `\
${SKETCH_NOISE_GLSL}// luma sketchStroke_getCoverage (visgl/luma.gl #3318) for pencil, a Gaussian halo for glow; see look/trail-stroke.ts
float trailStroke(float mode, float side, float along, float width, float aa, float grainFade, out float core) {
  core = 0.0;
  if (mode < 0.5) return 1.0;
  if (mode < 1.5) {
    float t = along / ${F(PENCIL_ALONG_M)};
    float center = (sketchNoise(t * 17.0) * 2.0 - 1.0) * ${F(PENCIL_JITTER)} * width;
    float variation = mix(1.0, 0.55 + sketchNoise(t * 31.0 + 7.0) * 0.75, ${F(PENCIL_VARIATION)});
    float radius = width * 0.5 * variation;
    float distance = abs(side - center) - radius;
    float a = max(aa, ${F(PENCIL_MIN_AA)});
    float cover = 1.0 - smoothstep(-a * 0.5, a * 0.5, distance);
    float paper = sketchNoise(t * 237.0 + floor(side * 3.0) * 13.0);
    return cover * (1.0 - ${F(PENCIL_GRAIN)} * grainFade * paper);
  }
  float hw_ = width * 0.5;
  float d = abs(side);
  core = 1.0 - smoothstep(hw_ - 0.5, hw_ + 0.5, d);
  float reach = max(width * ${F(GLOW_REACH)}, 0.001);
  float x = max(d - hw_, 0.0) / reach;
  return max(core, exp(-x * x * 2.0) * ${F(GLOW_HALO)});
}
`;

/** WGSL twin: `trail_stroke(mode, side, along, width, aa, grainFade) -> vec2` (coverage, core). */
export const TRAIL_STROKE_WGSL = /* wgsl */ `\
${SKETCH_NOISE_WGSL}// luma sketchStroke_getCoverage (visgl/luma.gl #3318) for pencil, a Gaussian halo for glow; see look/trail-stroke.ts
fn trail_stroke(mode: f32, side: f32, along: f32, width: f32, aa: f32, grainFade: f32) -> vec2<f32> {
  if (mode < 0.5) { return vec2<f32>(1.0, 0.0); }
  if (mode < 1.5) {
    let t = along / ${F(PENCIL_ALONG_M)};
    let center = (sketch_noise(t * 17.0) * 2.0 - 1.0) * ${F(PENCIL_JITTER)} * width;
    let variation = mix(1.0, 0.55 + sketch_noise(t * 31.0 + 7.0) * 0.75, ${F(PENCIL_VARIATION)});
    let radius = width * 0.5 * variation;
    let distance = abs(side - center) - radius;
    let a = max(aa, ${F(PENCIL_MIN_AA)});
    let cover = 1.0 - smoothstep(-a * 0.5, a * 0.5, distance);
    let paper = sketch_noise(t * 237.0 + floor(side * 3.0) * 13.0);
    return vec2<f32>(cover * (1.0 - ${F(PENCIL_GRAIN)} * grainFade * paper), 0.0);
  }
  let hw = width * 0.5;
  let d = abs(side);
  let core = 1.0 - smoothstep(hw - 0.5, hw + 0.5, d);
  let reach = max(width * ${F(GLOW_REACH)}, 0.001);
  let x = max(d - hw, 0.0) / reach;
  return vec2<f32>(max(core, exp(-x * x * 2.0) * ${F(GLOW_HALO)}), core);
}
`;

/** Core whitening applied to the colour in glow mode: mix(colour, 1, core * this). */
export const TRAIL_GLOW_WHITEN = GLOW_CORE_WHITEN;
