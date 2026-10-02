// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The WebGPU photo compositor: the screen-pass core that replaces PresentCore (present.ts). A 1:1
// port of the WebGL deck composite (deck/composite.ts PhotoCompositor + PhotoCompositeLayer,
// deck/composite-shader.ts compositeFs, look/glsl/composite.ts, reveal/glsl.ts):
//
//   photo (rgba8unorm-srgb, hardware-decoded)  ⊕  ColorTargets.color (linear, PREMULTIPLIED)
//     + distance tint (turbo or the style's depth ramp)       overlay mode
//     + swipe / lens / range / brush blend + hairline         replace mode
//     + ridges / skyline / ink (layers/ridges.ts)             both
//     + people mask, concord occluder dim, reveal animation   both
//     + the LOOK_* composite defines (REFINE, INK, HARMONIZE, OUTPUT) as luma WGSL #ifdefs
//   → sRGB-encoded, opaque, on the canvas (bgra8unorm, alphaMode premultiplied)
//
// What changed against the WebGL path (and why the output is the same):
//   - The colour target is premultiplied (README "Targets"): the overlay mix(photo, rgb, a·k)
//     becomes photo·(1 − a·k) + rgb·k; the replace / look paths un-premultiply first (they use the
//     straight colour with other weights), so their math is the GLSL math unchanged. The WebGL
//     `comp_premul` flag (an opaque replace style whose MSAA resolve premultiplied the layer by
//     coverage) keeps its meaning: it only switches LOOK_REFINE's hole fill and the blend weight.
//   - Every texture is top-first (uv v down): the uvT / MASK y-flips are gone; the only "up"-aware
//     reads are the skyline test (layers/ridges.ts) and the reveal, which gets GL uv (v up) because
//     its F/R/U ray basis and focus.y are defined that way (reveal/config.ts RevealUniforms).
//   - MSAA, the colour pass, the geometry pass, the LOOK_INK normal pass and the Step Inside
//     SplatColorPass merge are the foundation's (hosts/passes.ts); nothing here renders offscreen.
//     The ink creases read GeometryTargets.normal (written every geometry pass).
//   - The photo is hardware-decoded (filtering in linear light, the WebGL path filtered sRGB bytes
//     and decoded after): sub-LSB differences at photo edges only.
//   - LOOK_OUTPUT's grain / dither is seeded with GL fragment coords (y from the bottom), so the
//     noise pattern matches the WebGL frame too.
//
// Usage (the assembler wires it; see WIRING at the bottom):
//   const composite = createCompositeCore({ requestRender: (s) => host.requestRender(s) });
//   host.cores = [terrain, ...others, composite];
//   composite.setPhoto(imageBitmap); composite.setSettings(compositeFor(settings)); ...
// Every setter is a composite-only change: it calls requestRender("screen") (one screen pass on the
// cached offscreen targets, ~1 ms) — never "all".
import type { Device, Texture } from "@luma.gl/core";
import { Model } from "@luma.gl/engine";
import type { ShaderModule } from "@luma.gl/shadertools";
import type {
	BlendMethod,
	CompositeSettings,
	DeckCompositeLook,
} from "#/lib/deck/composite";
import { BAND_CENTERS_LOG10 } from "#/lib/look/color-stats";
import type { LookDefine } from "#/lib/look/look-key";
import type { ByteMask } from "#/lib/ontology/core/geometry";
import type { RevealUniforms } from "#/lib/reveal/config";
import {
	type DeckCompositeStyle,
	deckCompositeStyle,
} from "#/lib/style/deck-apply";
import { CLASSIC } from "#/lib/style/defaults";
import {
	type GpuLayerCore,
	ModelCache,
	type PassContext,
	type PassKind,
	screenModelProps,
	targetKey,
} from "../pass";
import { USAGE } from "../targets";
import { imageTexture, maskTexture } from "../textures";
import { colorWGSL, fullscreenWGSL, rampWGSL } from "../wgsl";
import { ridgesModule, ridgeUniforms } from "./ridges";

export type { BlendMethod, CompositeSettings, DeckCompositeLook };

/**
 * deck/composite.ts defaultCompositeSettings (same names and values; composite.check.ts asserts
 * they stay equal). Duplicated so this module does not pull the WebGL compositor into the bundle.
 */
export const defaultCompositeSettings: CompositeSettings = {
	mode: "overlay",
	layerOpacity: 0.9,
	ridges: 0.8,
	depthTint: 0,
	method: "lens",
	swipe: 0.5,
	lens: [0.5, 0.4],
	lensR: 0.18,
	rangeKm: 3,
	keepSky: true,
	feather: 0.03,
	nearFade: 60,
	protectPeople: true,
};

const METHOD: Record<BlendMethod, number> = {
	swipe: 0,
	lens: 1,
	range: 2,
	brush: 3,
};

/** A byte mask, row 0 = top (people mask, concord occluder). */
export type { ByteMask };

type Vec4 = [number, number, number, number];

// ---------------------------------------------------------------------------------------------
// Uniform blocks (WGSL struct order == uniformTypes order; mat4 → vec4 → vec2 → f32; 16-byte pad)
// ---------------------------------------------------------------------------------------------

/** The `composite` block (deck/composite-shader.ts compositeUniforms minus the ridge fields, which
 * live in layers/ridges.ts `ridges`, and geoTexel, which the shader takes from the texture). */
export type CompositeUniforms = {
	depthC0: number[];
	depthC1: number[];
	depthDE: number[];
	/** replace-mode hairline: rgb + alpha */
	hair: number[];
	reveal: number[];
	revealWin: number[];
	revealQD: number[];
	revealQE: number[];
	revealShape: number[];
	revealFocus: number[];
	revealGlow: number[];
	revealF: number[];
	revealR: number[];
	revealU: number[];
	/** lens centre, u right / v DOWN */
	lens: [number, number];
	depthLog: [number, number];
	depthLuma: [number, number];
	mode: number;
	layerOpacity: number;
	ridges: number;
	depthTint: number;
	method: number;
	swipe: number;
	lensR: number;
	rangeM: number;
	keepSky: number;
	feather: number;
	/** output width / height */
	aspect: number;
	fgOn: number;
	hasPhoto: number;
	depthGain: number;
	/** 0 = turbo, 1 = the depthC/DE stops */
	depthRampKind: number;
	depthN: number;
	occlOn: number;
	pad0: number;
};

