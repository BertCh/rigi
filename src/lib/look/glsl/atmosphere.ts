// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Shared GLSL of look/atmosphere.ts (LOOK_ATMOSPHERE): chromatic, altitude-aware aerial perspective
// and the analytic sky, one source for both engines through ATM_BLOCK's accessors (block.ts).
//   vec3 applyAtmosphere(vec3 colLinear, vec3 worldPos)   terrain colour → hazed (linear in, linear out)
//   vec3 atmSky(vec3 dir)                                  background sky radiance (linear)
// World frame: the camera-anchored ENU frame with the curvature drop baked into z (terrain.ts).
import * as THREE from "three";
import { ATM_CURV } from "../atmosphere";
import { NEBELMEER_GLSL } from "../nebelmeer";
import { defineBlock } from "./block";
import { SRGB_ENCODE_GLSL } from "./common";

/** vec3s first (std140: stored as vec4), then the vec2, then the floats. Values: atmosphereValues(). */
export const ATM_BLOCK = defineBlock("atm", "atmosphere", {
	eye: "vec3",
	betaR: "vec3",
	sunDir: "vec3",
	sunColor: "vec3",
	airlight: "vec3",
	nebel: "vec3", // (top m, density 1/m, falloff 1/m); density 0 = no Nebelmeer (look/nebelmeer)
	nebelColor: "vec3",
	h: "vec2",
	betaM: "float",
	strength: "float",
	mieG: "float",
	airlightMix: "float",
});

export const ATMOSPHERE_FNS = /* glsl */ `${NEBELMEER_GLSL}
float atmAltitude(vec3 p) {
  return p.z + dot(p.xy, p.xy) * ${ATM_CURV.toExponential(9)};
}

// sea-level-equivalent path length through an exponential layer of scale height H
float atmPath(float h0, float h1, float L, float H) {
  float x = (h1 - h0) / H;
  float f = abs(x) < 1e-3 ? 1.0 - 0.5 * x : (1.0 - exp(-x)) / x;
  return exp(-h0 / H) * L * f;
}

vec3 atmTransmittance(vec3 worldPos) {
  float L = length(worldPos - atm_eye);
  float h0 = atmAltitude(atm_eye);
  float h1 = atmAltitude(worldPos);
  float dR = atmPath(h0, h1, L, atm_h.x);
  float dM = atmPath(h0, h1, L, atm_h.y);
  return exp(-atm_strength * (atm_betaR * dR + vec3(atm_betaM * dM)));
}

// phase functions normalised so an isotropic scatterer is 1 (i.e. ×4π)
float atmPhaseR(float c) {
  return 0.75 * (1.0 + c * c);
}
float atmPhaseM(float c) {
  float g = atm_mieG;
  float g2 = g * g;
  float p = 1.5 * (1.0 - g2) * (1.0 + c * c) / ((2.0 + g2) * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5));
  return min(p, 40.0);
}

// physically derived airlight: single scattering of the sun, weighted by the local Rayleigh /
// Mie mix at the eye, plus a multiple-scattering ambient from the blue sky dome
vec3 atmPhysAirlight(vec3 viewDir) {
  float c = dot(viewDir, atm_sunDir);
  float h0 = atmAltitude(atm_eye);
  vec3 bR = atm_betaR * exp(-h0 / atm_h.x);
  float bM = atm_betaM * exp(-h0 / atm_h.y);
  vec3 bExt = bR + vec3(bM);
  // Mie single-scatter albedo ~0.9
  vec3 single = (bR * atmPhaseR(c) + vec3(0.9 * bM * atmPhaseM(c))) / max(bExt, vec3(1e-9));
  float day = smoothstep(-0.12, 0.25, atm_sunDir.z);
  vec3 skyAmb = vec3(0.30, 0.40, 0.56) * (0.25 + 0.75 * day);
  // more Mie → whiter, brighter veil
  float mieFrac = bM / max(bM + bR.g, 1e-9);
  vec3 amb = mix(skyAmb, vec3(0.62, 0.66, 0.70) * (0.3 + 0.7 * day), mieFrac);
  return 0.42 * atm_sunColor * single * clamp(atm_sunDir.z * 2.0 + 0.4, 0.0, 1.0) + amb;
}

vec3 atmAirlight(vec3 viewDir) {
  return mix(atmPhysAirlight(viewDir), atm_airlight, atm_airlightMix);
}

// Nebelmeer: the valley-fog layer over the hazed colour; the identity at density 0
vec3 applyNebelmeer(vec3 col, vec3 worldPos) {
  if (atm_nebel.y <= 0.0) return col;
  float T = nebelRayT(length(worldPos - atm_eye), atmAltitude(atm_eye), atmAltitude(worldPos),
    atm_nebel.y, atm_nebel.x, atm_nebel.z);
  return mix(atm_nebelColor, col, T);
}

vec3 applyAtmosphere(vec3 colLinear, vec3 worldPos) {
  vec3 T = atmTransmittance(worldPos);
  return applyNebelmeer(colLinear * T + atmAirlight(normalize(worldPos - atm_eye)) * (1.0 - T), worldPos);
}

// Preetham-like analytic sky: zenith→horizon gradient keyed to sun height, with a Mie aureole
// and a warm horizon band toward a low sun. The horizon converges on the airlight, so terrain
// fades seamlessly into the sky.
vec3 atmSky(vec3 dir) {
  vec3 d = normalize(dir);
  vec3 s = normalize(atm_sunDir);
  float c = dot(d, s);
  float el = d.z;
  float day = smoothstep(-0.12, 0.3, s.z);
  vec3 horizon = atmAirlight(normalize(vec3(d.xy, 0.0) + vec3(0.0, 0.0, 1e-4)));
  // turbid skies are paler at the zenith
  float h0 = atmAltitude(atm_eye);
  float turb = clamp(atm_strength * atm_betaM * exp(-h0 / atm_h.y) / 4e-5, 0.0, 1.0);
  vec3 zenith = mix(vec3(0.10, 0.22, 0.55), vec3(0.32, 0.42, 0.58), turb * 0.6) * (0.08 + 0.92 * day);
  float t = pow(1.0 - clamp(el, 0.0, 1.0), 3.5 + 2.0 * (1.0 - turb));
  vec3 sky = mix(zenith, horizon, t);
  // aureole and sun-side brightening
  float aureole = atmPhaseM(c) * 0.012 * (0.4 + turb);
  sky += atm_sunColor * aureole * smoothstep(-0.1, 0.05, el);
  // low sun: warm band toward the sun's azimuth
  float low = 1.0 - smoothstep(0.0, 0.35, s.z);
  float toward = pow(max(0.5 + 0.5 * dot(normalize(d.xy + 1e-5), normalize(s.xy + 1e-5)), 0.0), 4.0);
  sky = mix(sky, atm_sunColor * vec3(1.0, 0.72, 0.45) * (0.6 + 0.4 * day), low * toward * t * 0.55);
  // below the horizon: haze over ground
  if (el < 0.0) sky = mix(horizon, horizon * 0.8, smoothstep(0.0, -0.3, el));
  return sky;
}
`;

