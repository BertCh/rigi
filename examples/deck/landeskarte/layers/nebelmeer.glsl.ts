// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// GLSL ES 3.00 twin of nebelmeer.wgsl.ts (WebGL2 fallback). Keep the two in step.

export const NEBELMEER_VS = /* glsl */ `#version 300 es
precision highp float;

in vec2 gridPosition;

out vec3 worldPosition;
out vec2 unitPosition;

void main() {
  float east = nebelmeer.centerEast + gridPosition.x * nebelmeer.extent;
  float north = nebelmeer.centerNorth + gridPosition.y * nebelmeer.extent;
  // Follow the curved, refracted sea level like the terrain does (see the WGSL twin).
  float drop = nebelmeer.curvatureScale * (east * east + north * north) / (2.0 * nebelmeer.earthRadius);
  float up = nebelmeer.baseHeight + nebelmeer.thickness - nebelmeer.originHeight - drop;
  vec3 position = vec3(east, north, up);
  geometry.worldPosition = position;
  gl_Position = project_position_to_clipspace(position, vec3(0.0), vec3(0.0));
  DECKGL_FILTER_GL_POSITION(gl_Position, geometry);
  worldPosition = position;
  unitPosition = gridPosition;
}
`;

export const NEBELMEER_FS = /* glsl */ `#version 300 es
precision highp float;

in vec3 worldPosition;
in vec2 unitPosition;

out vec4 fragColor;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.x, p.y, p.x) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float valueNoise(vec2 p) {
  vec2 cell = floor(p);
  vec2 fraction = fract(p);
  vec2 smoothed = fraction * fraction * (3.0 - 2.0 * fraction);
  float a = hash12(cell);
  float b = hash12(cell + vec2(1.0, 0.0));
  float c = hash12(cell + vec2(0.0, 1.0));
  float d = hash12(cell + vec2(1.0, 1.0));
  return mix(mix(a, b, smoothed.x), mix(c, d, smoothed.x), smoothed.y);
}

float fogNoise(vec2 p, float distanceM) {
  float fine = 1.0 - smoothstep(12000.0, 30000.0, distanceM);
  float coarse = valueNoise(p / 1800.0) * 0.55 + valueNoise(p / 700.0 + 17.0) * 0.30;
  float detail = valueNoise(p / 260.0 + 41.0) * 0.15;
  return coarse + mix(0.5 * 0.15, detail, fine);
}

void main() {
  vec3 toFragment = worldPosition - nebelmeer.cameraPosition;
  float distanceM = length(toFragment);
  vec3 viewDirection = toFragment / max(distanceM, 1.0);
  float verticalCosine = max(abs(viewDirection.z), 0.12);

  vec2 drift = vec2(1.0, 0.35) * nebelmeer.time * 5.0;
  float fogValue = fogNoise(worldPosition.xy + drift, distanceM);

  float threshold = mix(0.62, 0.30, nebelmeer.density);
  float softness = 0.04 + 0.30 * nebelmeer.falloff;
  float cover = smoothstep(threshold - softness, threshold + softness, fogValue);

  float opticalDepth = (0.9 + 3.5 * nebelmeer.density) * mix(0.6, 1.0, fogValue) / verticalCosine;
  float edge = 1.0 - smoothstep(0.6, 1.0, max(abs(unitPosition.x), abs(unitPosition.y)));
  float alpha = min(cover * (1.0 - exp(-opticalDepth)) * edge, 0.96);

  float sunHeight = clamp(nebelmeer.sunDirection.z, 0.0, 1.0);
  float forward = pow(max(dot(viewDirection, nebelmeer.sunDirection), 0.0), 8.0);
  vec3 color = nebelmeer.skyColor * 0.75 + nebelmeer.sunColor * (0.30 * sunHeight + 0.35 * forward);
  color *= 0.88 + 0.12 * fogValue;
  float haze = 0.5 * (1.0 - exp(-distanceM / 60000.0));
  color = mix(color, nebelmeer.skyColor, haze);

  float a = alpha * layer.opacity;
  fragColor = vec4(color * a, a);
  DECKGL_FILTER_COLOR(fragColor, geometry);
}
`;