export const compositeModule = {
	name: "composite",
	source: /* wgsl */ `\
struct CompositeUniforms {
  depthC0: mat4x4<f32>,
  depthC1: mat4x4<f32>,
  depthDE: mat4x4<f32>,
  hair: vec4<f32>,
  reveal: vec4<f32>,
  revealWin: vec4<f32>,
  revealQD: vec4<f32>,
  revealQE: vec4<f32>,
  revealShape: vec4<f32>,
  revealFocus: vec4<f32>,
  revealGlow: vec4<f32>,
  revealF: vec4<f32>,
  revealR: vec4<f32>,
  revealU: vec4<f32>,
  lens: vec2<f32>,
  depthLog: vec2<f32>,
  depthLuma: vec2<f32>,
  mode: f32,
  layerOpacity: f32,
  ridges: f32,
  depthTint: f32,
  method: f32,
  swipe: f32,
  lensR: f32,
  rangeM: f32,
  keepSky: f32,
  feather: f32,
  aspect: f32,
  fgOn: f32,
  hasPhoto: f32,
  depthGain: f32,
  depthRampKind: f32,
  depthN: f32,
  occlOn: f32,
  pad0: f32,
};
@group(0) @binding(auto) var<uniform> composite: CompositeUniforms;
`,
	uniformTypes: {
		depthC0: "mat4x4<f32>",
		depthC1: "mat4x4<f32>",
		depthDE: "mat4x4<f32>",
		hair: "vec4<f32>",
		reveal: "vec4<f32>",
		revealWin: "vec4<f32>",
		revealQD: "vec4<f32>",
		revealQE: "vec4<f32>",
		revealShape: "vec4<f32>",
		revealFocus: "vec4<f32>",
		revealGlow: "vec4<f32>",
		revealF: "vec4<f32>",
		revealR: "vec4<f32>",
		revealU: "vec4<f32>",
		lens: "vec2<f32>",
		depthLog: "vec2<f32>",
		depthLuma: "vec2<f32>",
		mode: "f32",
		layerOpacity: "f32",
		ridges: "f32",
		depthTint: "f32",
		method: "f32",
		swipe: "f32",
		lensR: "f32",
		rangeM: "f32",
		keepSky: "f32",
		feather: "f32",
		aspect: "f32",
		fgOn: "f32",
		hasPhoto: "f32",
		depthGain: "f32",
		depthRampKind: "f32",
		depthN: "f32",
		occlOn: "f32",
		pad0: "f32",
	},
	bindingLayout: [{ name: "composite", group: 0 }],
} as const satisfies ShaderModule;

/** look/glsl/composite.ts COMP_BLOCK minus the ink fields (those are in `ridges`). */
export type LookCompositeUniforms = {
	/** output size, px */
	outSize: [number, number];
	refine: number;
	cut: number;
	maskSoft: number;
	premul: number;
	grain: number;
	pad0: number;
};

export const lookCompositeModule = {
	name: "lookComposite",
	source: /* wgsl */ `\
struct LookCompositeUniforms {
  outSize: vec2<f32>,
  refine: f32,
  cut: f32,
  maskSoft: f32,
  premul: f32,
  grain: f32,
  pad0: f32,
};
@group(0) @binding(auto) var<uniform> lookComposite: LookCompositeUniforms;
`,
	uniformTypes: {
		outSize: "vec2<f32>",
		refine: "f32",
		cut: "f32",
		maskSoft: "f32",
		premul: "f32",
		grain: "f32",
		pad0: "f32",
	},
	bindingLayout: [{ name: "lookComposite", group: 0 }],
} as const satisfies ShaderModule;

/** look/glsl/composite.ts HARM_BLOCK (look/composite.ts harmonizeValues), padded. */
export type BandStatsUniforms = {
	pm: number[];
	ps: number[];
	lm: number[];
	ls: number[];
	amount: number;
	chroma: number;
	pad0: number;
	pad1: number;
};

export const bandStatsModule = {
	name: "bandStats",
	source: /* wgsl */ `\
struct BandStatsUniforms {
  pm: mat4x4<f32>,
  ps: mat4x4<f32>,
  lm: mat4x4<f32>,
  ls: mat4x4<f32>,
  amount: f32,
  chroma: f32,
  pad0: f32,
  pad1: f32,
};
@group(0) @binding(auto) var<uniform> bandStats: BandStatsUniforms;
`,
	uniformTypes: {
		pm: "mat4x4<f32>",
		ps: "mat4x4<f32>",
		lm: "mat4x4<f32>",
		ls: "mat4x4<f32>",
		amount: "f32",
		chroma: "f32",
		pad0: "f32",
		pad1: "f32",
	},
	bindingLayout: [{ name: "bandStats", group: 0 }],
} as const satisfies ShaderModule;

// ---------------------------------------------------------------------------------------------
// WGSL
// ---------------------------------------------------------------------------------------------

/** look/glsl/common.ts TURBO_GLSL (Google's polynomial Turbo), same coefficients. */
export const TURBO_WGSL = /* wgsl */ `\
fn turbo(x0: f32) -> vec3<f32> {
  let x = clamp(x0, 0.0, 1.0);
  let kr = vec4<f32>(0.13572138, 4.61539260, -42.66032258, 132.13108234);
  let kg = vec4<f32>(0.09140261, 2.19418839, 4.84296658, -14.18503333);
  let kb = vec4<f32>(0.10667330, 12.64194608, -60.58204836, 110.36276771);
  let kr2 = vec2<f32>(-152.94239396, 59.28637943);
  let kg2 = vec2<f32>(4.27729857, 2.82956604);
  let kb2 = vec2<f32>(-89.90310912, 27.34824973);
  let v4 = vec4<f32>(1.0, x, x * x, x * x * x);
  let v2 = v4.zw * v4.z;
  return vec3<f32>(dot(v4, kr) + dot(v2, kr2), dot(v4, kg) + dot(v2, kg2), dot(v4, kb) + dot(v2, kb2));
}
`;

