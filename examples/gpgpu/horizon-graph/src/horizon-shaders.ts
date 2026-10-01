// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/** Byte length of `HorizonUniforms`; `writeHorizonUniforms` in horizon-graph.ts fills it. */
export const HORIZON_UNIFORMS_BYTE_LENGTH = 64;

const HORIZON_UNIFORMS_WGSL = /* wgsl */ `\
struct HorizonUniforms {
  eyeFraction: vec2<f32>,
  eyeAltitude: f32,
  pixelsPerMeter: f32,
  mercatorGrowth: f32,
  halfMercatorGrowth: f32,
  curvature: f32,
  binCount: u32,
  eyePixel: vec2<i32>,
  mosaicWidth: u32,
  mosaicHeight: u32,
  sampleCount: u32,
  /** Always 0. Hides values from fast-math optimizers; see opaque(). */
  zero: u32,
  padding1: u32,
  padding2: u32,
};
`;

/** Node 1: Terrarium RGBA words to f32 metres. Every intermediate is exact in f32. */
export const DECODE_TERRARIUM_WGSL = /* wgsl */ `\
${HORIZON_UNIFORMS_WGSL}
@group(0) @binding(0) var<uniform> uniforms: HorizonUniforms;
@group(0) @binding(1) var<storage, read> terrariumPixels: array<u32>;
@group(0) @binding(2) var<storage, read_write> heights: array<f32>;

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) invocation: vec3<u32>) {
  if (invocation.x >= uniforms.mosaicWidth || invocation.y >= uniforms.mosaicHeight) {
    return;
  }
  let index = invocation.y * uniforms.mosaicWidth + invocation.x;
  let packed = terrariumPixels[index];
  let red = f32(packed & 255u);
  let green = f32((packed >> 8u) & 255u);
  let blue = f32((packed >> 16u) & 255u);
  heights[index] = red * 256.0 + green + blue / 256.0 - 32768.0;
}
`;

/**
 * Node 2: one invocation per azimuth bin marches outwards over the shared distance table and keeps
 * the largest curvature- and refraction-corrected elevation tangent. The CPU twin
 * (`computeHorizonOnCPU`) performs the same f32 operations in the same order.
 */
export const HORIZON_MARCH_WGSL = /* wgsl */ `\
${HORIZON_UNIFORMS_WGSL}
@group(0) @binding(0) var<uniform> uniforms: HorizonUniforms;
@group(0) @binding(1) var<storage, read> heights: array<f32>;
@group(0) @binding(2) var<storage, read> azimuthDirections: array<vec2<f32>>;
@group(0) @binding(3) var<storage, read> samples: array<vec2<f32>>;
@group(0) @binding(4) var<storage, read_write> horizonTangents: array<f32>;
@group(0) @binding(5) var<storage, read_write> horizonDistances: array<f32>;

/**
 * Returns \`value\` unchanged, but opaque to the compiler. Metal compiles WGSL with fast math, which
 * may re-associate \`(height - eyeAltitude)\` terms in the bilinear blend and reintroduce the f32
 * rounding of absolute heights. XOR with a uniform zero cannot be folded.
 */
fn opaque(value: f32) -> f32 {
  return bitcast<f32>(bitcast<u32>(value) ^ uniforms.zero);
}

@compute @workgroup_size(64, 1, 1)
fn main(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let bin = invocation.x;
  if (bin >= uniforms.binCount) {
    return;
  }
  let direction = azimuthDirections[bin];
  let width = uniforms.mosaicWidth;
  var bestTangent = -1.0e30;
  var bestDistance = 0.0;
  for (var sampleIndex = 0u; sampleIndex < uniforms.sampleCount; sampleIndex++) {
    let sample = samples[sampleIndex];
    let distance = sample.x;
    let north = direction.y * distance;
    let east = direction.x * distance;
    // Offsets from the eye's integer pixel, by a local Web Mercator expansion to second order in
    // the northward offset. Small offsets keep fine f32 resolution next to the eye.
    let column = uniforms.eyeFraction.x +
      east * uniforms.pixelsPerMeter * (1.0 + north * uniforms.mercatorGrowth);
    let row = uniforms.eyeFraction.y -
      north * uniforms.pixelsPerMeter * (1.0 + north * uniforms.halfMercatorGrowth);
    let columnFloor = floor(column);
    let rowFloor = floor(row);
    let x = uniforms.eyePixel.x + i32(columnFloor);
    let y = uniforms.eyePixel.y + i32(rowFloor);
    if (x < 0 || y < 0 || x >= i32(width) - 1 || y >= i32(uniforms.mosaicHeight) - 1) {
      break;
    }
    let fractionX = column - columnFloor;
    let fractionY = row - rowFloor;
    let index = u32(y) * width + u32(x);
    // Heights relative to the eye: the subtraction is exact (Sterbenz) near the eye, where a
    // rounding error in an absolute height would be magnified by the short distance. Keep it.
    let height00 = opaque(heights[index] - uniforms.eyeAltitude);
    let height10 = opaque(heights[index + 1u] - uniforms.eyeAltitude);
    let height01 = opaque(heights[index + width] - uniforms.eyeAltitude);
    let height11 = opaque(heights[index + width + 1u] - uniforms.eyeAltitude);
    let top = height00 + (height10 - height00) * fractionX;
    let bottom = height01 + (height11 - height01) * fractionX;
    let relativeHeight = top + (bottom - top) * fractionY;
    // sample.y = 1 / distance from the CPU: WGSL division is only accurate to 2.5 ULP.
    let tangent = relativeHeight * sample.y - distance * uniforms.curvature;
    if (tangent > bestTangent) {
      bestTangent = tangent;
      bestDistance = distance;
    }
  }
  horizonTangents[bin] = bestTangent;
  horizonDistances[bin] = bestDistance;
}
`;