/** The deck (luma) binding: the std140 block plus the functions. Only in a LOOK_ATMOSPHERE program. */
export const ATM_LUMA_MODULE = {
	...ATM_BLOCK.lumaModule,
	fs: `${ATM_BLOCK.lumaModule.fs}${ATMOSPHERE_FNS}`,
};

// ---- sky background (world view, world.sky.mode 'atmosphere') ----------------------------------

/** The sky ray matrix (skyRayMatrix). */
export const SKY_BLOCK = defineBlock("sky", "sky", { ray: "mat4" });

/** Fullscreen triangle from gl_VertexID; vNdc feeds the sky ray. Both engines. */
export const SKY_VS = /* glsl */ `
out vec2 vNdc;
void main() {
  vNdc = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)) * 2.0 - 1.0;
  gl_Position = vec4(vNdc, 1.0, 1.0);
}
`;

/** Sky radiance at this fragment: sky_ray = inverse(projection × view rotation), see skyRayMatrix. */
export const SKY_FS_MAIN = /* glsl */ `
in vec2 vNdc;
vec3 skyColor() {
  vec4 p = sky_ray * vec4(vNdc, 1.0, 1.0);
  return atmSky(p.xyz / p.w);
}
`;

/** deck's sky fragment shader (it encodes sRGB itself; three's colorspace_fragment does it there). */
export const SKY_FS_DECK = /* glsl */ `#version 300 es
precision highp float;
${SKY_FS_MAIN}
${SRGB_ENCODE_GLSL}
out vec4 fragColor;
void main() { fragColor = vec4(srgbEncode(skyColor()), 1.0); }
`;

const _m = new THREE.Matrix4();
const _p = new THREE.Matrix4();

/**
 * inverse(projection × view rotation) as column-major numbers: maps an NDC point to a world-space
 * direction (the view's translation is dropped, so it works for any eye). `view` = world → view.
 */
export function skyRayMatrix(
	projection: ArrayLike<number>,
	view: ArrayLike<number>,
): number[] {
	_m.fromArray(view as number[]).setPosition(0, 0, 0);
	return _p
		.fromArray(projection as number[])
		.multiply(_m)
		.invert()
		.toArray();
}