/** reveal/glsl.ts REVEAL_GLSL, 1:1. uv is GL uv (v UP) — the ray basis F/R/U and focus.y are. */
export const REVEAL_WGSL = /* wgsl */ `\
fn rv_hash(p: vec2<f32>) -> f32 { return fract(sin(dot(p, vec2<f32>(127.1, 311.7))) * 43758.5453); }
fn rv_noise(p: vec2<f32>) -> f32 {
  let i = floor(p);
  var f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(rv_hash(i), rv_hash(i + vec2<f32>(1.0, 0.0)), f.x),
             mix(rv_hash(i + vec2<f32>(0.0, 1.0)), rv_hash(i + vec2<f32>(1.0, 1.0)), f.x), f.y);
}
fn rv_fbm(p: vec2<f32>) -> f32 {
  return 0.5 * rv_noise(p) + 0.3 * rv_noise(p * 2.03 + 7.1) + 0.2 * rv_noise(p * 4.07 + 3.7);
}
fn rv_seg(x: f32, a: f32, b: f32) -> f32 { return clamp((x - a) / max(b - a, 1e-4), 0.0, 1.0); }
// 65 % area-equalised (piecewise-linear through the 20..80 % quantiles), 35 % linear
fn rv_eq(x: f32, lo: f32, q: vec4<f32>, hi: f32) -> f32 {
  var t: f32;
  if (x < q.x) { t = 0.2 * rv_seg(x, lo, q.x); }
  else if (x < q.y) { t = 0.2 + 0.2 * rv_seg(x, q.x, q.y); }
  else if (x < q.z) { t = 0.4 + 0.2 * rv_seg(x, q.y, q.z); }
  else if (x < q.w) { t = 0.6 + 0.2 * rv_seg(x, q.z, q.w); }
  else { t = 0.8 + 0.2 * rv_seg(x, q.w, hi); }
  return 0.35 * rv_seg(x, lo, hi) + 0.65 * t;
}

fn reveal_at(uv: vec2<f32>, range: f32, a: vec4<f32>, win: vec4<f32>, qD: vec4<f32>, qE: vec4<f32>,
             shape: vec4<f32>, focus: vec4<f32>, F: vec3<f32>, R: vec3<f32>, U: vec3<f32>, aspect: f32) -> vec3<f32> {
  let t = a.x;
  let mode = i32(a.y + 0.5);
  let soft = max(shape.x, 1e-3);
  let gw = max(shape.y, 1e-3);
  let grain = shape.z;
  var tD = 1.0;
  var tE = 1.0;
  if (range > 0.0) {
    tD = rv_eq(log(range), win.x, qD, win.y);
    let d = normalize(F + R * (uv.x * 2.0 - 1.0) + U * (uv.y * 2.0 - 1.0));
    let horiz = range * length(d.xy);
    // ENU z drops below the tangent plane with distance: add it back (k = 0.13 refraction)
    let h = a.z + range * d.z + horiz * horiz * (0.87 / 12742000.0);
    tE = rv_eq(h, win.z, qE, win.w);
  }
  let sp = vec2<f32>(uv.x * aspect, uv.y);
  var f: f32;
  if (mode == 1) { f = (1.0 - tE) * 0.8 + tD * 0.2; }
  else if (mode == 2) { f = tE * 0.85 + tD * 0.15; }
  else if (mode == 3) {
    let ds = length(sp - vec2<f32>(focus.x * aspect, focus.y)) / max(aspect, 1.0);
    let dd = tD - focus.z;
    let de = tE - focus.w;
    f = min(1.0, sqrt(ds * ds + 0.5 * dd * dd + 0.3 * de * de) / 0.9);
  }
  else if (mode == 4) { f = (floor(tE * 8.0) + tD * 0.7) / 8.7; }
  else if (mode == 5) { f = uv.x * 0.8 + (1.0 - tE) * 0.2; }
  else if (mode == 6) { f = mix(tD, rv_hash(floor(sp * 240.0)), 0.45); }
  else { f = tD; }
  if (a.w > 1.5) { f = 1.0 - f; }
  if (range <= 0.0) { f = 1.0; }
  f += (rv_fbm(sp * 11.0) - 0.5) * grain;

  let p = -(soft + grain * 0.5) + t * (1.0 + 2.0 * soft + grain);
  let alpha = 1.0 - smoothstep(p - soft, p, f);
  let lead = gw * 1.5;
  let ridgeA = 1.0 - smoothstep(p + lead - soft, p + lead, f);
  var g = (f - (p - soft * 0.4)) / gw;
  // a longer tail behind the front than ahead of it
  g *= select(1.0, 0.55, g < 0.0);
  let glow = exp(-g * g) * smoothstep(0.0, 0.06, t) * (1.0 - smoothstep(0.82, 1.0, t));
  return vec3<f32>(alpha, glow, ridgeA);
}

fn reveal_light(col: vec3<f32>, rv: vec3<f32>, range: f32, lineA: f32, ridge: f32, glowC: vec4<f32>,
                dim: f32, keep: f32) -> vec3<f32> {
  let terrain = select(0.0, 1.0, range > 0.0);
  let c = col * mix(1.0 - dim * terrain, 1.0, rv.x);
  let light = rv.y * keep * (terrain * (0.08 + 0.9 * lineA) + ridge * 1.6);
  return c + glowC.rgb * glowC.a * light;
}
`;

const HRM_C = BAND_CENTERS_LOG10.map((x) => x.toFixed(6)).join(", ");

