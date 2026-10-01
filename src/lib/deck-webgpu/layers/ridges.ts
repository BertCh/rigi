// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Ridge lines, skyline and ink creases for the WebGPU compositor (layers/composite.ts): a WGSL
// FUNCTION LIBRARY, no draws. Ported 1:1 from the WebGL deck composite:
//   classic  deck/composite-shader.ts compositeFs: `lr`, the 4-tap log-range discontinuity, the
//            skyline test and the nearFade taper, then the overlay / replace ridge mixes
//   LOOK_INK look/glsl/composite.ts: silhouettes (7×7 soft-min signed distance), refinedSkyline,
//            creases, inkLines, applyInk, innerWidth
// Inputs are the foundation's geometry targets (targets.ts), read with textureLoad at integer
// texels (rgba32float is unfilterable without float32-filterable):
//   geo     GeometryTargets.geometry  w = range (m), 0 = sky          (was geoTex.r, GL rows)
//   normal  GeometryTargets.normal    xyz = unit ENU normal           (was the LOOK_INK 'normal'
//           pass, style 7: a second terrain render; the geometry pass now writes it for free)
//   mask    the refined coverage (look/composite.ts, r = coverage), rows TOP-first, linear
//           sampler; only read when refine > 0.5
// ROWS ARE TOP-FIRST (uv from fullscreenWGSL, v down). The GLSL ran on bottom-first GL rows, so
// "one texel up" (the skyline test) is -y here; every other stencil is symmetric. Silhouettes keep
// the GL scan order (row offset negated) so the tie-break of the nearest texel is identical.
// Nearest-filter taps at fractional offsets (the classic ±1.25 texel stencil) are reproduced
// exactly as textureLoad(floor(pos ± 1.25)), clamped like clamp-to-edge.
//
// Coverage of a neighbour in the crease test: the GL normal pass had alpha 1 on terrain, 0 on the
// clear colour; here normal.w is the material class (0 = terrain!), so coverage = geometry.w > 0.
//
// Labels need nothing here: screen labels are DOM, and export labels (look/labels/canvas.ts
// drawExportLabels) stay canvas-2D and project with camera.ts projectToPixel (the CPU twin of the
// shader), so the engine port passes that instead of the WebGL camera.
//
// Usage from layers/composite.ts (see the bottom of this file for the full wiring note):
//   modules: [..., ridgesModule]                      // struct RidgeParams + fns + `ridges` UBO
//   shaderInputs.setProps({ridges: ridgeUniforms(style, {nearFade}, look?)})
//   let s = ridge_detect(geometryTex, uv, ridges);   // classic overlay / replace
//   col = ridge_overlay(col, s, composite.ridges * (1.0 - fg) * rv.z, ridges);
//   let ink = ink_lines(geometryTex, normalTex, maskTex, maskTexSampler, uv, s.range, cov, ridges);
//   col = ink_apply(col, ink, composite.ridges * (1.0 - fg) * rv.z, ridges);
// Or concatenate RIDGES_WGSL (no bindings) and build a RidgeParams value yourself (compute).
import type { ShaderModule } from "@luma.gl/shadertools";
import type { compositeValues } from "#/lib/look/composite";
import type { DeckCompositeStyle } from "#/lib/style/deck-apply";

/**
 * WGSL: `struct RidgeParams`, `struct RidgeSample` and the functions. No bindings, no entry points:
 * usable in fragment and compute stages. Textures are function parameters, so the caller owns the
 * binding names. SIGNATURES ARE STABLE (composite.ts and the mt-image-03 compute variant use them):
 *
 *   ridge_detect(geo, uv, p) -> RidgeSample {ridge, skyline, range}
 *   ridge_overlay(col, s, k, p) -> vec3      overlay mode (k = ridges·(1−fg)·reveal.z)
 *   ridge_replace(col, s, k, p) -> vec3      replace mode (k = ridges·m)
 *   ink_silhouettes(geo, uv, p) -> vec3      (inner, skyline, near range)
 *   ink_refined_skyline(mask, maskSampler, uv, w, p) -> f32
 *   ink_creases(geo, normal, uv) -> f32
 *   ink_lines(geo, normal, mask, maskSampler, uv, range, cov, p) -> vec2   (inner, skyline) alphas
 *   ink_apply(col, ink, k, p) -> vec3
 *   ridge_lr_of(r) / ridge_range_at(geo, texel) / ridge_inner_width(r, p)
 */
