// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// WGSL kernels and the pure constants/helpers of the cast-shadow field. The CPU twin (cpu-twins.ts)
// imports the constants and helpers below, never the WGSL, so it can run in a worker without luma.
//
// Every kernel binds at most 4 storage buffers (WebGPU guarantees 8 per stage) and the largest
// binding is the decoded mosaic (4 bytes per pixel, 51 MB at z11 and 7 x 7 tiles; the limit is 128 MiB).

import {EARTH_R, REFRACTION_K} from '../geo/geodesy';
import type {Mosaic, ShadowWindow} from '../types';

/** Azimuths of the horizon map: a_j = j * 22.5 degrees clockwise from north. */
export const HORIZON_MAP_AZIMUTHS = 16;
/** Geometric march samples per ray. */
export const HORIZON_MAP_SAMPLES = 256;
/** Nearest and farthest march distance, metres. */
export const HORIZON_MIN_DISTANCE = 26;
export const HORIZON_MAX_DISTANCE = 12000;
/** Sun-hours steps encoded per submit, so no single submit approaches the GPU watchdog. */
export const SUN_HOURS_STEPS_PER_DISPATCH = 48;

/** u16 angle range: [ANGLE_MIN, ANGLE_MAX] radians map to [0, 65535]. */
export const ANGLE_MIN = -0.25;
export const ANGLE_MAX = Math.PI / 2;
export const ANGLE_SPAN = ANGLE_MAX - ANGLE_MIN;
/** Half-width of the smoothstep penumbra: the sun is about 0.53 degrees across. */
export const PENUMBRA_RAD = (0.27 * Math.PI) / 180;
/** At or below this sun elevation (radians) nothing is lit, regardless of the horizon. */
export const SUN_FLOOR_RAD = (-1 * Math.PI) / 180;

/** Angle to u16. Half-up rounding (floor(x + 0.5)) so the WGSL twin matches exactly. */
export function quantizeAngle(radians: number): number {
  const unit = Math.min(Math.max((radians - ANGLE_MIN) / ANGLE_SPAN, 0), 1);
  return Math.floor(unit * 65535 + 0.5);
}

export function dequantizeAngle(quantized: number): number {
  return ANGLE_MIN + (quantized / 65535) * ANGLE_SPAN;
}

/**
 * March distances as f32 `[d, 1 / d]` pairs, `d_i = 26 (12000 / 26)^(i / 255)`. The reciprocal is
 * precomputed on the CPU because WGSL division is only accurate to a few ULP; kernels multiply.
 */
export function makeSampleTable(): Float32Array {
  const table = new Float32Array(HORIZON_MAP_SAMPLES * 2);
  const ratio = HORIZON_MAX_DISTANCE / HORIZON_MIN_DISTANCE;
  for (let i = 0; i < HORIZON_MAP_SAMPLES; i++) {
    const distance = Math.fround(HORIZON_MIN_DISTANCE * ratio ** (i / (HORIZON_MAP_SAMPLES - 1)));
    table[2 * i] = distance;
    table[2 * i + 1] = Math.fround(1 / distance);
  }
  return table;
}

/** Unit ray (east, north) of azimuth index j, rounded to f32 like the uniform the kernel reads. */
export function azimuthDirection(index: number): [number, number] {
  const radians = (index * 2 * Math.PI) / HORIZON_MAP_AZIMUTHS;
  return [Math.fround(Math.sin(radians)), Math.fround(Math.cos(radians))];
}

/** The curvature-plus-refraction coefficient (1 - k) / (2 R) of the tangent, as f32. */
export function curvatureCoefficient(refractionK: number = REFRACTION_K): number {
  return Math.fround((1 - refractionK) / (2 * EARTH_R));
}

/** The two neighbouring map azimuths of a sun azimuth (degrees) and the blend between them. */
export function azimuthBlend(azimuthDegrees: number): {low: number; high: number; blend: number} {
  const slot = (((azimuthDegrees % 360) + 360) % 360) / (360 / HORIZON_MAP_AZIMUTHS);
  const low = Math.floor(slot) % HORIZON_MAP_AZIMUTHS;
  return {
    low,
    high: (low + 1) % HORIZON_MAP_AZIMUTHS,
    blend: Math.fround(slot - Math.floor(slot))
  };
}