/** look/glsl/composite.ts + oklab.ts + common.ts helpers used by REFINE / HARMONIZE / OUTPUT. */
const LOOK_BLEND_WGSL = /* wgsl */ `\
fn linear_to_oklab(c0: vec3<f32>) -> vec3<f32> {
  let c = max(c0, vec3<f32>(0.0));
  var l = 0.4122214708 * c.r + 0.5363325363 * c.g + 0.0514459929 * c.b;
  var m = 0.2119034982 * c.r + 0.6806995451 * c.g + 0.1073969566 * c.b;
  var s = 0.0883024619 * c.r + 0.2817188376 * c.g + 0.6299787005 * c.b;
  l = pow(l, 1.0 / 3.0); m = pow(m, 1.0 / 3.0); s = pow(s, 1.0 / 3.0);
  return vec3<f32>(
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s);
}
fn oklab_to_linear(c: vec3<f32>) -> vec3<f32> {
  var l = c.x + 0.3963377774 * c.y + 0.2158037573 * c.z;
  var m = c.x - 0.1055613458 * c.y - 0.0638541728 * c.z;
  var s = c.x - 0.0894841775 * c.y - 1.2914855480 * c.z;
  l = l * l * l; m = m * m * m; s = s * s * s;
  return vec3<f32>(
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s);
}
const HRM_C: vec4<f32> = vec4<f32>(${HRM_C});
fn hrm_band(m: mat4x4<f32>, lg: f32) -> vec3<f32> {
  if (lg <= HRM_C.x) { return m[0].xyz; }
  if (lg >= HRM_C.w) { return m[3].xyz; }
  if (lg < HRM_C.y) { return mix(m[0].xyz, m[1].xyz, (lg - HRM_C.x) / (HRM_C.y - HRM_C.x)); }
  if (lg < HRM_C.z) { return mix(m[1].xyz, m[2].xyz, (lg - HRM_C.y) / (HRM_C.z - HRM_C.y)); }
  return mix(m[2].xyz, m[3].xyz, (lg - HRM_C.z) / (HRM_C.w - HRM_C.z));
}
// Reinhard transfer in Oklab toward the photo's band statistics at this range (sky = the far band)
fn harmonize(lin: vec3<f32>, range: f32) -> vec3<f32> {
  var lg = HRM_C.w;
  if (range > 0.0) { lg = log(range) / log(10.0); }
  let lab = linear_to_oklab(lin);
  let ratio = clamp(hrm_band(bandStats.ps, lg) / hrm_band(bandStats.ls, lg), vec3<f32>(0.5), vec3<f32>(2.0));
  let t = (lab - hrm_band(bandStats.lm, lg)) * ratio + hrm_band(bandStats.pm, lg);
  let k = vec3<f32>(bandStats.amount, vec2<f32>(bandStats.amount * bandStats.chroma));
  return max(oklab_to_linear(mix(lab, t, k)), vec3<f32>(0.0));
}
// Khronos PBR Neutral; toe scales the black-level offset
fn pbr_neutral(c0: vec3<f32>, toe: f32) -> vec3<f32> {
  let startCompression = 0.8 - 0.04;
  let desaturation = 0.15;
  var color = c0;
  let x = min(color.r, min(color.g, color.b));
  var offset = 0.04;
  if (x < 0.08) { offset = x - 6.25 * x * x; }
  color -= vec3<f32>(offset * toe);
  let peak = max(color.r, max(color.g, color.b));
  if (peak < startCompression) { return color; }
  let d = 1.0 - startCompression;
  let newPeak = 1.0 - d * d / (peak + d - startCompression);
  color *= newPeak / peak;
  let g = 1.0 - 1.0 / (desaturation * (peak - newPeak) + 1.0);
  return mix(color, vec3<f32>(newPeak), g);
}
// the replacing layer: harmonised toward the photo, then tone mapped
fn look_layer(c0: vec3<f32>, range: f32) -> vec3<f32> {
  var c = c0;
#ifdef LOOK_HARMONIZE
  c = harmonize(c, range);
#endif
#ifdef LOOK_OUTPUT
  c = pbr_neutral(c, 1.0 - bandStats.amount);
#endif
  return c;
}
fn soft_mask(q: f32) -> f32 { return smoothstep(0.5 - lookComposite.maskSoft, 0.5 + lookComposite.maskSoft, q); }
// layerAt(): the straight layer colour; on a premultiplied (MSAA-coverage) style, holes next to
// the terrain edge are filled from neighbours so a refined coverage past the DEM silhouette never
// pulls in the clear colour. Ring offsets keep the GL angles (y negated for top-first rows).
fn layer_at(uv: vec2<f32>) -> vec4<f32> {
  let l = layer_texel(uv);
  if (lookComposite.premul < 0.5) { return unpremultiply(l); }
  if (l.a > 0.995) { return vec4<f32>(l.rgb / l.a, l.a); }
  var acc = l.rgb * 4.0;
  var wa = l.a * 4.0;
  let px = 1.0 / lookComposite.outSize;
  for (var ring = 1; ring <= 3; ring++) {
    let rad = f32(ring * ring) * 1.5 + 0.5;
    for (var k = 0; k < 8; k++) {
      let ang = f32(k) * 0.7853982 + f32(ring) * 0.39;
      let s = layer_texel(uv + vec2<f32>(cos(ang), -sin(ang)) * rad * px);
      let w = 1.0 / f32(ring);
      acc += s.rgb * w;
      wa += s.a * w;
    }
  }
  var rgb = vec3<f32>(0.0);
  if (wa > 1e-4) { rgb = acc / wa; }
  return vec4<f32>(rgb, l.a);
}
fn layer_premul() -> bool {
#ifdef LOOK_REFINE
  return lookComposite.premul > 0.5;
#else
  return false;
#endif
}
fn look_encode(c0: vec3<f32>) -> vec3<f32> {
  let c = max(c0, vec3<f32>(0.0));
  return mix(c * 12.92, 1.055 * pow(c, vec3<f32>(1.0 / 2.4)) - 0.055, step(vec3<f32>(0.0031308), c));
}
fn ign(p: vec2<f32>) -> f32 { return fract(52.9829189 * fract(dot(p, vec2<f32>(0.06711056, 0.00583715)))); }
fn hash12(p: vec2<f32>) -> f32 {
  var p3 = fract(vec3<f32>(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
fn gauss(p: vec2<f32>) -> f32 {
  let s = hash12(p) + hash12(p + 17.31) + hash12(p + 41.7) + hash12(p + 73.1);
  return (s - 2.0) * 1.7320508;
}
// linear → display: exact sRGB, grain on the replaced pixels, triangular ±1 LSB dither everywhere
fn look_output(col: vec3<f32>, grainA: f32, frag: vec2<f32>) -> vec3<f32> {
  let c = look_encode(col) + grainA * lookComposite.grain * gauss(frag);
  return c + (ign(frag) + ign(frag + vec2<f32>(47.0, 17.0)) - 1.0) / 255.0;
}
`;

/**
 * The fragment program. Defines (luma WGSL preprocessor: single-name #ifdef only, so the unions
 * are computed on the CPU, compositeDefines()):
 *   LOOK_INK / LOOK_REFINE / LOOK_HARMONIZE / LOOK_OUTPUT   the look's composite features
 *   LOOK_BLEND   REFINE || HARMONIZE || OUTPUT   (lookComposite + bandStats blocks, look helpers)
 *   LOOK_MASK    INK || REFINE                   (the refined-mask texture is bound)
 */