export const RIDGES_WGSL = /* wgsl */ `\
// ---- ridges (layers/ridges.ts) ----
struct RidgeParams {
  inner: vec4<f32>,     // overlay: inner ridge colour (rgb, linear as the style gives it)
  sky: vec4<f32>,       // overlay: skyline colour
  innerR: vec4<f32>,    // replace: ridge colour
  inkInner: vec4<f32>,  // LOOK_INK inner colour, a = inkStrength
  inkSky: vec4<f32>,    // LOOK_INK skyline colour
  thr: vec2<f32>,       // ridge smoothstep on the log-range jump (style ridgeThr)
  outSize: vec2<f32>,   // output size, px (ink widths are in output px)
  gainO: f32,
  gainR: f32,
  nearFade: f32,        // m; 0 = off. Ridges fade out below it (screen noise from close ground)
  inkWidth: f32,
  inkFade: f32,         // e-folding range of the ink opacity, m
  inkCrease: f32,       // 0 = no creases
  refine: f32,          // 1 = skyline from the refined coverage mask
  pad0: f32,
};

struct RidgeSample {
  ridge: f32,    // 0..1 discontinuity strength (nearFade applied)
  skyline: f32,  // 1 where the texel one row up is sky
  range: f32,    // centre range, m (0 = sky)
};

fn ridge_lr_of(r: f32) -> f32 { return select(13.5, log(r), r > 0.0); } // sky ≈ 700 km

fn ridge_range_at(geo: texture_2d<f32>, p: vec2<i32>) -> f32 {
  let s = vec2<i32>(textureDimensions(geo));
  return textureLoad(geo, clamp(p, vec2<i32>(0), s - 1), 0).w;
}

// the nearest texel of uv (clamp-to-edge), as a GL nearest-filter texture() read
fn ridge_texel(pos: vec2<f32>) -> vec2<i32> { return vec2<i32>(floor(pos)); }

// classic overlay / replace ridges (deck/composite-shader.ts): discontinuities in log-range at a
// ±1.25 texel cross, skyline where the texel above is sky, faded out below nearFade
fn ridge_detect(geo: texture_2d<f32>, uv: vec2<f32>, p: RidgeParams) -> RidgeSample {
  let pos = uv * vec2<f32>(textureDimensions(geo));
  let range = ridge_range_at(geo, ridge_texel(pos));
  let c = ridge_lr_of(range);
  let e = max(
    max(abs(c - ridge_lr_of(ridge_range_at(geo, ridge_texel(pos + vec2<f32>(1.25, 0.0))))),
        abs(c - ridge_lr_of(ridge_range_at(geo, ridge_texel(pos - vec2<f32>(1.25, 0.0)))))),
    max(abs(c - ridge_lr_of(ridge_range_at(geo, ridge_texel(pos + vec2<f32>(0.0, 1.25))))),
        abs(c - ridge_lr_of(ridge_range_at(geo, ridge_texel(pos - vec2<f32>(0.0, 1.25)))))));
  // GL: uvG + (0, o.y) is one texel UP; rows are top-first here
  let above = ridge_range_at(geo, ridge_texel(pos - vec2<f32>(0.0, 1.25)));
  var s: RidgeSample;
  s.range = range;
  s.skyline = select(0.0, 1.0, range > 0.0 && above == 0.0);
  s.ridge = smoothstep(p.thr.x, p.thr.y, e);
  if (p.nearFade > 0.0 && range > 0.0) {
    s.ridge *= smoothstep(p.nearFade * 0.5, p.nearFade, range);
  }
  return s;
}

fn ridge_overlay(col: vec3<f32>, s: RidgeSample, k: f32, p: RidgeParams) -> vec3<f32> {
  let rc = mix(p.inner.rgb, p.sky.rgb, s.skyline);
  return mix(col, rc, s.ridge * k * p.gainO);
}

fn ridge_replace(col: vec3<f32>, s: RidgeSample, k: f32, p: RidgeParams) -> vec3<f32> {
  return mix(col, p.innerR.rgb, s.ridge * k * p.gainR);
}

// ---- LOOK_INK ----

fn ridge_inner_width(r: f32, p: RidgeParams) -> f32 {
  return clamp(1.4 - 0.4 * log(max(r, 1.0) / 1000.0) / log(10.0), 0.6, 1.4) * p.inkWidth;
}

// Near-side depth silhouettes from log-range jumps. In a 7×7 texel window the nearest surface N
// (log-range within 0.08 of the minimum) and the farther texels F (> 0.1 behind it) each get a
// soft-min distance from the pixel centre; the silhouette sits midway, so s = (d_F − d_N)/2 is a
// smooth signed distance (px) and the line the box-filtered band s ∈ [0, w]. Returns
// (inner coverage, skyline coverage, range of the near surface).
fn ink_silhouettes(geo: texture_2d<f32>, uv: vec2<f32>, p: RidgeParams) -> vec3<f32> {
  let gs = vec2<i32>(textureDimensions(geo));
  let pos = uv * vec2<f32>(gs);
  let c = vec2<i32>(floor(pos));
  let lc = ridge_lr_of(ridge_range_at(geo, c));
  // cheap reject: no depth jump within 3 texels (the 8 directions are symmetric under the flip)
  var jmax = 0.0;
  for (var k = 0; k < 8; k++) {
    let a = f32(k) * 0.7853982;
    let dir = vec2<f32>(cos(a), -sin(a));
    jmax = max(jmax, abs(ridge_lr_of(ridge_range_at(geo, c + vec2<i32>(round(dir * 3.0)))) - lc));
    jmax = max(jmax, abs(ridge_lr_of(ridge_range_at(geo, c + vec2<i32>(round(dir * 1.5)))) - lc));
  }
  if (jmax < 0.1) { return vec3<f32>(0.0, 0.0, select(0.0, exp(lc), lc < 13.0)); }
  var L: array<f32, 49>;
  var lmin = 20.0;
  for (var i = 0; i < 49; i++) {
    // GL scan order: row offset i/7 − 3 counted upward, i.e. negated in top-first rows
    L[i] = ridge_lr_of(ridge_range_at(geo, c + vec2<i32>(i % 7 - 3, 3 - i / 7)));
    lmin = min(lmin, L[i]);
  }
  if (lmin > 13.0) { return vec3<f32>(0.0); }
  let pxPerTexel = p.outSize.x / f32(gs.x);
  let kk = 0.5 * max(pxPerTexel, 1.0);
  var sN = 0.0;
  var sF = 0.0;
  var sS = 0.0;
  // grazing slopes change log-range steadily; only a jump well above that trend is an occlusion
  let slopeAllow = 0.045 * 1024.0 / f32(gs.x);
  var cMin = vec2<f32>(0.0);
  for (var i = 0; i < 49; i++) {
    if (L[i] == lmin) { cMin = vec2<f32>(f32(i % 7 - 3), f32(3 - i / 7)); }
  }
  for (var i = 0; i < 49; i++) {
    let o = vec2<f32>(f32(i % 7 - 3), f32(3 - i / 7));
    let jump = L[i] - lmin - slopeAllow * length(o - cMin);
    let e = exp(-length(pos - (vec2<f32>(c) + o + 0.5)) * pxPerTexel / kk);
    if (L[i] - lmin < 0.08) { sN += e; }
    else if (L[i] > 13.0) { sS += e; }
    else if (jump > 0.12) { sF += smoothstep(0.12, 0.4, jump) * e; }
  }
  let dN = -kk * log(max(sN, 1e-30));
  let sIn = select(1e3, 0.5 * (-kk * log(sF) - dN), sF > 0.0);
  let sSk = select(1e3, 0.5 * (-kk * log(sS) - dN), sS > 0.0);
  // inner silhouettes are hairlines (1.4 px near → 0.6 px far); the skyline is a crisp 1.5 px
  let rNear = exp(lmin);
  let wIn = ridge_inner_width(rNear, p);
  let wSky = 1.5 * p.inkWidth;
  return vec3<f32>(
    clamp(min(sIn + 0.5, wIn) - max(sIn - 0.5, 0.0), 0.0, 1.0),
    clamp(min(sSk + 0.5, wSky) - max(sSk - 0.5, 0.0), 0.0, 1.0),
    rNear);
}

// skyline on the refined coverage: the band [0, w] px on the terrain side of its 0.5 isoline, from
// the signed distance (q − 0.5)/|∇q|, box-filtered over the pixel; flat plateaus draw nothing
fn ink_refined_skyline(mask: texture_2d<f32>, maskSampler: sampler, uv: vec2<f32>, w: f32, p: RidgeParams) -> f32 {
  let px = 1.0 / p.outSize;
  let q = textureSampleLevel(mask, maskSampler, uv, 0.0).r;
  let gx = textureSampleLevel(mask, maskSampler, uv + vec2<f32>(px.x, 0.0), 0.0).r
         - textureSampleLevel(mask, maskSampler, uv - vec2<f32>(px.x, 0.0), 0.0).r;
  let gy = textureSampleLevel(mask, maskSampler, uv + vec2<f32>(0.0, px.y), 0.0).r
         - textureSampleLevel(mask, maskSampler, uv - vec2<f32>(0.0, px.y), 0.0).r;
  let g = 0.5 * length(vec2<f32>(gx, gy));
  if (g < 1e-3) { return 0.0; }
  let d = (q - 0.5) / g;
  return clamp(min(d + 0.5, w) - max(d - 0.5, 0.0), 0.0, 1.0) * smoothstep(0.008, 0.03, g);
}

// creases from the geometry pass's normal target (was the LOOK_INK normal pass)
fn ink_creases(geo: texture_2d<f32>, normal: texture_2d<f32>, uv: vec2<f32>) -> f32 {
  let gs = vec2<i32>(textureDimensions(normal));
  let c = vec2<i32>(floor(uv * vec2<f32>(gs)));
  let n = textureLoad(normal, clamp(c, vec2<i32>(0), gs - 1), 0).xyz;
  var e = 0.0;
  for (var k = 0; k < 4; k++) {
    var o = vec2<i32>(0, -1);
    if (k == 0) { o = vec2<i32>(1, 0); } else if (k == 1) { o = vec2<i32>(-1, 0); } else if (k == 2) { o = vec2<i32>(0, 1); }
    let q = clamp(c + o, vec2<i32>(0), gs - 1);
    if (textureLoad(geo, q, 0).w > 0.0) { e = max(e, 1.0 - dot(n, textureLoad(normal, q, 0).xyz)); }
  }
  return smoothstep(0.08, 0.25, e);
}

// ink alphas (inner silhouettes / creases, skyline) at uv; range = centre range, cov = terrain
// coverage. p.nearFade is the GLSL inkLines nearFade argument (composite.nearFade).
fn ink_lines(geo: texture_2d<f32>, normal: texture_2d<f32>, mask: texture_2d<f32>, maskSampler: sampler,
             uv: vec2<f32>, range: f32, cov: f32, p: RidgeParams) -> vec2<f32> {
  let sil = ink_silhouettes(geo, uv, p);
  let lineRange = select(50000.0, sil.z, sil.z > 0.0);
  let fade = sqrt(exp(-lineRange / max(p.inkFade, 1.0)));
  var near = 1.0;
  if (p.nearFade > 0.0) { near = smoothstep(p.nearFade * 0.5, p.nearFade, lineRange); }
  var sky = sil.y;
  if (p.refine > 0.5) { sky = ink_refined_skyline(mask, maskSampler, uv, 1.5 * p.inkWidth, p); }
  let inner = sil.x * (1.0 - sky);
  var crease = 0.0;
  if (p.inkCrease > 0.0 && range > 0.0) { crease = ink_creases(geo, normal, uv) * (1.0 - inner) * (1.0 - sky) * cov; }
  // inner silhouettes stay light: they annotate relief, the skyline carries the drawing
  return vec2<f32>(max(inner * 0.5, crease * p.inkCrease * 0.4) * fade * near, sky * mix(0.55, 1.0, fade));
}

fn ink_apply(col: vec3<f32>, ink: vec2<f32>, k0: f32, p: RidgeParams) -> vec3<f32> {
  let k = k0 * p.inkInner.a;
  return mix(mix(col, p.inkInner.rgb, ink.x * k), p.inkSky.rgb, ink.y * k);
}
`;

