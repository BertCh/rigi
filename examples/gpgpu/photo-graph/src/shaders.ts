// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/** Byte length of `Params`; `app.ts` fills it. */
export const PARAMS_BYTE_LENGTH = 16;

const PARAMS_WGSL = /* wgsl */ `\
struct Params {
  width: u32,
  height: u32,
  threshold: f32,
  padding: u32,
};
@group(0) @binding(0) var<uniform> params: Params;
`;

/** Stage 1: RGBA bytes packed in a u32 to Rec. 709 luminance in 0..1. */
export const LUMINANCE_WGSL = /* wgsl */ `\
${PARAMS_WGSL}
@group(0) @binding(1) var<storage, read> pixels: array<u32>;
@group(0) @binding(2) var<storage, read_write> luminance: array<f32>;

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= params.width || id.y >= params.height) { return; }
  let index = id.y * params.width + id.x;
  let packed = pixels[index];
  let rgb = vec3<f32>(f32(packed & 255u), f32((packed >> 8u) & 255u), f32((packed >> 16u) & 255u));
  luminance[index] = dot(rgb, vec3<f32>(0.2126, 0.7152, 0.0722)) / 255.0;
}
`;

/** Stage 2: 5 x 5 box blur with clamped edges. */
export const BLUR_WGSL = /* wgsl */ `\
${PARAMS_WGSL}
@group(0) @binding(1) var<storage, read> luminance: array<f32>;
@group(0) @binding(2) var<storage, read_write> blurred: array<f32>;

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= params.width || id.y >= params.height) { return; }
  let size = vec2<i32>(i32(params.width), i32(params.height));
  var sum = 0.0;
  for (var dy = -2; dy <= 2; dy++) {
    for (var dx = -2; dx <= 2; dx++) {
      let p = clamp(vec2<i32>(id.xy) + vec2<i32>(dx, dy), vec2<i32>(0), size - vec2<i32>(1));
      sum += luminance[u32(p.y) * params.width + u32(p.x)];
    }
  }
  blurred[id.y * params.width + id.x] = sum / 25.0;
}
`;

/** Stage 3: Sobel gradient magnitude of the blurred luminance. */
export const GRADIENT_WGSL = /* wgsl */ `\
${PARAMS_WGSL}
@group(0) @binding(1) var<storage, read> blurred: array<f32>;
@group(0) @binding(2) var<storage, read_write> gradient: array<f32>;

fn at(x: i32, y: i32) -> f32 {
  let p = clamp(vec2<i32>(x, y), vec2<i32>(0), vec2<i32>(i32(params.width), i32(params.height)) - vec2<i32>(1));
  return blurred[u32(p.y) * params.width + u32(p.x)];
}

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= params.width || id.y >= params.height) { return; }
  let x = i32(id.x);
  let y = i32(id.y);
  let gx = at(x + 1, y - 1) + 2.0 * at(x + 1, y) + at(x + 1, y + 1)
         - at(x - 1, y - 1) - 2.0 * at(x - 1, y) - at(x - 1, y + 1);
  let gy = at(x - 1, y + 1) + 2.0 * at(x, y + 1) + at(x + 1, y + 1)
         - at(x - 1, y - 1) - 2.0 * at(x, y - 1) - at(x + 1, y - 1);
  gradient[id.y * params.width + id.x] = length(vec2<f32>(gx, gy));
}
`;

/** Stage 4: one invocation per column; the first row from the top with a strong edge, else height. */
export const SKYLINE_WGSL = /* wgsl */ `\
${PARAMS_WGSL}
@group(0) @binding(1) var<storage, read> gradient: array<f32>;
@group(0) @binding(2) var<storage, read_write> skyline: array<u32>;

@compute @workgroup_size(64, 1, 1)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= params.width) { return; }
  var row = params.height;
  for (var y = 0u; y < params.height; y++) {
    if (gradient[y * params.width + id.x] > params.threshold) {
      row = y;
      break;
    }
  }
  skyline[id.x] = row;
}
`;