export const COMPOSITE_WGSL = /* wgsl */ `\
${colorWGSL}
${fullscreenWGSL}
${rampWGSL}
${TURBO_WGSL}
${REVEAL_WGSL}

@group(0) @binding(auto) var photoTex: texture_2d<f32>;
@group(0) @binding(auto) var photoTexSampler: sampler;
@group(0) @binding(auto) var layerTex: texture_2d<f32>;
@group(0) @binding(auto) var geometryTex: texture_2d<f32>;
@group(0) @binding(auto) var fgTex: texture_2d<f32>;
@group(0) @binding(auto) var fgTexSampler: sampler;
@group(0) @binding(auto) var brushTex: texture_2d<f32>;
@group(0) @binding(auto) var brushTexSampler: sampler;
@group(0) @binding(auto) var occlTex: texture_2d<f32>;
@group(0) @binding(auto) var occlTexSampler: sampler;
#ifdef LOOK_MASK
@group(0) @binding(auto) var maskTex: texture_2d<f32>;
@group(0) @binding(auto) var maskTexSampler: sampler;
#endif
#ifdef LOOK_INK
@group(0) @binding(auto) var normalTex: texture_2d<f32>;
#endif

// the colour target (canvas-sized, DPR ≤ 2) read like the GL nearest-filter texture()
fn layer_texel(uv: vec2<f32>) -> vec4<f32> {
  let d = vec2<f32>(textureDimensions(layerTex));
  return textureLoad(layerTex, vec2<i32>(clamp(floor(uv * d), vec2<f32>(0.0), d - 1.0)), 0);
}
fn unpremultiply(l: vec4<f32>) -> vec4<f32> {
  if (l.a <= 1e-5) { return vec4<f32>(0.0); }
  return vec4<f32>(l.rgb / l.a, l.a);
}

#ifdef LOOK_BLEND
${LOOK_BLEND_WGSL}
#endif

@fragment fn fragmentMain(v: FullscreenOut) -> @location(0) vec4<f32> {
  let uv = v.uv;
  // implicit-LOD / filtered samples first (WGSL uniform control flow)
  let photoS = textureSample(photoTex, photoTexSampler, uv).rgb;
  let fgS = textureSampleLevel(fgTex, fgTexSampler, uv, 0.0).r;
  let brushS = textureSampleLevel(brushTex, brushTexSampler, uv, 0.0).r;
  let occlS = textureSampleLevel(occlTex, occlTexSampler, uv, 0.0).r;
#ifdef LOOK_MASK
  let maskS = textureSampleLevel(maskTex, maskTexSampler, uv, 0.0);
#endif

  // the photo arrives linear (rgba8unorm-srgb)
  var col = vec3<f32>(0.0);
  if (composite.hasPhoto > 0.5) { col = photoS; }
  let premul = layer_texel(uv);
#ifdef LOOK_REFINE
  let layer = layer_at(uv);
#else
  let layer = unpremultiply(premul);
#endif
  // ridges + skyline + range (layers/ridges.ts; the centre texel's range)
  let rs = ridge_detect(geometryTex, uv, ridges);
  let range = rs.range;
  // people & other foreground: keep the photo untouched there
  var fg = composite.fgOn * fgS;
  // terrain coverage (look composite: snapped to the photo's edges while the refined masks are fresh)
  var cov = layer.a;
#ifdef LOOK_REFINE
  if (lookComposite.refine > 0.5) {
    cov = soft_mask(maskS.r);
    fg = composite.fgOn * soft_mask(maskS.b);
  }
#endif
  // concord DSM occluder: dim, don't hide
  if (composite.occlOn > 0.5) { fg = max(fg, 0.8 * occlS); }
  let ridge = rs.ridge;
#ifdef LOOK_INK
  let ink = ink_lines(geometryTex, normalTex, maskTex, maskTexSampler, uv, range, cov, ridges);
#endif
#ifdef LOOK_OUTPUT
  var grainA = 0.0;
#endif
  // reveal: x = overlay alpha, y = light band, z = ridge alpha (1, 0, 1 when off). GL uv (v up).
  var rv = vec3<f32>(1.0, 0.0, 1.0);
  if (composite.reveal.w > 0.0) {
    rv = reveal_at(vec2<f32>(uv.x, 1.0 - uv.y), range, composite.reveal, composite.revealWin,
                   composite.revealQD, composite.revealQE, composite.revealShape, composite.revealFocus,
                   composite.revealF.xyz, composite.revealR.xyz, composite.revealU.xyz, composite.aspect);
  }

  if (composite.mode < 0.5) {
    if (composite.depthTint > 0.0 && range > 0.0 && fg < 0.5) {
      let t = clamp((log(range) - composite.depthLog.x) * composite.depthLog.y, 0.0, 1.0);
      var dc: vec3<f32>;
      if (composite.depthRampKind < 0.5) { dc = turbo(t); }
      else { dc = to_linear(ramp_eval(composite.depthC0, composite.depthC1, composite.depthDE, composite.depthN, t)); }
      col = mix(col, dc * (composite.depthLuma.x + composite.depthLuma.y * dot(col, vec3<f32>(0.333)) * 1.4),
                composite.depthTint * composite.depthGain * rv.x);
    }
    let k = composite.layerOpacity * (1.0 - fg) * rv.x;
#ifdef LOOK_REFINE
    // layer_at's (hole-filled) straight colour, as the GLSL
    col = mix(col, layer.rgb, layer.a * k);
#else
    // premultiplied over: mix(col, rgb, a·k) = col·(1 − a·k) + (rgb·a)·k
    col = col * (1.0 - premul.a * k) + premul.rgb * k;
#endif
#ifdef LOOK_INK
    col = ink_apply(col, ink, composite.ridges * (1.0 - fg) * rv.z, ridges);
#else
    col = ridge_overlay(col, rs, composite.ridges * (1.0 - fg) * rv.z, ridges);
#endif
    if (composite.reveal.w > 0.0) {
      col = reveal_light(col, rv, range, layer.a * composite.layerOpacity, ridge * composite.ridges,
                         composite.revealGlow, composite.revealShape.w, 1.0 - fg);
    }
  } else {
    let method = i32(composite.method + 0.5);
    var m = 0.0;
    let f = max(composite.feather, 0.001);
    if (method == 0) { m = smoothstep(composite.swipe - f * 0.5, composite.swipe + f * 0.5, uv.x); }
    else if (method == 1) {
      let d = length((uv - composite.lens) * vec2<f32>(composite.aspect, 1.0));
      m = 1.0 - smoothstep(composite.lensR - f, composite.lensR + f, d);
    } else if (method == 2) {
      var rr = 1e9;
      if (range > 0.0) { rr = range; }
      m = smoothstep(composite.rangeM * (1.0 - f * 4.0), composite.rangeM * (1.0 + f * 4.0), rr);
    } else { m = brushS; }
#ifdef LOOK_REFINE
    // the range / brush cut snapped to the photo's edges
    if (lookComposite.cut > 0.5 && method >= 2) { m = soft_mask(maskS.g); }
#endif
    // hairline where the user's mask edge crosses (not around sky or people)
    let edgeLine = (1.0 - abs(m - 0.5) * 2.0) * cov * (1.0 - fg);
    if (composite.keepSky > 0.5) { m *= cov; }
    m *= 1.0 - fg;
    let m0 = m;
    m *= rv.x;
#ifdef LOOK_BLEND
    var wl = max(layer.a, 1.0 - composite.keepSky);
    if (layer_premul()) { wl = 1.0; }
    let a = m * wl;
    col = mix(col, look_layer(layer.rgb, range), a);
#else
    col = mix(col, layer.rgb, m * max(layer.a, 1.0 - composite.keepSky));
#endif
#ifdef LOOK_OUTPUT
    grainA = a;
#endif
    if (method != 3) { col = mix(col, composite.hair.rgb, smoothstep(0.7, 1.0, edgeLine) * composite.hair.a); }
#ifdef LOOK_INK
    col = ink_apply(col, ink, composite.ridges * m, ridges);
#else
    col = ridge_replace(col, rs, composite.ridges * m, ridges);
#endif
    if (composite.reveal.w > 0.0) {
      col = reveal_light(col, rv, range, m0, ridge * composite.ridges * m0, composite.revealGlow,
                         composite.revealShape.w * m0, 1.0 - fg);
    }
  }
#ifdef LOOK_OUTPUT
  // GL gl_FragCoord (y from the bottom) seeds the grain / dither, as in the WebGL frame
  let frag = vec2<f32>(v.position.x, lookComposite.outSize.y - v.position.y);
  return vec4<f32>(look_output(col, grainA, frag), 1.0);
#else
  return vec4<f32>(srgb_encode(min(col, vec3<f32>(1.0))), 1.0);
#endif
}
`;

// ---------------------------------------------------------------------------------------------
// CPU side
// ---------------------------------------------------------------------------------------------

const COMPOSITE_LOOK_DEFINES = [
	"LOOK_HARMONIZE",
	"LOOK_INK",
	"LOOK_OUTPUT",
	"LOOK_REFINE",
] as const;

