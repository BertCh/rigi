// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Imhof-style multidirectional relief and hypsometric tint, WGSL. Pure functions: no textures, no
// uniforms, no derivatives (the caller passes everything). Normal in ENU (z up); positions metres.
// Mirrored by relief.glsl.ts; keep the two in step.

import {buildHypsoRamp} from './lut';

const hypsoRamp = buildHypsoRamp('vec3<f32>', e => `  tint = ${e};`).replace(
  '  tint = vec3',
  '  var tint = vec3'
);

export const RELIEF_WGSL = /* wgsl */ `
const LK_FLAT_RAW: f32 = 0.70710678;  // sin(45 deg): every light's shade on level ground
const LK_FLAT_SHADE: f32 = 0.75;      // where flat ground sits in the returned L

// Returns rgb = a gentle cool/warm colour cast (brightness neutral, low saturation) and
// a = shade L in 0..1 (0.75 on level ground). Brightness is applied once, by lk_hypso(elev, L).
fn lk_relief(normal: vec3<f32>, elevM: f32, rangeM: f32, panoramaMix: f32) -> vec4<f32> {
  let n = normalize(normal);
  let slope = acos(clamp(n.z, -1.0, 1.0));
  // Downslope azimuth, clockwise from north: the horizontal part of the normal points downhill.
  // Level ground has no aspect (atan2(0, 0) is not portable); any value gives the same shade.
  let aspect = select(atan2(n.x, n.y), 0.0, n.x == 0.0 && n.y == 0.0);
  let altitude = 0.78539816;  // 45 deg

  // Four lights at 225, 270, 315, 360 deg. Each is weighted by how squarely it crosses the
  // slope (sin^2 of the angle between light and aspect, plus a floor), so no face is left flat
  // grey as it would be under one light, and the NW light counts 1.6x (Imhof's convention).
  var sum = 0.0;
  var weights = 0.0;
  for (var i = 0; i < 4; i++) {
    let az = radians(225.0 + 45.0 * f32(i));
    let light = vec3<f32>(sin(az) * cos(altitude), cos(az) * cos(altitude), sin(altitude));
    let s = sin(aspect - az);
    let w = (0.2 + s * s) * select(1.0, 1.6, i == 2);
    sum += w * max(dot(n, light), 0.0);
    weights += w;
  }
  let multi = sum / weights;
  let nw = vec3<f32>(-0.5, 0.5, 0.70710678);  // single NW light, 315 deg / 45 deg
  let single = max(dot(n, nw), 0.0);
  // Lean towards the one NW light on real slopes so the sheet keeps a readable light side.
  let hs = mix(multi, single, 0.55 * smoothstep(0.05, 0.4, slope));

  // Aerial contrast: valleys wash out towards flat, high terrain keeps full contrast.
  let aerial = mix(0.55, 1.0, smoothstep(600.0, 3000.0, elevM));
  let contrasted = mix(LK_FLAT_RAW, hs, aerial);

  // Cap the strength (multidirectional shading over-emphasises detail in mountains) and damp
  // pixels whose footprint spans a lot of relief, where shading would shimmer. The panorama
  // grade lights the scene itself, so the plan shading is softened there.
  let damp = (1.0 - 0.5 * smoothstep(150.0, 900.0, rangeM)) * mix(1.0, 0.6, panoramaMix);
  let deviation = clamp((contrasted - LK_FLAT_RAW) * 1.25 * damp, -0.55, 0.25);
  let shade = LK_FLAT_SHADE + deviation;

  // Cool in shade, warm in light, normalised to equal luminance and pulled towards white.
  let cool = vec3<f32>(0.62, 0.72, 0.98) / 0.718;
  let warm = vec3<f32>(1.05, 1.0, 0.88);
  let castColor = mix(cool, warm, smoothstep(0.25, 1.0, shade));
  let tone = mix(vec3<f32>(1.0), castColor, 0.45 * mix(1.0, 0.5, panoramaMix));
  return vec4<f32>(tone, shade);
}

// Hypsometric tint (sRGB 0..1) darkened or lightened by shade L from lk_relief.
fn lk_hypso(elevM: f32, shade: f32) -> vec3<f32> {
${hypsoRamp}
  let brightness = clamp(1.0 + (shade - LK_FLAT_SHADE), 0.45, 1.25);
  return clamp(tint * brightness, vec3<f32>(0.0), vec3<f32>(1.0));
}
`;