/** Uniform values of `RidgeParams` (the `ridges` block of ridgesModule), in declaration order. */
export type RidgeUniforms = {
	inner: [number, number, number, number];
	sky: [number, number, number, number];
	innerR: [number, number, number, number];
	inkInner: [number, number, number, number];
	inkSky: [number, number, number, number];
	thr: [number, number];
	outSize: [number, number];
	gainO: number;
	gainR: number;
	nearFade: number;
	inkWidth: number;
	inkFade: number;
	inkCrease: number;
	refine: number;
	pad0: number;
};

/**
 * luma ShaderModule: RIDGES_WGSL + `@group(0) @binding(auto) var<uniform> ridges: RidgeParams`.
 * Add it to the composite Model's modules and pass `ridges` to the functions. Do NOT also paste
 * RIDGES_WGSL into the same program.
 */
export const ridgesModule = {
	name: "ridges",
	source: /* wgsl */ `${RIDGES_WGSL}
@group(0) @binding(auto) var<uniform> ridges: RidgeParams;
`,
	uniformTypes: {
		inner: "vec4<f32>",
		sky: "vec4<f32>",
		innerR: "vec4<f32>",
		inkInner: "vec4<f32>",
		inkSky: "vec4<f32>",
		thr: "vec2<f32>",
		outSize: "vec2<f32>",
		gainO: "f32",
		gainR: "f32",
		nearFade: "f32",
		inkWidth: "f32",
		inkFade: "f32",
		inkCrease: "f32",
		refine: "f32",
		pad0: "f32",
	},
	bindingLayout: [{ name: "ridges", group: 0 }],
} as const satisfies ShaderModule;

