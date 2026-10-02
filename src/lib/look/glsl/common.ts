// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Small GLSL helpers, one copy each. Every chunk is a complete function definition, so a shader
// splices in only what it uses. TURBO_GLSL and SRGB_DECODE_GLSL are byte-identical to the classic
// shaders' copies (deck composite-shader.ts, terrain-layer.ts, nearfield/deck-splat-shaders.ts).
// The classic shaders (SRGB_ENCODE_CLASSIC_GLSL, pow 0.41666) differ in the last bits from the exact
// OETF SRGB_ENCODE_GLSL; the look passes (LOOK_OUTPUT) use the exact one. A shader includes one
// srgbEncode or the other, never both.

/** Google's polynomial Turbo colormap approximation. */
export const TURBO_GLSL = /* glsl */ `vec3 turbo(float x) {
  x = clamp(x, 0.0, 1.0);
  vec4 kr = vec4(0.13572138, 4.61539260, -42.66032258, 132.13108234);
  vec4 kg = vec4(0.09140261, 2.19418839, 4.84296658, -14.18503333);
  vec4 kb = vec4(0.10667330, 12.64194608, -60.58204836, 110.36276771);
  vec2 kr2 = vec2(-152.94239396, 59.28637943);
  vec2 kg2 = vec2(4.27729857, 2.82956604);
  vec2 kb2 = vec2(-89.90310912, 27.34824973);
  vec4 v4 = vec4(1.0, x, x * x, x * x * x);
  vec2 v2 = v4.zw * v4.z;
  return vec3(dot(v4, kr) + dot(v2, kr2), dot(v4, kg) + dot(v2, kg2), dot(v4, kb) + dot(v2, kb2));
}`;

/** sRGB EOTF (encoded -> linear), multiply form of the 1/12.92 and 1/1.055 constants. */
export const SRGB_DECODE_GLSL = /* glsl */ `vec3 srgbDecode(vec3 c) {
  return mix(pow(c * 0.9478672986 + vec3(0.0521327014), vec3(2.4)), c * 0.0773993808, vec3(lessThanEqual(c, vec3(0.04045))));
}`;

/** Classic sRGB encode (pow 0.41666 approximation of 1/2.4), negatives clamped to 0. */
export const SRGB_ENCODE_CLASSIC_GLSL = /* glsl */ `vec3 srgbEncode(vec3 c) {
  c = max(c, vec3(0.0));
  return mix(pow(c, vec3(0.41666)) * 1.055 - vec3(0.055), c * 12.92, vec3(lessThanEqual(c, vec3(0.0031308))));
}`;

/** Exact sRGB OETF. */
export const SRGB_ENCODE_GLSL = /* glsl */ `vec3 srgbEncode(vec3 c) {
  c = max(c, vec3(0.0));
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}`;

/** Interleaved gradient noise (Jimenez 2014), for dithering. */
export const IGN_GLSL = /* glsl */ `float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }`;

/** Dave Hoskins' hash without sine. */
export const HASH_GLSL = /* glsl */ `float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}`;

/** Unit-variance, roughly Gaussian noise (sum of four hashes). Needs HASH_GLSL. */
export const GAUSS_GLSL = /* glsl */ `float gauss(vec2 p) {
  float s = hash12(p) + hash12(p + 17.31) + hash12(p + 41.7) + hash12(p + 73.1);
  return (s - 2.0) * 1.7320508; // unit variance
}`;
