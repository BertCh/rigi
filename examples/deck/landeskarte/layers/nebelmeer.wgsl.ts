// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// WGSL for the Nebelmeer slab. The `nebelmeer` uniform struct comes from the module in
// nebelmeer-layer.ts; this file only holds the vertex and fragment code. The GLSL twin is
// nebelmeer.glsl.ts and must stay line-for-line equivalent.

export const NEBELMEER_WGSL = /* wgsl */ `
struct NebelmeerVertex {
  @builtin(position) position: vec4<f32>,
  @location(0) worldPosition: vec3<f32>,
  @location(1) unitPosition: vec2<f32>,
};

fn hash12(p: vec2<f32>) -> f32 {
  var p3 = fract(vec3<f32>(p.x, p.y, p.x) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

fn valueNoise(p: vec2<f32>) -> f32 {
  let cell = floor(p);
  let fraction = fract(p);
  let eased = fraction * fraction * (3.0 - 2.0 * fraction);
  let a = hash12(cell);
  let b = hash12(cell + vec2<f32>(1.0, 0.0));
  let c = hash12(cell + vec2<f32>(0.0, 1.0));
  let d = hash12(cell + vec2<f32>(1.0, 1.0));
  return mix(mix(a, b, eased.x), mix(c, d, eased.x), eased.y);
}

// Three octaves, 1.8 km down to 260 m. The finest octave fades out with distance: beyond
// about 20 km a pixel spans more than its wavelength and the noise would shimmer.
fn fogNoise(p: vec2<f32>, distanceM: f32) -> f32 {
  let fine = 1.0 - smoothstep(12000.0, 30000.0, distanceM);
  let coarse = valueNoise(p / 1800.0) * 0.55 + valueNoise(p / 700.0 + 17.0) * 0.30;
  let detail = valueNoise(p / 260.0 + 41.0) * 0.15;
  // The missing detail weight is replaced by the mean (0.5), so the cover threshold keeps its meaning.
  return coarse + mix(0.5 * 0.15, detail, fine);
}

@vertex fn vertexMain(@location(0) gridPosition: vec2<f32>) -> NebelmeerVertex {
  let east = nebelmeer.centerEast + gridPosition.x * nebelmeer.extent;
  let north = nebelmeer.centerNorth + gridPosition.y * nebelmeer.extent;
  // The slab follows the same curved, refracted surface as the terrain and the lake: sea level
  // drops by k' d^2 / 2R, so a flat plane would float 250 m above the lake at 60 km.
  let drop = nebelmeer.curvatureScale * (east * east + north * north) / (2.0 * nebelmeer.earthRadius);
  let up = nebelmeer.baseHeight + nebelmeer.thickness - nebelmeer.originHeight - drop;
  let position = vec3<f32>(east, north, up);
  var output: NebelmeerVertex;
  output.position = project_position_to_clipspace(position, vec3<f32>(0.0), vec3<f32>(0.0));
  output.worldPosition = position;
  output.unitPosition = gridPosition;
  return output;
}

@fragment fn fragmentMain(input: NebelmeerVertex) -> @location(0) vec4<f32> {
  let toFragment = input.worldPosition - nebelmeer.cameraPosition;
  let distanceM = length(toFragment);
  let viewDirection = toFragment / max(distanceM, 1.0);
  let verticalCosine = max(abs(viewDirection.z), 0.12);

  let drift = vec2<f32>(1.0, 0.35) * nebelmeer.time * 5.0;
  let fogValue = fogNoise(input.worldPosition.xy + drift, distanceM);

  // Density sets how much of the sea is closed: a high density leaves few gaps.
  let threshold = mix(0.62, 0.30, nebelmeer.density);
  let softness = 0.04 + 0.30 * nebelmeer.falloff;
  let cover = smoothstep(threshold - softness, threshold + softness, fogValue);

  // Optical depth of the slab along the view ray: thicker straight down, opaque at grazing angles.
  let opticalDepth = (0.9 + 3.5 * nebelmeer.density) * mix(0.6, 1.0, fogValue) / verticalCosine;
  let edge = 1.0 - smoothstep(0.6, 1.0, max(abs(input.unitPosition.x), abs(input.unitPosition.y)));
  let alpha = min(cover * (1.0 - exp(-opticalDepth)) * edge, 0.96);

  // Fog scatters sky light everywhere and sun light in proportion to its height, with a forward
  // lobe towards the sun (the glowing rim of a Nebelmeer at sunset).
  let sunHeight = clamp(nebelmeer.sunDirection.z, 0.0, 1.0);
  let forward = pow(max(dot(viewDirection, nebelmeer.sunDirection), 0.0), 8.0);
  var color = nebelmeer.skyColor * 0.75 + nebelmeer.sunColor * (0.30 * sunHeight + 0.35 * forward);
  color *= 0.88 + 0.12 * fogValue;
  // The same distance haze family as the terrain, kept gentle so the sea stays a bright shape.
  let haze = 0.5 * (1.0 - exp(-distanceM / 60000.0));
  color = mix(color, nebelmeer.skyColor, haze);

  // Premultiplied output: the blend state is one / one-minus-src-alpha.
  let a = alpha * layer.opacity;
  return vec4<f32>(color * a, a);
}
`;