/** Classic look defaults (style/defaults CLASSIC: overlay.ridges, replace.ridges, composite.ink;
 * array colours pass through rawColor unchanged), for labs / checks. */
export const DEFAULT_RIDGES: RidgeUniforms = {
	inner: [1, 0.95, 0.85, 1],
	sky: [1, 0.45, 0.25, 1],
	innerR: [1, 0.95, 0.85, 1],
	inkInner: [1, 0.95, 0.86, 0.6],
	inkSky: [1, 0.56, 0.36, 0],
	thr: [0.12, 0.45],
	outSize: [1024, 768],
	gainO: 0.9,
	gainR: 0.5,
	nearFade: 60,
	inkWidth: 1,
	inkFade: 60000,
	inkCrease: 0,
	refine: 0,
	pad0: 0,
};

type Look = ReturnType<typeof compositeValues>;

/**
 * Fill the `ridges` block from the same sources the WebGL composite reads:
 *   style     deckCompositeStyle(viewStyle)  (ridgeInner/Sky/InnerR, ridgeThr, ridgeGainO/R)
 *   settings  CompositeSettings.nearFade     (deck/composite.ts)
 *   look      compositeValues(style, {...})  (LOOK_INK: ink colours, width, strength, crease,
 *             fade, refine, outSize); omit when the look has no composite define
 *   outSize   output px, used when `look` is absent (canvas drawing-buffer size)
 */
