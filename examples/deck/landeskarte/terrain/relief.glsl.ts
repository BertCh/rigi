// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// GLSL twin of relief.wgsl.ts (same maths, same constants). Normal in ENU (z up).

import {buildHypsoRamp} from './lut';

const hypsoRamp = buildHypsoRamp('vec3', e => `  tint = ${e};`).replace(
  '  tint = vec3',
  '  vec3 tint = vec3'
);

export const RELIEF_GLSL = /* glsl */ `
const float LK_FLAT_RAW = 0.70710678;  // sin(45 deg): every light's shade on level ground
const float LK_FLAT_SHADE = 0.75;      // where flat ground sits in the returned L

// rgb = gentle cool/warm cast (brightness neutral), a = shade L (0.75 on level ground).
vec4 lk_relief(vec3 normal, float elevM, float rangeM, float panoramaMix) {
  vec3 n = normalize(normal);
  float slope = acos(clamp(n.z, -1.0, 1.0));
  // Downslope azimuth, clockwise from north.
  // Level ground has no aspect (atan(0, 0) is undefined in GLSL); any value gives the same shade.
  float aspect = (n.x == 0.0 && n.y == 0.0) ? 0.0 : atan(n.x, n.y);
  float altitude = 0.78539816;

  float sum = 0.0;
  float weights = 0.0;
  for (int i = 0; i < 4; i++) {
    float az = radians(225.0 + 45.0 * float(i));
    vec3 light = vec3(sin(az) * cos(altitude), cos(az) * cos(altitude), sin(altitude));
    float s = sin(aspect - az);
    float w = (0.2 + s * s) * (i == 2 ? 1.6 : 1.0);
    sum += w * max(dot(n, light), 0.0);
    weights += w;
  }
  float multi = sum / weights;
  vec3 nw = vec3(-0.5, 0.5, 0.70710678);
  float single = max(dot(n, nw), 0.0);
  float hs = mix(multi, single, 0.55 * smoothstep(0.05, 0.4, slope));

  float aerial = mix(0.55, 1.0, smoothstep(600.0, 3000.0, elevM));
  float contrasted = mix(LK_FLAT_RAW, hs, aerial);

  float damp = (1.0 - 0.5 * smoothstep(150.0, 900.0, rangeM)) * mix(1.0, 0.6, panoramaMix);
  float deviation = clamp((contrasted - LK_FLAT_RAW) * 1.25 * damp, -0.55, 0.25);
  float shade = LK_FLAT_SHADE + deviation;

  vec3 cool = vec3(0.62, 0.72, 0.98) / 0.718;
  vec3 warm = vec3(1.05, 1.0, 0.88);
  vec3 castColor = mix(cool, warm, smoothstep(0.25, 1.0, shade));
  vec3 tone = mix(vec3(1.0), castColor, 0.45 * mix(1.0, 0.5, panoramaMix));
  return vec4(tone, shade);
}

// Hypsometric tint (sRGB 0..1) darkened or lightened by shade L from lk_relief.
vec3 lk_hypso(float elevM, float shade) {
${hypsoRamp}
  float brightness = clamp(1.0 + (shade - LK_FLAT_SHADE), 0.45, 1.25);
  return clamp(tint * brightness, vec3(0.0), vec3(1.0));
}
`;