/** The WGSL define set for a look's define list (only the composite ones; + the derived unions). */
export function compositeDefines(
	defines: readonly LookDefine[],
): Record<string, boolean> {
	const on = new Set(
		defines.filter((d) =>
			(COMPOSITE_LOOK_DEFINES as readonly string[]).includes(d),
		),
	);
	const out: Record<string, boolean> = {};
	for (const d of on) out[d] = true;
	if (
		on.has("LOOK_REFINE") ||
		on.has("LOOK_HARMONIZE") ||
		on.has("LOOK_OUTPUT")
	)
		out.LOOK_BLEND = true;
	if (on.has("LOOK_INK") || on.has("LOOK_REFINE")) out.LOOK_MASK = true;
	return out;
}

const V0: Vec4 = [0, 0, 0, 0];

/** reveal/config.ts RevealUniforms → the composite block's reveal fields (all 0 = off). */
export function revealUniforms(r: RevealUniforms | null) {
	if (!r)
		return {
			reveal: V0,
			revealWin: V0,
			revealQD: V0,
			revealQE: V0,
			revealShape: V0,
			revealFocus: V0,
			revealGlow: V0,
			revealF: V0,
			revealR: V0,
			revealU: V0,
		};
	return {
		reveal: [...r.a],
		revealWin: [...r.win],
		revealQD: [...r.qD],
		revealQE: [...r.qE],
		revealShape: [...r.shape],
		revealFocus: [...r.focus],
		revealGlow: [...r.glow],
		revealF: [...r.F, 0],
		revealR: [...r.R, 0],
		revealU: [...r.U, 0],
	};
}

/** The `composite` block values (deck/composite.ts propsFor, same mapping). */
export function compositeUniforms(o: {
	settings: CompositeSettings;
	style: DeckCompositeStyle;
	reveal: RevealUniforms | null;
	width: number;
	height: number;
	hasPhoto: boolean;
	hasForeground: boolean;
	hasOccluder: boolean;
}): CompositeUniforms {
	const s = o.settings;
	const st = o.style;
	return {
		depthC0: st.depthRamp.c0,
		depthC1: st.depthRamp.c1,
		depthDE: st.depthRamp.de,
		hair: [...st.hair],
		...revealUniforms(o.reveal),
		lens: [s.lens[0], s.lens[1]],
		depthLog: [st.depthLog[0], st.depthLog[1]],
		depthLuma: [st.depthLuma[0], st.depthLuma[1]],
		mode: s.mode === "overlay" ? 0 : 1,
		layerOpacity: s.layerOpacity,
		ridges: s.ridges,
		depthTint: s.depthTint,
		method: METHOD[s.method],
		swipe: s.swipe,
		lensR: s.lensR,
		rangeM: s.rangeKm * 1000,
		keepSky: s.keepSky ? 1 : 0,
		feather: s.feather,
		aspect: o.width / o.height,
		fgOn: s.protectPeople && o.hasForeground ? 1 : 0,
		hasPhoto: o.hasPhoto ? 1 : 0,
		depthGain: st.depthGain,
		depthRampKind: st.depthRampKind,
		depthN: st.depthRamp.n,
		occlOn: o.hasOccluder ? 1 : 0,
		pad0: 0,
	};
}

type LookValues =
	NonNullable<DeckCompositeLook["values"]> extends (
		w: number,
		h: number,
	) => infer R
		? R
		: never;

function lookCompositeUniforms(v: LookValues | null): LookCompositeUniforms {
	return {
		outSize: [v?.outSize[0] ?? 1, v?.outSize[1] ?? 1],
		refine: v?.refine ?? 0,
		cut: v?.cut ?? 0,
		maskSoft: v?.maskSoft ?? 0.23,
		premul: v?.premul ?? 0,
		grain: v?.grain ?? 0,
		pad0: 0,
	};
}

const IDENTITY16 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function bandStatsUniforms(
	h: DeckCompositeLook["harmonize"],
): BandStatsUniforms {
	return {
		pm: h?.pm ?? IDENTITY16,
		ps: h?.ps ?? IDENTITY16,
		lm: h?.lm ?? IDENTITY16,
		ls: h?.ls ?? IDENTITY16,
		amount: h?.amount ?? 0,
		chroma: h?.chroma ?? 0.6,
		pad0: 0,
		pad1: 0,
	};
}

const NO_LOOK: DeckCompositeLook = {
	defines: [],
	values: null,
	harmonize: null,
	mask: null,
	normal: null,
};

const LINEAR_CLAMP = {
	minFilter: "linear",
	magFilter: "linear",
	addressModeU: "clamp-to-edge",
	addressModeV: "clamp-to-edge",
} as const;

export type CompositeCoreOptions = {
	id?: string;
	/** Photo aspect (sizes the brush canvas, 512 px wide like the WebGL compositor). */
	aspect?: number;
	/** The host's requestRender (every setter here is a composite-only change: "screen"). */
	requestRender?: (scope: "all" | "screen") => void;
	/** Draw order in the screen pass (under labels / markers / gizmos). Default 0. */
	order?: number;
	/**
	 * The host's device (host.device). With it, setPhoto uploads (and builds mips) right away;
	 * without it the first draw uploads a mip-less photo (mip generation encodes render passes,
	 * which cannot happen inside the open screen pass) and upgrades it right after the frame.
	 */
	device?: Device;
};

/**
 * The photo compositor as a screen-pass GpuLayerCore. Same inputs and setters as the WebGL
 * PhotoCompositor (settings, style, reveal, look, photo, people mask, occluder, brush); the
 * offscreen half (geometry + colour passes, MSAA, splats) is the host's.
 */
export class CompositeCore implements GpuLayerCore {
	readonly id: string;
	readonly passes: readonly PassKind[] = ["screen"];
	readonly order: number;
	settings: CompositeSettings = { ...defaultCompositeSettings };
	/** The view style's composite uniforms (ridges, hairline, depth tint); see setStyle. */
	style: DeckCompositeStyle = deckCompositeStyle(CLASSIC);
	/** The overlay reveal's uniforms (src/lib/reveal); null = off. */
	reveal: RevealUniforms | null = null;
	/** The look composite (setLook); defines [] = classic. */
	look: DeckCompositeLook = NO_LOOK;
	readonly brushCanvas: HTMLCanvasElement;
	/** Bumped on every change (feed it to anything that caches the frame). */
	version = 0;
	/** Called after every change, after requestRender("screen"). */
	onChange?: () => void;
	requestRender?: (scope: "all" | "screen") => void;

	private models = new ModelCache();
	private definesKey = "";
	private device?: Device;
	private photoSrc: ImageBitmap | HTMLImageElement | HTMLCanvasElement | null =
		null;
	private photoTex: { value: Texture; owned: boolean } | null = null;
	private fgMask: ByteMask | null = null;
	private fgTex?: Texture;
	private fgDirty = false;
	private occlMask: ByteMask | null = null;
	private occlTex?: Texture;
	private occlDirty = false;
	private brushTex?: Texture;
	private brushDirty = true;
	private maskTex?: Texture;
	private maskSrc: Uint8Array | null = null;
	/** refined masks already on the GPU (compute-bridge.ts); not owned, wins over look.mask */
	private maskExt: Texture | null = null;
	private placeholders?: { photo: Texture; mask: Texture; rgba: Texture };

