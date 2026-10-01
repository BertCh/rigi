// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// WGSL of the GPU splat depth sort (see ./README.md and ./index.ts). Two radix passes of 9 bits over
// 17-bit keys: the worker's 16-bit key (0..65535) plus one extra key, 65536, for splats the worker
// drops (view depth <= near), which therefore sort last. Every pass is a STABLE counting sort:
// tile (rank within a 256-element tile + per-tile digit histogram) → scanDigit (exclusive scan of
// each digit's histogram over tiles) → scanTotals (exclusive scan of the 512 digit totals) →
// scatter (position = digitBase + tileOffset + rank). cpu.ts is the line-by-line CPU twin.

/** Workgroup / tile size, the radix width and the digit count. Keep in step with cpu.ts. */
export const TILE = 256;
export const RADIX_BITS = 9;
export const DIGITS = 1 << RADIX_BITS;
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

/**
 * Pass step 1. Thread t of tile w ranks element g = w·256 + t among the EARLIER elements of its
 * tile with the same digit (a loop over the lower threads: O(tile²) shared reads, trivially
 * stable), and the tile's digit histogram goes to hist[digit * blocks + w] (digit-major, so the
 * next kernel scans one digit across tiles). FIRST = 1: the input order is the identity.
 */
export const TILE_WGSL = /* wgsl */ `\
${PARAMS}
override SHIFT: u32 = 0u;
override FIRST: u32 = 0u;
@group(0) @binding(1) var<storage, read> keys: array<u32>;
@group(0) @binding(2) var<storage, read> inIdx: array<u32>;
@group(0) @binding(3) var<storage, read_write> rank: array<u32>;
@group(0) @binding(4) var<storage, read_write> hist: array<u32>;
var<workgroup> dg: array<u32, ${TILE}>;
var<workgroup> hs: array<atomic<u32>, ${DIGITS}>;

@compute @workgroup_size(${TILE}) fn main(
  @builtin(global_invocation_id) gid: vec3<u32>,
  @builtin(local_invocation_index) t: u32,
  @builtin(workgroup_id) wg: vec3<u32>,
) {
  let g = gid.x;
  let valid = g < p.n;
  var d = 0xffffffffu;
  if (valid) {
    var e = g;
    if (FIRST == 0u) { e = inIdx[g]; }
    d = (keys[e] >> SHIFT) & ${DIGITS - 1}u;
  }
  dg[t] = d;
  atomicStore(&hs[t], 0u);
  atomicStore(&hs[t + ${TILE}u], 0u);
  workgroupBarrier();
  if (valid) {
    var r = 0u;
    for (var j = 0u; j < t; j++) {
      if (dg[j] == d) { r++; }
    }
    rank[g] = r;
    atomicAdd(&hs[d], 1u);
  }
  workgroupBarrier();
  hist[t * p.blocks + wg.x] = atomicLoad(&hs[t]);
  hist[(t + ${TILE}u) * p.blocks + wg.x] = atomicLoad(&hs[t + ${TILE}u]);
}
`;

/** Pass step 2: workgroup d = exclusive scan of hist[d * blocks ..] in place; base[d] = the total. */
export const SCAN_DIGIT_WGSL = /* wgsl */ `\
${PARAMS}
@group(0) @binding(1) var<storage, read_write> hist: array<u32>;
@group(0) @binding(2) var<storage, read_write> base: array<u32>;
var<workgroup> sh: array<u32, ${TILE}>;

@compute @workgroup_size(${TILE}) fn main(
  @builtin(local_invocation_index) t: u32,
  @builtin(workgroup_id) wg: vec3<u32>,
) {
  let b = p.blocks;
  let o = wg.x * b;
  let chunk = (b + ${TILE - 1}u) / ${TILE}u;
  let s = min(t * chunk, b);
  let e = min(s + chunk, b);
  var sum = 0u;
  for (var i = s; i < e; i++) { sum += hist[o + i]; }
  sh[t] = sum;
  workgroupBarrier();
  for (var off = 1u; off < ${TILE}u; off = off << 1u) {
    var v = sh[t];
    if (t >= off) { v += sh[t - off]; }
    workgroupBarrier();
    sh[t] = v;
    workgroupBarrier();
  }
  var run = sh[t] - sum;
  for (var i = s; i < e; i++) {
    let v = hist[o + i];
    hist[o + i] = run;
    run += v;
  }
  if (t == ${TILE - 1}u) { base[wg.x] = sh[${TILE - 1}u]; }
}
`;

/** Pass step 3: one workgroup, exclusive scan of the 512 digit totals in place. */
export const SCAN_TOTALS_WGSL = /* wgsl */ `\
${PARAMS}
@group(0) @binding(1) var<storage, read_write> base: array<u32>;
var<workgroup> sh: array<u32, ${TILE}>;

@compute @workgroup_size(${TILE}) fn main(@builtin(local_invocation_index) t: u32) {
  let s0 = base[2u * t];
  let s1 = base[2u * t + 1u];
  let sum = s0 + s1;
  sh[t] = sum;
  workgroupBarrier();
  for (var off = 1u; off < ${TILE}u; off = off << 1u) {
    var v = sh[t];
    if (t >= off) { v += sh[t - off]; }
    workgroupBarrier();
    sh[t] = v;
    workgroupBarrier();
  }
  let ex = sh[t] - sum;
  base[2u * t] = ex;
  base[2u * t + 1u] = ex + s0;
}
`;

/**
 * Pass step 4: out[digitBase + tileOffset + rank] = element. digitBase = elements with a smaller
 * digit, tileOffset = same-digit elements in earlier tiles, rank = same-digit elements earlier in
 * the tile: the exact stable position. FIRST as in TILE_WGSL.
 */
export const SCATTER_WGSL = /* wgsl */ `\
${PARAMS}
override SHIFT: u32 = 0u;
override FIRST: u32 = 0u;
@group(0) @binding(1) var<storage, read> keys: array<u32>;
@group(0) @binding(2) var<storage, read> inIdx: array<u32>;
@group(0) @binding(3) var<storage, read> rank: array<u32>;
@group(0) @binding(4) var<storage, read> hist: array<u32>;
@group(0) @binding(5) var<storage, read> base: array<u32>;
@group(0) @binding(6) var<storage, read_write> outIdx: array<u32>;

@compute @workgroup_size(${TILE}) fn main(
  @builtin(global_invocation_id) gid: vec3<u32>,
  @builtin(workgroup_id) wg: vec3<u32>,
) {
  let g = gid.x;
  if (g >= p.n) { return; }
  var e = g;
  if (FIRST == 0u) { e = inIdx[g]; }
  let d = (keys[e] >> SHIFT) & ${DIGITS - 1}u;
  outIdx[base[d] + hist[d * p.blocks + wg.x] + rank[g]] = e;
}
`;
