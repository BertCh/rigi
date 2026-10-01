// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Shared GLSL / WGSL of look/clear-air.ts: invert the photo's own haze along the photo camera's ray
// on a drape sample (linear in, linear out). One maths for deck WebGL (LOOK_CLEARAIR, world view
// only, like LOOK_HARMONIZE: an extra uniform block costs the photo-view passes on ANGLE) and the
// WebGPU drape part. Values: clearAirValues(); amount 0 = the identity.
//   vec3 clearAirPhoto(vec3 pcLinear, vec3 worldPos, vec3 photoEye)
//   fn clear_air_photo(pc: vec3<f32>, p: vec3<f32>, eye: vec3<f32>, u: ClearAirUniforms) -> vec3<f32>
// World frame: the camera-anchored ENU frame with the curvature drop baked into z (as atmosphere.ts).
import { ATM_CURV } from "../atmosphere";
import type { ClearAirValues } from "../clear-air";
import { defineBlock } from "./block";

/** vec3s first (std140: stored as vec4), then the vec2, then the floats. */
export const CLEAR_AIR_BLOCK = defineBlock("clr", "clearAir", {
	airlight: "vec3",
	betaR: "vec3",
	h: "vec2",
	betaM: "float",
	amount: "float",
	floor: "float",
});

export const CLEAR_AIR_FNS = /* glsl */ `
float clrAltitude(vec3 p) {
  return p.z + dot(p.xy, p.xy) * ${ATM_CURV.toExponential(9)};
}
float clrPath(float h0, float h1, float L, float H) {
  float x = (h1 - h0) / H;
  float f = abs(x) < 1e-3 ? 1.0 - 0.5 * x : (1.0 - exp(-x)) / x;
  return exp(-h0 / H) * L * f;
}
vec3 clearAirPhoto(vec3 pc, vec3 p, vec3 eye) {
  if (clr_amount <= 0.0) return pc;
  float L = length(p - eye);
  float h0 = clrAltitude(eye);
  float h1 = clrAltitude(p);
  vec3 T = exp(-(clr_betaR * clrPath(h0, h1, L, clr_h.x) + vec3(clr_betaM * clrPath(h0, h1, L, clr_h.y))));
  vec3 J = clamp((pc - clr_airlight) / max(T, vec3(clr_floor)) + clr_airlight, 0.0, 1.0);
  return mix(pc, J, clr_amount);
}
`;

/** The deck (luma GLSL) binding: the std140 block plus the functions. Only in a LOOK_CLEARAIR program. */
export const CLEAR_AIR_LUMA_MODULE = {
	...CLEAR_AIR_BLOCK.lumaModule,
	fs: `${CLEAR_AIR_BLOCK.lumaModule.fs}${CLEAR_AIR_FNS}`,
};

// ---- WGSL (deck-webgpu drape part) ----------------------------------------------------------------

/** WGSL layout: each vec3 shares its 16-byte slot with a scalar (no std140 vec4 trap). */
export type ClearAirUniforms = {
	airlight: [number, number, number];
	amount: number;
	betaR: [number, number, number];
	betaM: number;
	h: [number, number];
	floor: number;
	pad0: number;
};

export const CLEAR_AIR_UNIFORM_TYPES = {
	airlight: "vec3<f32>",
	amount: "f32",
	betaR: "vec3<f32>",
	betaM: "f32",
	h: "vec2<f32>",
	floor: "f32",
	pad0: "f32",
} as const;

export function clearAirUniforms(v: ClearAirValues): ClearAirUniforms {
	return {
		airlight: [v.airlight[0], v.airlight[1], v.airlight[2]],
		amount: v.amount,
		betaR: [v.betaR[0], v.betaR[1], v.betaR[2]],
		betaM: v.betaM,
		h: [v.h[0], v.h[1]],
		floor: v.floor,
		pad0: 0,
	};
}

/** The struct (declare a `var<uniform>` of it in the host module) plus clear_air_photo(). */
export const CLEAR_AIR_WGSL = /* wgsl */ `
struct ClearAirUniforms {
  airlight: vec3<f32>,
  amount: f32,
  betaR: vec3<f32>,
  betaM: f32,
  h: vec2<f32>,
  floor: f32,
  pad0: f32,
};
fn clr_altitude(p: vec3<f32>) -> f32 {
  return p.z + dot(p.xy, p.xy) * ${ATM_CURV.toExponential(9)};
}
fn clr_path(h0: f32, h1: f32, L: f32, H: f32) -> f32 {
  let x = (h1 - h0) / H;
  let f = select((1.0 - exp(-x)) / x, 1.0 - 0.5 * x, abs(x) < 1e-3);
  return exp(-h0 / H) * L * f;
}
fn clear_air_photo(pc: vec3<f32>, p: vec3<f32>, eye: vec3<f32>, u: ClearAirUniforms) -> vec3<f32> {
  if (u.amount <= 0.0) { return pc; }
  let L = length(p - eye);
  let h0 = clr_altitude(eye);
  let h1 = clr_altitude(p);
  let T = exp(-(u.betaR * clr_path(h0, h1, L, u.h.x) + vec3<f32>(u.betaM * clr_path(h0, h1, L, u.h.y))));
  let J = clamp((pc - u.airlight) / max(T, vec3<f32>(u.floor)) + u.airlight, vec3<f32>(0.0), vec3<f32>(1.0));
  return mix(pc, J, u.amount);
}
`;