/** Byte length of `PanoramaUniforms`; `writePanoramaUniforms` in app.ts fills it. */
export const PANORAMA_UNIFORMS_BYTE_LENGTH = 32;

const PANORAMA_COMMON_WGSL = /* wgsl */ `\
struct PanoramaUniforms {
  binCount: u32,
  startBin: u32,
  startAzimuth: f32,
  binWidth: f32,
  horizontalScale: f32,
  verticalScale: f32,
  verticalOffset: f32,
  maximumDistance: f32,
};

@group(0) @binding(0) var<uniform> panorama: PanoramaUniforms;
@group(0) @binding(1) var<storage, read> horizonTangents: array<f32>;
@group(0) @binding(2) var<storage, read> horizonDistances: array<f32>;

struct VertexOutputs {
  @builtin(position) position: vec4<f32>,
  @location(0) distanceFraction: f32,
  @location(1) heightFraction: f32,
};

/** Clip-space x, y and normalized distance of the skyline at one panorama column. */
fn getSkylinePoint(column: u32) -> vec3<f32> {
  let bin = (panorama.startBin + column) % panorama.binCount;
  let azimuthOffset = f32(column) * panorama.binWidth;
  let elevation = degrees(atan(horizonTangents[bin]));
  return vec3<f32>(
    (panorama.startAzimuth + azimuthOffset) * panorama.horizontalScale - 1.0,
    elevation * panorama.verticalScale + panorama.verticalOffset,
    clamp(horizonDistances[bin] / panorama.maximumDistance, 0.0, 1.0)
  );
}
`;

/** Filled silhouette: a triangle strip with two vertices per column, read straight from the graph output. */
export const SILHOUETTE_WGSL = /* wgsl */ `\
${PANORAMA_COMMON_WGSL}
@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutputs {
  let point = getSkylinePoint(vertexIndex / 2u);
  let isTop = vertexIndex % 2u == 0u;
  var outputs: VertexOutputs;
  outputs.position = vec4<f32>(point.x, select(-1.0, point.y, isTop), 0.0, 1.0);
  outputs.distanceFraction = point.z;
  outputs.heightFraction = select(0.0, 1.0, isTop);
  return outputs;
}

@fragment
fn fragmentMain(inputs: VertexOutputs) -> @location(0) vec4<f32> {
  // Aerial perspective: far ridges fade towards the haze colour.
  let nearColor = vec3<f32>(0.06, 0.09, 0.13);
  let farColor = vec3<f32>(0.42, 0.52, 0.66);
  let ridgeColor = mix(nearColor, farColor, sqrt(inputs.distanceFraction));
  let shade = mix(0.45, 1.0, inputs.heightFraction);
  return vec4<f32>(ridgeColor * shade, 1.0);
}
`;

/** Skyline edge: a line strip through the top of every column. */
export const SKYLINE_WGSL = /* wgsl */ `\
${PANORAMA_COMMON_WGSL}
@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutputs {
  let point = getSkylinePoint(vertexIndex);
  var outputs: VertexOutputs;
  outputs.position = vec4<f32>(point.x, point.y, 0.0, 1.0);
  outputs.distanceFraction = point.z;
  outputs.heightFraction = 1.0;
  return outputs;
}

@fragment
fn fragmentMain(inputs: VertexOutputs) -> @location(0) vec4<f32> {
  return vec4<f32>(mix(vec3<f32>(0.98, 0.86, 0.6), vec3<f32>(0.75, 0.85, 0.95), inputs.distanceFraction), 1.0);
}
`;