	constructor(opts: CompositeCoreOptions = {}) {
		this.id = opts.id ?? "composite";
		this.order = opts.order ?? 0;
		this.requestRender = opts.requestRender;
		this.device = opts.device;
		const aspect = opts.aspect ?? 4 / 3;
		// (the XHTML namespace: also a real canvas when the document is not HTML, e.g. a check page)
		this.brushCanvas = document.createElementNS(
			"http://www.w3.org/1999/xhtml",
			"canvas",
		) as HTMLCanvasElement;
		this.brushCanvas.width = 512;
		this.brushCanvas.height = Math.max(1, Math.round(512 / aspect));
	}

	// ---------- setters (all composite-only: requestRender("screen")) ----------

	setSettings(s: Partial<CompositeSettings>) {
		this.settings = { ...this.settings, ...s };
		this.bump();
	}

	/** Ridge / skyline / hairline / depth-tint look (style/deck-apply.ts deckCompositeStyle). */
	setStyle(style: DeckCompositeStyle) {
		if (style === this.style) return;
		this.style = style;
		this.bump();
	}

	setReveal(r: RevealUniforms | null) {
		if (!r && !this.reveal) return;
		this.reveal = r;
		this.bump();
	}

	/** The look composite: defines (a change rebuilds the pipeline), values, masks. */
	setLook(look: DeckCompositeLook | null) {
		this.look = look ?? NO_LOOK;
		this.bump();
	}

	/**
	 * The photo: an image (uploaded here as rgba8unorm-srgb + mips) or a Texture another core
	 * already made (shared, not destroyed here; must be sRGB-format so samples come back linear).
	 */
	setPhoto(
		img: ImageBitmap | HTMLImageElement | HTMLCanvasElement | Texture | null,
	) {
		const isTex = !!img && "format" in (img as object);
		if (isTex) {
			if (this.photoTex?.value === img) return;
			this.dropPhoto();
			this.photoSrc = null;
			this.photoTex = { value: img as Texture, owned: false };
		} else {
			if (img === this.photoSrc && (this.photoTex || !img)) return;
			this.dropPhoto();
			this.photoSrc = img as ImageBitmap | HTMLImageElement | null;
			// outside any pass: full mips now
			if (this.device && this.photoSrc)
				this.photoTex = {
					value: imageTexture(this.device, this.photoSrc, {
						id: `${this.id}-photo`,
					}),
					owned: true,
				};
		}
		this.bump();
	}

	/** The refined masks as a texture (rgba8unorm, row 0 = top; the caller keeps it alive) instead
	 * of look.mask's bytes; null = use look.mask. */
	setMaskTexture(t: Texture | null) {
		if (t === this.maskExt) return;
		this.maskExt = t;
		this.bump();
	}

	/** People mask from segmentForeground (row 0 = top); null clears it. */
	setForegroundMask(mask: ByteMask | null) {
		this.fgMask = mask;
		this.fgDirty = true;
		this.bump();
	}

	get hasForeground() {
		return !!this.fgMask;
	}

	/** concord DSM occluder dim mask; null = off (the composite is then bit-identical). */
	setOccluder(m: ByteMask | null) {
		if (!m && !this.occlMask) return;
		this.occlMask = m;
		this.occlDirty = true;
		this.bump();
	}

	/** engine.ts paint(): into the brush mask (normalised coords, v down). */
	paint(u: number, v: number, radius: number, erase: boolean) {
		const ctx = this.brushCanvas.getContext("2d", {
			willReadFrequently: true,
		}) as CanvasRenderingContext2D;
		const x = u * this.brushCanvas.width;
		const y = v * this.brushCanvas.height;
		const r = radius * this.brushCanvas.width;
		const g = ctx.createRadialGradient(x, y, 0, x, y, r);
		const c = erase ? "0,0,0" : "255,255,255";
		g.addColorStop(0, `rgba(${c},0.9)`);
		g.addColorStop(0.6, `rgba(${c},0.5)`);
		g.addColorStop(1, `rgba(${c},0)`);
		ctx.fillStyle = g;
		ctx.beginPath();
		ctx.arc(x, y, r, 0, Math.PI * 2);
		ctx.fill();
		this.brushDirty = true;
		this.bump();
	}

	clearBrush(fill = false) {
		const ctx = this.brushCanvas.getContext("2d", {
			willReadFrequently: true,
		}) as CanvasRenderingContext2D;
		ctx.fillStyle = fill ? "#fff" : "#000";
		ctx.fillRect(0, 0, this.brushCanvas.width, this.brushCanvas.height);
		this.brushDirty = true;
		this.bump();
	}

	private bump() {
		this.version++;
		this.requestRender?.("screen");
		this.onChange?.();
	}

	// ---------- GpuLayerCore ----------

	/** The composite's uniform-block values for an output size (also used by composite.check.ts). */
	uniformsFor(width: number, height: number) {
		const L = this.look;
		const values =
			L.defines.length && L.values ? L.values(width, height) : null;
		return {
			composite: compositeUniforms({
				settings: this.settings,
				style: this.style,
				reveal: this.reveal,
				width,
				height,
				hasPhoto: !!(this.photoTex || this.photoSrc),
				hasForeground: !!this.fgMask,
				hasOccluder: !!this.occlMask,
			}),
			ridges: ridgeUniforms(
				this.style,
				{ nearFade: this.settings.nearFade },
				values && L.defines.includes("LOOK_INK") ? values : null,
				[width, height],
			),
			lookComposite: lookCompositeUniforms(values),
			bandStats: bandStatsUniforms(L.harmonize),
		};
	}

	draw(ctx: PassContext) {
		if (ctx.kind !== "screen" || !ctx.color || !ctx.geometry) return;
		const device = ctx.device;
		if (this.device && this.device !== device) this.releaseTextures();
		this.device = device;
		this.syncTextures(device);
		const defines = compositeDefines(this.look.defines);
		const dk = Object.keys(defines).sort().join(",");
		if (dk !== this.definesKey) {
			this.models.invalidate();
			this.definesKey = dk;
		}
		const blend = !!defines.LOOK_BLEND;
		const model = this.models.get(`${targetKey(ctx)}|${dk}`, () => {
			const p = screenModelProps(ctx.target);
			return new Model(device, {
				id: `${this.id}-model`,
				source: COMPOSITE_WGSL,
				vertexEntryPoint: "fullscreenVertex",
				fragmentEntryPoint: "fragmentMain",
				modules: [
					compositeModule,
					ridgesModule,
					...(blend ? [lookCompositeModule, bandStatsModule] : []),
				] as never,
				defines,
				vertexCount: 3,
				...p,
			} as never);
		});
		const { width, height } = ctx.target;
		const u = this.uniformsFor(width, height);
		model.shaderInputs.setProps({
			composite: u.composite,
			ridges: u.ridges,
			...(blend
				? { lookComposite: u.lookComposite, bandStats: u.bandStats }
				: {}),
		} as never);
		const ph = this.placeholders as NonNullable<typeof this.placeholders>;
		const bindings: Record<string, Texture> = {
			photoTex: this.photoTex?.value ?? ph.photo,
			layerTex: ctx.color.color,
			geometryTex: ctx.geometry.geometry,
			fgTex: this.fgTex ?? ph.mask,
			brushTex: this.brushTex ?? ph.mask,
			occlTex: this.occlTex ?? ph.mask,
		};
		if (defines.LOOK_MASK)
			bindings.maskTex = this.maskExt ?? this.maskTex ?? ph.rgba;
		if (defines.LOOK_INK) bindings.normalTex = ctx.geometry.normal;
		model.setBindings(bindings);
		model.draw(ctx.renderPass);
	}