export function ridgeUniforms(
	style: Pick<
		DeckCompositeStyle,
		| "ridgeInner"
		| "ridgeSky"
		| "ridgeInnerR"
		| "ridgeThr"
		| "ridgeGainO"
		| "ridgeGainR"
	>,
	settings: { nearFade: number },
	look?: Pick<
		Look,
		| "inkInner"
		| "inkSky"
		| "outSize"
		| "inkWidth"
		| "inkStrength"
		| "inkCrease"
		| "inkFade"
		| "refine"
	> | null,
	outSize: [number, number] = [1, 1],
): RidgeUniforms {
	const v4 = (
		c: readonly number[],
		a = 1,
	): [number, number, number, number] => [c[0] ?? 0, c[1] ?? 0, c[2] ?? 0, a];
	return {
		inner: v4(style.ridgeInner),
		sky: v4(style.ridgeSky),
		innerR: v4(style.ridgeInnerR),
		inkInner: v4(look?.inkInner ?? [1, 1, 1], look?.inkStrength ?? 0),
		inkSky: v4(look?.inkSky ?? [1, 1, 1], 0),
		thr: [style.ridgeThr[0], style.ridgeThr[1]],
		outSize: look
			? [look.outSize[0] ?? outSize[0], look.outSize[1] ?? outSize[1]]
			: outSize,
		gainO: style.ridgeGainO,
		gainR: style.ridgeGainR,
		nearFade: settings.nearFade,
		inkWidth: look?.inkWidth ?? 1,
		inkFade: look?.inkFade ?? 60000,
		inkCrease: look?.inkCrease ?? 0,
		refine: look?.refine ?? 0,
		pad0: 0,
	};
}

