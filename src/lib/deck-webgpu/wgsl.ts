// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Shared WGSL: colour transfer functions, ENU helpers and the fog / atmosphere hook. Plain source
// strings (no bindings) are concatenated into a layer's shader; modules with uniforms are luma
// ShaderModules (bind group 0, @binding(auto)).
import type { ShaderModule } from "@luma.gl/shadertools";
import type { DeckTerrainStyle } from "#/lib/style/deck-apply";

/**
 * Colour pipeline (same as the GLSL path): textures decode to linear
 * (rgba8unorm-srgb does it in hardware; srgb_decode for data that arrives encoded), shading and
 * haze happen in linear, the colour target stays linear, the compositor / present pass encodes.
 */
/** sRGB EOTF (encoded -> linear), multiply form of the 1/12.92 and 1/1.055 constants. */
export const srgbDecodeWGSL = /* wgsl */ `\
fn srgb_decode(c: vec3<f32>) -> vec3<f32> {
  let lo = c * 0.0773993808;
  let hi = pow(c * 0.9478672986 + vec3<f32>(0.0521327014), vec3<f32>(2.4));
  return select(hi, lo, c <= vec3<f32>(0.04045));
}
`;

/** Classic sRGB encode (pow 0.41666 approximation of 1/2.4), negatives clamped to 0. */
export const srgbEncodeWGSL = /* wgsl */ `\
fn srgb_encode(c0: vec3<f32>) -> vec3<f32> {
  let c = max(c0, vec3<f32>(0.0));
  let lo = c * 12.92;
  let hi = pow(c, vec3<f32>(0.41666)) * 1.055 - vec3<f32>(0.055);
  return select(hi, lo, c <= vec3<f32>(0.0031308));
}
`;

export const colorWGSL = /* wgsl */ `\
${srgbDecodeWGSL}${srgbEncodeWGSL}// Exact sRGB OETF (the look passes' output encode); srgb_encode above is the classic pow 0.41666 one
fn srgb_encode_exact(c0: vec3<f32>) -> vec3<f32> {
  let c = max(c0, vec3<f32>(0.0));
  return mix(c * 12.92, 1.055 * pow(c, vec3<f32>(1.0 / 2.4)) - 0.055, step(vec3<f32>(0.0031308), c));
}
// The classic ramp decode, materials.ts toLinear: ramp stops are mixed in sRGB and THEN pow 2.2'd
// (not the sRGB EOTF, srgb_decode). Intended; do not "fix" to the exact curve.
fn to_linear(c: vec3<f32>) -> vec3<f32> { return pow(max(c, vec3<f32>(0.0)), vec3<f32>(2.2)); }
fn luminance(c: vec3<f32>) -> f32 { return dot(c, vec3<f32>(0.2126, 0.7152, 0.0722)); }
`;

/** Noise for dithering / grain: interleaved gradient noise (Jimenez 2014), Hoskins' sine-free hash, and unit-variance gauss. */
export const noiseWGSL = /* wgsl */ `\
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
`;

/** ENU helpers. Positions are camera-anchored ENU metres with curvature + refraction already baked
 * in (terrain-data.ts fromGeo), so "up" is +z everywhere to within 0.7° at 80 km. */
export const enuWGSL = /* wgsl */ `\
const ENU_UP: vec3<f32> = vec3<f32>(0.0, 0.0, 1.0);
// compass bearing (deg, 0 = north, clockwise) of an ENU direction
fn enu_bearing(d: vec3<f32>) -> f32 { return (degrees(atan2(d.x, d.y)) + 360.0) % 360.0; }
// elevation angle (deg) of an ENU direction
fn enu_elevation(d: vec3<f32>) -> f32 { return degrees(asin(clamp(normalize(d).z, -1.0, 1.0))); }
`;

export type FogUniforms = {
	/** Linear haze colour, a = density multiplier. */
	color: [number, number, number, number];
	/** x density (1/m), y max amount, z ambient, w direct (hillshade weights). */
	params: [number, number, number, number];
	/** Unit sun direction (ENU), w unused. */
	sun: [number, number, number, number];
};

/** Fog uniforms from the view style's terrain look (style/deck-apply.ts deckTerrainStyle). */
export function fogFromLook(L: DeckTerrainStyle, haze?: number): FogUniforms {
	return {
		color: [...L.hazeColor, haze ?? L.haze],
		params: [L.hazeParams[0], L.hazeParams[1], L.shade[0], L.shade[1]],
		sun: [...L.sunDir, 0],
	};
}