/**
 * Window of `size` field texels (each `stride` mosaic pixels) centred on ENU (0, 0), the summit,
 * clamped into the mosaic. The summit is at ENU (0, 0), so its pixel is
 * `((0 - originEnu[0]) / mpp, (originEnu[1] - 0) / mpp)`.
 */
export function makeShadowWindow(mosaic: Mosaic, size: number, stride: number): ShadowWindow {
  const span = size * stride;
  const summitColumn = -mosaic.originEnu[0] / mosaic.metersPerPixel;
  const summitRow = mosaic.originEnu[1] / mosaic.metersPerPixel;
  const clamp = (value: number, limit: number) => Math.min(Math.max(value, 0), limit - span);
  return {
    column: clamp(Math.round(summitColumn - span / 2), mosaic.width),
    row: clamp(Math.round(summitRow - span / 2), mosaic.height),
    size,
    stride
  };
}

const f32 = (value: number) => (Number.isInteger(value) ? `${value}.0` : `${value}`);

/** Constants shared by the horizon-map, shade, ambient and sun-hours kernels. */
const COMMON_WGSL = /* wgsl */ `\
const AZIMUTHS = ${HORIZON_MAP_AZIMUTHS}u;
// Two u16 angles per u32 word: element = cell * AZIMUTHS + azimuth, low half = even element.
const WORDS_PER_CELL = ${HORIZON_MAP_AZIMUTHS / 2}u;
const ANGLE_MIN = ${f32(ANGLE_MIN)};
const ANGLE_SPAN = ${f32(ANGLE_SPAN)};
const PENUMBRA = ${f32(PENUMBRA_RAD)};
const SUN_FLOOR = ${f32(SUN_FLOOR_RAD)};
`;

/** Reads the dequantised horizon angle of one cell and azimuth (shade, ambient, sun-hours). */
const READ_ANGLE_WGSL = /* wgsl */ `\
fn readAngle(cell: u32, azimuth: u32) -> f32 {
  let word = horizonMap[cell * WORDS_PER_CELL + (azimuth >> 1u)];
  let quantized = (word >> ((azimuth & 1u) * 16u)) & 0xffffu;
  return ANGLE_MIN + f32(quantized) / 65535.0 * ANGLE_SPAN;
}

/** Lit fraction in 0..1: smoothstep over the penumbra around the interpolated horizon. */
fn litFraction(cell: u32, low: u32, high: u32, blend: f32, sunElevation: f32) -> f32 {
  if (sunElevation <= SUN_FLOOR) {
    return 0.0;
  }
  let lowAngle = readAngle(cell, low);
  let horizon = lowAngle + (readAngle(cell, high) - lowAngle) * blend;
  return smoothstep(horizon - PENUMBRA, horizon + PENUMBRA, sunElevation);
}

fn toByte(value: f32) -> u32 {
  return u32(floor(clamp(value, 0.0, 1.0) * 255.0 + 0.5));
}
`;

/** Byte length of `DecodeUniforms`. */
export const DECODE_UNIFORMS_BYTE_LENGTH = 16;

/** Node 1: Terrarium RGBA words to f32 metres. Every intermediate is exact in f32. */
export const DECODE_TERRARIUM_WGSL = /* wgsl */ `\
struct DecodeUniforms {
  width: u32,
  height: u32,
  padding0: u32,
  padding1: u32,
};
@group(0) @binding(0) var<uniform> uniforms: DecodeUniforms;
@group(0) @binding(1) var<storage, read> terrariumPixels: array<u32>;
@group(0) @binding(2) var<storage, read_write> heights: array<f32>;

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) invocation: vec3<u32>) {
  if (invocation.x >= uniforms.width || invocation.y >= uniforms.height) {
    return;
  }
  let index = invocation.y * uniforms.width + invocation.x;
  let packed = terrariumPixels[index];
  let red = f32(packed & 255u);
  let green = f32((packed >> 8u) & 255u);
  let blue = f32((packed >> 16u) & 255u);
  heights[index] = red * 256.0 + green + blue / 256.0 - 32768.0;
}
`;

/** Byte length of `HorizonUniforms`; `writeHorizonUniforms` in shadow-graph.ts fills it. */
export const HORIZON_UNIFORMS_BYTE_LENGTH = 64;