/*
 * WIRING (layers/composite.ts; nothing here is drawn on its own):
 * 1. modules: [ridgesModule, ...] on the composite Model (or `${RIDGES_WGSL}` for a raw program).
 * 2. Bind the foundation targets as the composite's geometry / normal textures
 *    (ctx.geometry.geometry, ctx.geometry.normal) and the refined coverage mask as `maskTex`
 *    (r8unorm, top-first, linear sampler; placeholderTextures().zeroMask when refine is off).
 * 3. Each frame: shaderInputs.setProps({ridges: ridgeUniforms(deckCompositeStyle(style),
 *    {nearFade: settings.nearFade}, lookValues ?? null, [canvasW, canvasH])}).
 * 4. In the fragment (uv = FullscreenOut.uv, top-first) replace the GLSL block:
 *      let s = ridge_detect(geometryTex, uv, ridges);          // range = s.range, isSkyline, ridge
 *      overlay: LOOK_INK ? ink_apply(col, ink, ridges_k, ridges) : ridge_overlay(col, s, k, ridges)
 *      replace: LOOK_INK ? ink_apply(col, ink, composite.ridges * m, ridges)
 *                        : ridge_replace(col, s, composite.ridges * m, ridges)
 *      reveal's revealLight takes s.ridge * composite.ridges as before.
 *    ink = ink_lines(geometryTex, normalTex, maskTex, maskTexSampler, uv, s.range, cov, ridges)
 *    is computed only under the LOOK_INK define (the 7×7 window costs ~60 loads per pixel).
 * 5. The WebGL LOOK_INK normal pass (terrain style 7, composite.ts `this.normal`) is gone: the
 *    geometry pass writes the normal target every frame, so `look.normal` gating is not needed
 *    (keep inkCrease = 0 until the pose settles if creases flicker during drags, as before).
 * Compute (mt-image-03 candidate): one dispatch over the output size writing
 * (ridge·(1−skyline), ridge·skyline, ink.x, ink.y) with the same functions. Note r8unorm is not a
 * core storage format: use rgba8unorm (4 masks in one texel) or r32float.
 */