/** Classic look defaults (style/defaults CLASSIC via deck-apply: haze b9cde0, density ~1/60 km). */
export const DEFAULT_FOG: FogUniforms = {
	color: [0.7254902, 0.80392157, 0.87843137, 1],
	params: [1 / 60_000, 0.85, 0.55, 0.6],
	sun: [0.4, 0.3, 0.866, 0],
};

/**
 * The fog / light hook every lit 3D layer calls, so a view style swaps the atmosphere in ONE place:
 *   fog_apply(linearColour, range) → linear colour with haze
 *   fog_shade(normal) → the classic ambient-sky + direct-sun hillshade factor
 * The AtmSky port (layers/atm-sky.ts) may replace fog_apply's body with the physical atmosphere
 * via a define (FOG_ATMOSPHERE) — keep the signature.
 */
export const fogModule = {
	name: "fog",
	source: /* wgsl */ `\
struct FogUniforms {
  color: vec4<f32>,
  params: vec4<f32>,
  sun: vec4<f32>,
};
@group(0) @binding(auto) var<uniform> fog: FogUniforms;

fn fog_shade(n: vec3<f32>) -> f32 {
  let l = max(dot(n, fog.sun.xyz), 0.0);
  let sky = 0.5 + 0.5 * n.z;
  return fog.params.z * sky + fog.params.w * l;
}

fn fog_apply(col: vec3<f32>, range: f32) -> vec3<f32> {
  let f = 1.0 - exp(-range * fog.params.x * fog.color.a);
  // materials.ts re-linearises the (linear) haze colour on purpose: the darker, bluer tone
  return mix(col, pow(fog.color.rgb, vec3<f32>(2.2)), clamp(f, 0.0, fog.params.y));
}
`,
	uniformTypes: {
		color: "vec4<f32>",
		params: "vec4<f32>",
		sun: "vec4<f32>",
	},
	bindingLayout: [{ name: "fog", group: 0 }],
} as const satisfies ShaderModule;

/** Full-screen triangle vertex stage (screen passes, sky). uv: 0..1, y DOWN (texture rows). */
export const fullscreenWGSL = /* wgsl */ `\
struct FullscreenOut {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) ndc: vec2<f32>,
};
@vertex fn fullscreenVertex(@builtin(vertex_index) i: u32) -> FullscreenOut {
  let p = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u)) * 2.0 - 1.0;
  var o: FullscreenOut;
  o.position = vec4<f32>(p, 0.0, 1.0);
  o.ndc = p;
  o.uv = vec2<f32>(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5);
  return o;
}
`;

/**
 * Style ramps (materials.ts RAMP_GLSL rampEval, deck/terrain-layer.ts): stop i = column i of C0
 * (0-3) / C1 (4-7), rgb = sRGB colour, a = t; DE columns 0-1 = segment divisors, 2-3 = smoothstep
 * flags. Mixed in sRGB; callers to_linear() the result. Uniform values: style/deck-apply rampU().
 */
export const rampWGSL = /* wgsl */ `\
fn ramp_stop(C0: mat4x4<f32>, C1: mat4x4<f32>, i: i32) -> vec4<f32> {
  if (i < 4) { return C0[i]; }
  return C1[i - 4];
}
fn ramp_div(DE: mat4x4<f32>, i: i32) -> f32 {
  if (i < 4) { return DE[0][i]; }
  return DE[1][i - 4];
}
fn ramp_ease(DE: mat4x4<f32>, i: i32) -> f32 {
  if (i < 4) { return DE[2][i]; }
  return DE[3][i - 4];
}
fn ramp_eval(C0: mat4x4<f32>, C1: mat4x4<f32>, DE: mat4x4<f32>, nf: f32, t: f32) -> vec3<f32> {
  let n = i32(nf + 0.5);
  var prev = ramp_stop(C0, C1, 0);
  var c = prev.rgb;
  for (var i = 1; i < 8; i++) {
    if (i >= n) { break; }
    let s = ramp_stop(C0, C1, i);
    if (t < s.a || i == n - 1) {
      var f: f32;
      if (ramp_ease(DE, i) > 0.5) { f = smoothstep(prev.a, s.a, t); }
      else { f = clamp((t - prev.a) / ramp_div(DE, i), 0.0, 1.0); }
      c = mix(prev.rgb, s.rgb, f);
      break;
    }
    prev = s;
  }
  return c;
}
`;