/**
 * Node 2: one dispatch per azimuth, one invocation per field cell. The cell marches outwards over
 * the shared geometric distance table and keeps the largest curvature- and refraction-corrected
 * elevation tangent
 *
 *   tangent_i = (h(p + d_i u) - h(p)) * (1 / d_i) - d_i * (1 - k) / (2 R)
 *
 * then stores atan(max tangent) as a u16. Reads past the mosaic edge clamp to the edge pixel.
 * The CPU twin repeats the same f32 operations in the same order.
 */
export const HORIZON_MAP_WGSL = /* wgsl */ `\
${COMMON_WGSL}
struct HorizonUniforms {
  mosaicWidth: u32,
  mosaicHeight: u32,
  windowColumn: u32,
  windowRow: u32,
  windowSize: u32,
  stride: u32,
  azimuthIndex: u32,
  sampleCount: u32,
  direction: vec2<f32>,
  pixelsPerMeter: f32,
  curvature: f32,
  /** Always 0. Hides values from fast-math optimizers; see opaque(). */
  zero: u32,
  padding0: u32,
  padding1: u32,
  padding2: u32,
};
@group(0) @binding(0) var<uniform> uniforms: HorizonUniforms;
@group(0) @binding(1) var<storage, read> heights: array<f32>;
@group(0) @binding(2) var<storage, read> samples: array<vec2<f32>>;
@group(0) @binding(3) var<storage, read_write> horizonMap: array<u32>;

/**
 * Returns \`value\` unchanged, but opaque to the compiler. Metal compiles WGSL with fast math, which
 * may re-associate the bilinear blend; XOR with a uniform zero cannot be folded.
 */
fn opaque(value: f32) -> f32 {
  return bitcast<f32>(bitcast<u32>(value) ^ uniforms.zero);
}

/** Bilinear height at a continuous pixel coordinate (pixel i spans [i, i + 1], centre i + 0.5). */
fn sampleHeight(x: f32, y: f32) -> f32 {
  let width = uniforms.mosaicWidth;
  let fx = clamp(x - 0.5, 0.0, f32(width - 1u));
  let fy = clamp(y - 0.5, 0.0, f32(uniforms.mosaicHeight - 1u));
  let column = min(u32(floor(fx)), width - 2u);
  let row = min(u32(floor(fy)), uniforms.mosaicHeight - 2u);
  let fractionX = fx - f32(column);
  let fractionY = fy - f32(row);
  let index = row * width + column;
  let height00 = opaque(heights[index]);
  let height10 = opaque(heights[index + 1u]);
  let height01 = opaque(heights[index + width]);
  let height11 = opaque(heights[index + width + 1u]);
  let top = height00 + (height10 - height00) * fractionX;
  let bottom = height01 + (height11 - height01) * fractionX;
  return top + (bottom - top) * fractionY;
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) invocation: vec3<u32>) {
  if (invocation.x >= uniforms.windowSize || invocation.y >= uniforms.windowSize) {
    return;
  }
  let stride = f32(uniforms.stride);
  let centreX = f32(uniforms.windowColumn + invocation.x * uniforms.stride) + 0.5 * stride;
  let centreY = f32(uniforms.windowRow + invocation.y * uniforms.stride) + 0.5 * stride;
  let cellHeight = sampleHeight(centreX, centreY);
  var bestTangent = -1.0e30;
  for (var sampleIndex = 0u; sampleIndex < uniforms.sampleCount; sampleIndex++) {
    let entry = samples[sampleIndex];
    let distance = entry.x;
    let east = uniforms.direction.x * distance;
    let north = uniforms.direction.y * distance;
    let x = centreX + east * uniforms.pixelsPerMeter;
    let y = centreY - north * uniforms.pixelsPerMeter;
    let tangent = (sampleHeight(x, y) - cellHeight) * entry.y - distance * uniforms.curvature;
    bestTangent = max(bestTangent, tangent);
  }
  let angle = clamp(atan(bestTangent), ANGLE_MIN, ANGLE_MIN + ANGLE_SPAN);
  let quantized = u32(floor(clamp((angle - ANGLE_MIN) / ANGLE_SPAN, 0.0, 1.0) * 65535.0 + 0.5));
  // Neighbouring azimuths share a word. Within one dispatch every invocation owns its own words,
  // and dispatches are ordered, so this read-modify-write cannot race.
  let word = (invocation.y * uniforms.windowSize + invocation.x) * WORDS_PER_CELL +
    (uniforms.azimuthIndex >> 1u);
  let shift = (uniforms.azimuthIndex & 1u) * 16u;
  horizonMap[word] = (horizonMap[word] & ~(0xffffu << shift)) | (quantized << shift);
}
`;

