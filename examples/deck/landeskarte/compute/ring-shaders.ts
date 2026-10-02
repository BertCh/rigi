// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// WGSL for the ring graph. Three kernels with distinct sources (no override constants, at most six
// buffers each). The f32 operation order is mirrored by `ring-cpu.ts`; change both together.
//
// Tangent convention: (h - h_eye) / d - d (1 - k) / (2R), R = 6371008.8 (folded into `curvature`).

/** Byte length of `RingUniforms`; `writeRingUniforms` in ring-graph.ts fills it. */
export const RING_UNIFORMS_BYTE_LENGTH = 80;

const RING_UNIFORMS_WGSL = /* wgsl */ `\
struct RingUniforms {
  eyeFraction: vec2<f32>,
  eyeAltitude: f32,
  pixelsPerMeterEast: f32,
  pixelsPerMeterNorth: f32,
  mercatorGrowth: f32,
  halfMercatorGrowth: f32,
  parallelCurvature: f32,
  curvature: f32,
  binCount: u32,
  eyePixel: vec2<i32>,
  mosaicWidth: u32,
  mosaicHeight: u32,
  sampleCount: u32,
  peakCount: u32,
  peakSkirt: f32,
  /** Always 0. Hides values from fast-math optimizers; see opaque(). */
  zero: u32,
  columnCurvature: f32,
  rowCubic: f32,
};
`;

/** Node 1: Terrarium RGBA words to f32 metres. Every intermediate is exact in f32. */
export const DECODE_TERRARIUM_WGSL = /* wgsl */ `\
${RING_UNIFORMS_WGSL}
@group(0) @binding(0) var<uniform> uniforms: RingUniforms;
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

/** Shared by the two march kernels: bindings 0 and 1, and one ray sample. */
const RING_SAMPLE_WGSL = /* wgsl */ `\
${RING_UNIFORMS_WGSL}
@group(0) @binding(0) var<uniform> uniforms: RingUniforms;
@group(0) @binding(1) var<storage, read> heights: array<f32>;

/**
 * Returns \`value\` unchanged, but opaque to the compiler. Metal compiles WGSL with fast math, which
 * may re-associate \`(height - eyeAltitude)\` terms in the bilinear blend and reintroduce the f32
 * rounding of absolute heights. XOR with a uniform zero cannot be folded.
 */
fn opaque(value: f32) -> f32 {
  return bitcast<f32>(bitcast<u32>(value) ^ uniforms.zero);
}

/** (tangent, 1) at one distance along a direction, or (0, 0) once the ray leaves the mosaic. */
fn sampleTangent(direction: vec2<f32>, distance: f32, inverseDistance: f32) -> vec2<f32> {
  let north = direction.y * distance;
  let east = direction.x * distance;
  // Pixel offsets from the eye's integer pixel, by a local Web Mercator expansion about the eye:
  // third order in the northward offset, plus the bend of a parallel away from the tangent plane
  // (about 125 m of northing at 40 km east). Small offsets keep fine f32 resolution at the eye.
  let column = uniforms.eyeFraction.x +
    east * uniforms.pixelsPerMeterEast *
      (1.0 + north * (uniforms.mercatorGrowth + north * uniforms.columnCurvature));
  let northTerm = north * (1.0 + north * (uniforms.halfMercatorGrowth + north * uniforms.rowCubic));
  let eastTerm = east * east * uniforms.parallelCurvature;
  let row = uniforms.eyeFraction.y - (northTerm - eastTerm) * uniforms.pixelsPerMeterNorth;
  let columnFloor = floor(column);
  let rowFloor = floor(row);
  let x = uniforms.eyePixel.x + i32(columnFloor);
  let y = uniforms.eyePixel.y + i32(rowFloor);
  let width = uniforms.mosaicWidth;
  if (x < 0 || y < 0 || x >= i32(width) - 1 || y >= i32(uniforms.mosaicHeight) - 1) {
    return vec2<f32>(0.0, 0.0);
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
  // inverseDistance comes from the CPU: WGSL division is only accurate to 2.5 ULP.
  return vec2<f32>(relativeHeight * inverseDistance - distance * uniforms.curvature, 1.0);
}
`;

/**
 * Node 2: one invocation per azimuth bin marches outwards over the shared distance table and keeps
 * the largest curvature- and refraction-corrected tangent, and where it was.
 */
export const RING_MARCH_WGSL = /* wgsl */ `\
${RING_SAMPLE_WGSL}
@group(0) @binding(2) var<storage, read> azimuthDirections: array<vec2<f32>>;
@group(0) @binding(3) var<storage, read> samples: array<vec2<f32>>;
@group(0) @binding(4) var<storage, read_write> ringTangents: array<f32>;
@group(0) @binding(5) var<storage, read_write> ringDistances: array<f32>;

@compute @workgroup_size(64, 1, 1)
fn main(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let bin = invocation.x;
  if (bin >= uniforms.binCount) {
    return;
  }
  let direction = azimuthDirections[bin];
  var bestTangent = -1.0e30;
  var bestDistance = 0.0;
  for (var sampleIndex = 0u; sampleIndex < uniforms.sampleCount; sampleIndex++) {
    let sample = samples[sampleIndex];
    let result = sampleTangent(direction, sample.x, sample.y);
    if (result.y < 0.5) {
      break;
    }
    if (result.x > bestTangent) {
      bestTangent = result.x;
      bestDistance = sample.x;
    }
  }
  ringTangents[bin] = bestTangent;
  ringDistances[bin] = bestDistance;
}
`;

/**
 * Node 3: one invocation per peak marches along the peak's own ray (not a bin) up to two DEM pixels
 * short of the summit and records the strongest blocker. Output per peak (vec4): peak tangent,
 * blocker tangent, 1 when the peak is beyond the ray table or its ray left the mosaic before the peak (else 0), blocker distance. The
 * visible/hidden decision is made on the CPU in degrees (see makeRingResult).
 */
export const PEAK_VISIBILITY_WGSL = /* wgsl */ `\
${RING_SAMPLE_WGSL}
@group(0) @binding(2) var<storage, read> samples: array<vec2<f32>>;
@group(0) @binding(3) var<storage, read> peakRays: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read_write> peakResults: array<vec4<f32>>;

@compute @workgroup_size(64, 1, 1)
fn main(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let peak = invocation.x;
  if (peak >= uniforms.peakCount) {
    return;
  }
  let ray = peakRays[2u * peak];
  let elevation = peakRays[2u * peak + 1u].x;
  let direction = ray.xy;
  let distance = ray.z;
  let peakTangent = (elevation - uniforms.eyeAltitude) * ray.w - distance * uniforms.curvature;
  let limit = distance - uniforms.peakSkirt;
  var blocker = -1.0e30;
  var blockerDistance = 0.0;
  var leftMosaic = false;
  for (var sampleIndex = 0u; sampleIndex < uniforms.sampleCount; sampleIndex++) {
    let sample = samples[sampleIndex];
    if (sample.x >= limit) {
      break;
    }
    let result = sampleTangent(direction, sample.x, sample.y);
    if (result.y < 0.5) {
      // The line of sight ran off the DEM before reaching the peak: it was never fully tested.
      leftMosaic = true;
      break;
    }
    if (result.x > blocker) {
      blocker = result.x;
      blockerDistance = sample.x;
    }
  }
  let outOfRange = select(0.0, 1.0, leftMosaic || distance > samples[uniforms.sampleCount - 1u].x);
  peakResults[peak] = vec4<f32>(peakTangent, blocker, outOfRange, blockerDistance);
}
`;