	/** Upload whatever changed since the last frame (textures live on the draw's device). */
	private syncTextures(device: Device) {
		this.placeholders ??= makePlaceholders(device);
		if (!this.photoTex && this.photoSrc) {
			// inside the open screen pass: no mip generation (it encodes passes) — level 0 now, the
			// mipmapped texture right after this frame's submit (same task, before the next frame)
			const src = this.photoSrc;
			this.photoTex = {
				value: imageTexture(device, src, {
					id: `${this.id}-photo0`,
					mips: false,
				}),
				owned: true,
			};
			queueMicrotask(() => {
				if (this.photoSrc !== src || this.device !== device) return;
				this.dropPhoto();
				this.photoTex = {
					value: imageTexture(device, src, { id: `${this.id}-photo` }),
					owned: true,
				};
				this.requestRender?.("screen");
			});
		}
		if (this.fgDirty) {
			this.fgTex?.destroy();
			const m = this.fgMask;
			this.fgTex = m
				? maskTexture(device, m.data, m.width, m.height, `${this.id}-fg`)
				: undefined;
			this.fgDirty = false;
		}
		if (this.occlDirty) {
			this.occlTex?.destroy();
			const m = this.occlMask;
			this.occlTex = m
				? maskTexture(device, m.data, m.width, m.height, `${this.id}-occl`)
				: undefined;
			this.occlDirty = false;
		}
		if (this.brushDirty) {
			const { width, height } = this.brushCanvas;
			const rgba = (
				this.brushCanvas.getContext("2d", {
					willReadFrequently: true,
				}) as CanvasRenderingContext2D
			).getImageData(0, 0, width, height).data;
			const r = new Uint8Array(width * height);
			for (let i = 0; i < r.length; i++) r[i] = rgba[i * 4];
			if (!this.brushTex)
				this.brushTex = maskTexture(
					device,
					r,
					width,
					height,
					`${this.id}-brush`,
				);
			else
				this.brushTex.writeData(r as never, {
					width,
					height,
					bytesPerRow: width,
				});
			this.brushDirty = false;
		}
		const lm = this.look.mask;
		if ((lm?.data ?? null) !== this.maskSrc) {
			this.maskTex?.destroy();
			this.maskTex = undefined;
			this.maskSrc = lm?.data ?? null;
			if (lm) this.maskTex = rgbaTexture(device, lm.data, lm.w, lm.h);
		}
	}

	private dropPhoto() {
		if (this.photoTex?.owned) this.photoTex.value.destroy();
		this.photoTex = null;
	}

	private releaseTextures() {
		this.models.invalidate();
		if (this.photoTex?.owned) this.photoTex = null;
		this.fgTex?.destroy();
		this.occlTex?.destroy();
		this.brushTex?.destroy();
		this.maskTex?.destroy();
		this.fgTex = this.occlTex = this.brushTex = this.maskTex = undefined;
		this.maskSrc = null;
		this.fgDirty = !!this.fgMask;
		this.occlDirty = !!this.occlMask;
		this.brushDirty = true;
		if (this.placeholders)
			for (const t of Object.values(this.placeholders)) t.destroy();
		this.placeholders = undefined;
	}

	destroy() {
		this.dropPhoto();
		this.releaseTextures();
		this.models.destroy();
		this.device = undefined;
	}
}

/** The compositor core (the factory the lab / engine assembler calls). */
export function createCompositeCore(opts: CompositeCoreOptions = {}) {
	return new CompositeCore(opts);
}

function rgbaTexture(device: Device, data: Uint8Array, w: number, h: number) {
	const tex = device.createTexture({
		id: "composite-look-mask",
		format: "rgba8unorm",
		width: w,
		height: h,
		usage: USAGE.SAMPLE | USAGE.COPY_DST,
		sampler: LINEAR_CLAMP,
	});
	tex.writeData(data as never, { width: w, height: h, bytesPerRow: w * 4 });
	return tex;
}

function makePlaceholders(device: Device) {
	const photo = device.createTexture({
		id: "composite-photo0",
		format: "rgba8unorm-srgb",
		width: 1,
		height: 1,
		usage: USAGE.SAMPLE | USAGE.COPY_DST,
		sampler: LINEAR_CLAMP,
	});
	photo.writeData(new Uint8Array([0, 0, 0, 255]) as never, {
		width: 1,
		height: 1,
	});
	const mask = maskTexture(
		device,
		new Uint8Array([0]),
		1,
		1,
		"composite-mask0",
	);
	const rgba = rgbaTexture(device, new Uint8Array(4), 1, 1);
	return { photo, mask, rgba };
}

/*
 * WIRING (the assembler: lab.ts / the engine port; nothing here is wired by this file):
 * 1. Replace PresentCore with the compositor (keep PresentCore for ?view=geometry|normal|depth):
 *      const composite = createCompositeCore({
 *        aspect: photo.width / photo.height,
 *        requestRender: (s) => host.requestRender(s),
 *      });
 *      host.cores = [terrain, ...colourCores, composite];      // screen pass, order 0
 * 2. Inputs, same as the WebGL PhotoCompositor (deck/engine.ts calls them 1:1):
 *      composite.setPhoto(bitmap | sharedSrgbTexture)
 *      composite.setSettings(compositeFor(settings))            // deck/settings-map.ts
 *      composite.setStyle(deckCompositeStyle(viewStyle))
 *      composite.setLook({defines, values, harmonize, mask, normal})   // DeckCompositeLook
 *      composite.setReveal(uniforms | null)                     // reveal/controller.ts
 *      composite.setForegroundMask(mask) / setOccluder(mask) / paint(u, v, r, erase) / clearBrush()
 *    Each calls requestRender("screen"): the host re-runs only the screen pass.
 * 3. Terrain styles must write the colour target PREMULTIPLIED (README "Targets"); overlay styles
 *    at alpha 0 (contourOpacity 0) still keep the photo untouched.
 * 4. Not ported here (belong to the engine port): export (renderImage: draw this core into an
 *    offscreen rgba8unorm target at photo size, then TextureReader) and the harmonize band-stats
 *    readback (readLayer: read ColorTargets.color at ≤ 256 px — un-premultiply before the stats).
 */
