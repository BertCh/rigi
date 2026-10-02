// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// WGSL of the GPU splat depth sort (see ./README.md and ./index.ts): the depth and key kernels. The sort
// itself is luma gpgpu's stable radix GPUSort over the 17-bit keys (the worker's 16-bit key, 0..65535, plus
// one extra key, 65536, for splats the worker drops (view depth <= near), which therefore sort last).
// cpu.ts is the CPU twin of these two kernels and of the stable order.

/** Workgroup size of the depth and key kernels. */
export const TILE = 256;
/** Key given to dropped splats (above every real key, 0..65535). */
export const DROPPED_KEY = 65536;

const PARAMS = /* wgsl */ `\
struct Params {
  row: vec4<f32>,
  near: f32,
  n: u32,
  blocks: u32,
  pad0: u32,
};
@group(0) @binding(0) var<uniform> p: Params;
`;

/** Depth of every splat (f32 bits; 0xffffffff = dropped) and the min / max depth (atomics on bits). */
export const DEPTH_WGSL = /* wgsl */ `\
${PARAMS}
@group(0) @binding(1) var<storage, read> splatData: array<vec4<u32>>;
@group(0) @binding(2) var<storage, read_write> depth: array<u32>;
// mm[0] = max of ~bits (i.e. the min depth), mm[1] = max of bits; both cleared to 0 per sort.
// Positive finite floats order like their bit patterns, so integer atomics are exact min / max.
@group(0) @binding(3) var<storage, read_write> mm: array<atomic<u32>>;

@compute @workgroup_size(${TILE}) fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= p.n) { return; }
  let t = bitcast<vec4<f32>>(splatData[3u * i]);
  // same association as the worker: ((a x + b y) + c z) + d, but in f32 (see ./README.md)
  let dist = -(((p.row.x * t.x + p.row.y * t.y) + p.row.z * t.z) + p.row.w);
  let bits = bitcast<u32>(dist);
  // +Inf (a corrupt splat) is dropped too: it would make maxD = Inf and every key NaN
  if (dist > p.near && bits < 0x7f800000u) {
    depth[i] = bits;
    atomicMax(&mm[0], ~bits);
    atomicMax(&mm[1], bits);
  } else {
    depth[i] = 0xffffffffu;
  }
}
`;

/** The 17-bit key: larger key = nearer; ascending key = back to front. Dropped = 65536. */
export const KEYS_WGSL = /* wgsl */ `\
${PARAMS}
@group(0) @binding(1) var<storage, read> depth: array<u32>;
@group(0) @binding(2) var<storage, read> mm: array<u32>;
@group(0) @binding(3) var<storage, read_write> keys: array<u32>;

@compute @workgroup_size(${TILE}) fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= p.n) { return; }
  let bits = depth[i];
  if (bits == 0xffffffffu) { keys[i] = ${DROPPED_KEY}u; return; }
  let maxD = bitcast<f32>(mm[1]);
  let minD = bitcast<f32>(~mm[0]);
  let span = maxD - minD;
  var k = 0.0;
  if (span > 0.0) { k = 65535.0 / span; }
  keys[i] = min(65535u, u32((maxD - bitcast<f32>(bits)) * k));
}
`;
