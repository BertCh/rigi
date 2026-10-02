// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import {ATMO_GLSL} from '../terrain/atmo.glsl';

// GLSL twin of sky.wgsl.ts. gl_VertexID replaces the corner table.
export const SKY_GLSL_VERTEX = /* glsl */ `#version 300 es
precision highp float;

out vec2 ndc;

void main() {
  vec2 corner = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
  ndc = corner;
  gl_Position = vec4(corner, 0.0, 1.0);
}
`;

export const SKY_GLSL_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;

in vec2 ndc;
out vec4 fragColor;

${ATMO_GLSL}

const float SKY_GAIN = 2.5;

float getDither(vec2 pixel) {
  return fract(52.9829189 * fract(dot(pixel, vec2(0.06711056, 0.00583715))));
}

void main() {
  float halfHeight = skyDome.tanHalfVfov;
  vec3 ray = normalize(
    skyDome.cameraForward +
    ndc.x * skyDome.aspect * halfHeight * skyDome.cameraRight +
    ndc.y * halfHeight * skyDome.cameraUp
  );
  vec3 sky = lk_sky(ray, skyDome.eyeHeight, skyDome.sunDirection, skyDome.sunColor, skyDome.strength, SKY_GAIN);
  sky = mix(sky, skyDome.skyColor, 0.6 * smoothstep(0.0, 0.8, ray.z));
  vec3 color = mix(skyDome.paperColor, sky, skyDome.panoramaMix);
  color += (getDither(gl_FragCoord.xy) - 0.5) / 255.0 * skyDome.panoramaMix;
  fragColor = vec4(color, 1.0);
}
`;
