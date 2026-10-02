// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import {ATMO_WGSL} from '../terrain/atmo.wgsl';

// The dome is one oversized triangle that covers the viewport. Each pixel rebuilds its view ray
// from the camera basis (roll included), asks lk_sky for the radiance and crossfades with the paper.
export const SKY_WGSL = /* wgsl */ `
${ATMO_WGSL}

// Density gain on the sky path: a stand-in for multiple scattering (see lk_sky).
const SKY_GAIN: f32 = 2.5;

struct SkyVertex {
  @builtin(position) position: vec4<f32>,
  @location(0) ndc: vec2<f32>
};

@vertex fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> SkyVertex {
  var corners = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  var result: SkyVertex;
  result.position = vec4<f32>(corners[vertexIndex], 0.0, 1.0);
  result.ndc = corners[vertexIndex];
  return result;
}

// Interleaved gradient noise in [0, 1): breaks up 8-bit banding in the smooth gradient.
fn getDither(pixel: vec2<f32>) -> f32 {
  return fract(52.9829189 * fract(dot(pixel, vec2<f32>(0.06711056, 0.00583715))));
}

@fragment fn fragmentMain(input: SkyVertex) -> @location(0) vec4<f32> {
  let halfHeight = skyDome.tanHalfVfov;
  let ray = normalize(
    skyDome.cameraForward +
    input.ndc.x * skyDome.aspect * halfHeight * skyDome.cameraRight +
    input.ndc.y * halfHeight * skyDome.cameraUp
  );
  var sky = lk_sky(ray, skyDome.eyeHeight, skyDome.sunDirection, skyDome.sunColor, skyDome.strength, SKY_GAIN);
  // Pull the zenith towards the same sky colour the terrain's shade fill uses, so lit ground and
  // dome agree; the horizon stays pure airlight from the same lk_airlight the terrain haze uses.
  sky = mix(sky, skyDome.skyColor, 0.6 * smoothstep(0.0, 0.8, ray.z));
  var color = mix(skyDome.paperColor, sky, skyDome.panoramaMix);
  color += (getDither(input.position.xy) - 0.5) / 255.0 * skyDome.panoramaMix;
  return vec4<f32>(color, 1.0);
}
`;
