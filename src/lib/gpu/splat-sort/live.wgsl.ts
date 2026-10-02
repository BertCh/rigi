// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// WGSL of the LIVE splat sort (./live.ts): a counting sort over the live prefix `[0, count)` of a
// GPU-written splat buffer, where `count` lives in a GPU buffer (nearfield/live compaction counter)
// and never reaches the CPU. Every kernel but the scan is dispatched indirectly with
// ceil(count / TILE) workgroups, so the work scales with the live count, not the capacity. The
// 16-bit key is the one of ./splat-sort.wgsl.ts (farthest = 0). Splats at or behind the camera plane
// (and NaN dead slots) are dropped: they get no slot, and the scan writes the kept total into the
// indirect draw record, so the draw issues exactly the kept instances.
//
// Not stable: the scatter claims slots with atomics, so splats of one key (depth within 1/65535 of
// the span) land in any order. Invisible for blended splats of that depth gap, and it is what lets
// the scatter run over `count` instead of a stable multi-pass radix over `capacity`.
import { TILE } from "./splat-sort.wgsl";

export { TILE };
/** Depth key bins (16-bit keys). */
export const LIVE_BINS = 65536;
/** Threads of the scan workgroup; each scans LIVE_BINS / SCAN_THREADS contiguous bins. */
export const SCAN_THREADS = 256;

const PARAMS = /* wgsl */ `\
struct Params {
  row: vec4<f32>,
  near: f32,
  capacity: u32,
  vertexCount: u32,
  pad0: u32,
};
@group(0) @binding(0) var<uniform> p: Params;
`;

/** One thread: dispatch args [ceil(count / TILE), 1, 1, 0] from the counter, and a zeroed draw record. */
export const LIVE_ARGS_WGSL = /* wgsl */ `\
${PARAMS}
@group(0) @binding(1) var<storage, read> counter: array<u32>;
@group(0) @binding(2) var<storage, read_write> dispatchArgs: array<u32>;

@compute @workgroup_size(1) fn main() {
  let n = min(counter[0], p.capacity);
  dispatchArgs[0] = (n + ${TILE - 1}u) / ${TILE}u;
  dispatchArgs[1] = 1u;
  dispatchArgs[2] = 1u;
  dispatchArgs[3] = n;
}
`;

/** Depth of every live splat (f32 bits; 0xffffffff = dropped) and the min / max depth (atomics on bits). */
export const LIVE_DEPTH_WGSL = /* wgsl */ `\
${PARAMS}
@group(0) @binding(1) var<storage, read> counter: array<u32>;
@group(0) @binding(2) var<storage, read> splatData: array<vec4<u32>>;
@group(0) @binding(3) var<storage, read_write> depth: array<u32>;
@group(0) @binding(4) var<storage, read_write> mm: array<atomic<u32>>;

@compute @workgroup_size(${TILE}) fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= min(counter[0], p.capacity)) { return; }
  let t = bitcast<vec4<f32>>(splatData[3u * i]);
  let dist = -(((p.row.x * t.x + p.row.y * t.y) + p.row.z * t.z) + p.row.w);
  let bits = bitcast<u32>(dist);
  if (dist > p.near && bits < 0x7f800000u) {
    depth[i] = bits;
    atomicMax(&mm[0], ~bits);
    atomicMax(&mm[1], bits);
  } else {
    depth[i] = 0xffffffffu;
  }
}
`;

/** The 16-bit key of every kept splat and the per-key histogram (hist cleared to 0 per sort). */
export const LIVE_KEYS_WGSL = /* wgsl */ `\
${PARAMS}
@group(0) @binding(1) var<storage, read> counter: array<u32>;
@group(0) @binding(2) var<storage, read> depth: array<u32>;
@group(0) @binding(3) var<storage, read> mm: array<u32>;
@group(0) @binding(4) var<storage, read_write> keys: array<u32>;
@group(0) @binding(5) var<storage, read_write> hist: array<atomic<u32>>;

@compute @workgroup_size(${TILE}) fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= min(counter[0], p.capacity)) { return; }
  let bits = depth[i];
  if (bits == 0xffffffffu) { keys[i] = 0xffffffffu; return; }
  let maxD = bitcast<f32>(mm[1]);
  let minD = bitcast<f32>(~mm[0]);
  let span = maxD - minD;
  var k = 0.0;
  if (span > 0.0) { k = 65535.0 / span; }
  let key = min(65535u, u32((maxD - bitcast<f32>(bits)) * k));
  keys[i] = key;
  atomicAdd(&hist[key], 1u);
}
`;

/**
 * Exclusive scan of the histogram, in place, by ONE workgroup (SCAN_THREADS threads, each
 * LIVE_BINS / SCAN_THREADS contiguous bins), and the draw record [vertexCount, kept, 0, 0].
 */
export const LIVE_SCAN_WGSL = /* wgsl */ `\
${PARAMS}
@group(0) @binding(1) var<storage, read_write> hist: array<u32>;
@group(0) @binding(2) var<storage, read_write> drawArgs: array<u32>;
const PER: u32 = ${LIVE_BINS / SCAN_THREADS}u;
var<workgroup> sums: array<u32, ${SCAN_THREADS}>;

@compute @workgroup_size(${SCAN_THREADS}) fn main(@builtin(local_invocation_index) t: u32) {
  let base = t * PER;
  var s = 0u;
  for (var j = 0u; j < PER; j++) { s += hist[base + j]; }
  sums[t] = s;
  workgroupBarrier();
  if (t == 0u) {
    var run = 0u;
    for (var q = 0u; q < ${SCAN_THREADS}u; q++) {
      let v = sums[q];
      sums[q] = run;
      run += v;
    }
    drawArgs[0] = p.vertexCount;
    drawArgs[1] = run;
    drawArgs[2] = 0u;
    drawArgs[3] = 0u;
  }
  workgroupBarrier();
  var acc = sums[t];
  for (var j = 0u; j < PER; j++) {
    let v = hist[base + j];
    hist[base + j] = acc;
    acc += v;
  }
}
`;

/** Scatter: each kept splat claims the next slot of its key (hist now holds the key's start). */
export const LIVE_SCATTER_WGSL = /* wgsl */ `\
${PARAMS}
@group(0) @binding(1) var<storage, read> counter: array<u32>;
@group(0) @binding(2) var<storage, read> keys: array<u32>;
@group(0) @binding(3) var<storage, read_write> hist: array<atomic<u32>>;
@group(0) @binding(4) var<storage, read_write> order: array<u32>;

@compute @workgroup_size(${TILE}) fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= min(counter[0], p.capacity)) { return; }
  let key = keys[i];
  if (key == 0xffffffffu) { return; }
  order[atomicAdd(&hist[key], 1u)] = i;
}
`;