/** Byte length of `ShadeUniforms`. */
export const SHADE_UNIFORMS_BYTE_LENGTH = 32;

const SHADE_UNIFORMS_WGSL = /* wgsl */ `\
struct ShadeUniforms {
  wordCount: u32,
  azimuthLow: u32,
  azimuthHigh: u32,
  blend: f32,
  sunElevation: f32,
  padding0: u32,
  padding1: u32,
  padding2: u32,
};
@group(0) @binding(0) var<uniform> uniforms: ShadeUniforms;
@group(0) @binding(1) var<storage, read> horizonMap: array<u32>;
@group(0) @binding(2) var<storage, read_write> fieldBytes: array<u32>;
`;

/**
 * Node 3, per sun change: one invocation packs four r8 texels. Lookup, azimuth interpolation and
 * smoothstep penumbra; the byte buffer is then copied into the r8unorm \`shadow\` texture.
 */
export const SHADE_AT_TIME_WGSL = /* wgsl */ `\
${COMMON_WGSL}
${SHADE_UNIFORMS_WGSL}
${READ_ANGLE_WGSL}
@compute @workgroup_size(64, 1, 1)
fn main(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let wordIndex = invocation.x;
  if (wordIndex >= uniforms.wordCount) {
    return;
  }
  var packed = 0u;
  for (var texel = 0u; texel < 4u; texel++) {
    let lit = litFraction(
      wordIndex * 4u + texel, uniforms.azimuthLow, uniforms.azimuthHigh, uniforms.blend,
      uniforms.sunElevation);
    packed |= toByte(lit) << (texel * 8u);
  }
  fieldBytes[wordIndex] = packed;
}
`;

/**
 * Node 4, once: sky-view factor `1 - mean_j sin(max(H_j, 0))` (Kennelly and Stewart), the ambient
 * light that reaches a cell from the open sky.
 */
export const AMBIENT_WGSL = /* wgsl */ `\
${COMMON_WGSL}
${SHADE_UNIFORMS_WGSL}
${READ_ANGLE_WGSL}
@compute @workgroup_size(64, 1, 1)
fn main(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let wordIndex = invocation.x;
  if (wordIndex >= uniforms.wordCount) {
    return;
  }
  var packed = 0u;
  for (var texel = 0u; texel < 4u; texel++) {
    let cell = wordIndex * 4u + texel;
    var openSky = 0.0;
    for (var azimuth = 0u; azimuth < AZIMUTHS; azimuth++) {
      openSky += sin(max(readAngle(cell, azimuth), 0.0));
    }
    packed |= toByte(1.0 - openSky / f32(AZIMUTHS)) << (texel * 8u);
  }
  fieldBytes[wordIndex] = packed;
}
`;

/** Byte length of `SunHoursUniforms`. */
export const SUN_HOURS_UNIFORMS_BYTE_LENGTH = 32;

/**
 * Sun-hours: accumulates lit fraction times the step length over a chunk of the day table into f32
 * hours per texel. Steps are \`vec4(azimuthLow, azimuthHigh, blend, elevationRadians)\`.
 */
export const SUN_HOURS_WGSL = /* wgsl */ `\
${COMMON_WGSL}
struct SunHoursUniforms {
  windowSize: u32,
  firstStep: u32,
  stepCount: u32,
  stepHours: f32,
  padding0: u32,
  padding1: u32,
  padding2: u32,
  padding3: u32,
};
@group(0) @binding(0) var<uniform> uniforms: SunHoursUniforms;
@group(0) @binding(1) var<storage, read> horizonMap: array<u32>;
@group(0) @binding(2) var<storage, read> steps: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> hours: array<f32>;
${READ_ANGLE_WGSL}
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) invocation: vec3<u32>) {
  if (invocation.x >= uniforms.windowSize || invocation.y >= uniforms.windowSize) {
    return;
  }
  let cell = invocation.y * uniforms.windowSize + invocation.x;
  var total = hours[cell];
  for (var step = 0u; step < uniforms.stepCount; step++) {
    let sun = steps[uniforms.firstStep + step];
    total += litFraction(cell, u32(sun.x), u32(sun.y), sun.z, sun.w) * uniforms.stepHours;
  }
  hours[cell] = total;
}
`;
