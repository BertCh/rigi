// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// WGSL for the haze fit's airlight band on the GPU (./haze-band.ts, the GPU band, default on): haze.ts
// airlightBand's per-column walk, exactly. No float arithmetic: range and P(sky) are bound as u32
// bit patterns and every test is an integer compare on an order-preserving key, so subnormal
// flushing, fused multiply-add or fast-math cannot change a decision (precision README, rule 5).
//
// The CPU tests compare an f32 value, widened to f64, with an f64 constant c. `x < c` holds exactly
// when x ≤ the largest f32 strictly below c (bandThresholds), and `x > 0` when x is at least the
// smallest positive subnormal; NaN fails both, as in JS. key(b) maps f32 bits to u32 so that
// unsigned order is float order (−0 just below +0, which no test distinguishes).
import { LISTS } from "./haze.wgsl";
//
// Kernels (@workgroup_size(64) unless noted):
//  hzb-count   one invocation per band column j (x = 2j): the topmost terrain row (range > 0 and
//              P(sky) < 0.5) into top[j], and the band's pixel count into cnt[j]
//  (core GPUScan, exclusive, over cnt → off)
//  hzb-total   one invocation: K = off[n−1] + cnt[n−1]
//  hzb-scatter per column again: the band's pixel indices at off[j], in row order
//  hzb-gather  per band slot k < K: lin's 3 words at idx[k], bit for bit
//  hzb-range   per list slot k < total (starts[72]), @workgroup_size(256): range's bits at outIdx[k] (the tail's range)
//  hzb-spot    per (spot column, row): range and P(sky) bits of a few CPU-chosen columns, which the
//              CPU re-walks with airlightBand's own code (the per-call spot check)

/** Columns the CPU re-walks per call (hzb-spot). */
export const SPOT_COLUMNS = 8;
/** hzb-range's workgroup size. */
export const RANGE_GROUP = 256;

const BAND_PARAMS = /* wgsl */ `
struct B { W: u32, H: u32, nCol: u32, a0: u32, a1: u32, keyBelowHalf: u32, keyBelow07: u32, kMax: u32 };
fn isNan(b: u32) -> bool { return (b & 0x7fffffffu) > 0x7f800000u; }
fn orderKey(b: u32) -> u32 { return select(b | 0x80000000u, ~b, (b & 0x80000000u) != 0u); }
// x > 0 (f64 compare of the widened f32): +0's key is 0x80000000
fn positive(b: u32) -> bool { return !isNan(b) && orderKey(b) > 0x80000000u; }
// x < c, given the key of the largest f32 below c
fn below(b: u32, key: u32) -> bool { return !isNan(b) && orderKey(b) <= key; }
`;

/** Per band column: top row (−1: none) and the band's pixel count. */
export const HZB_COUNT = /* wgsl */ `${BAND_PARAMS}
@group(0) @binding(0) var<uniform> prm: B;
@group(0) @binding(1) var<storage, read> range: array<u32>;
@group(0) @binding(2) var<storage, read> psky: array<u32>;
@group(0) @binding(3) var<storage, read_write> top: array<i32>;
@group(0) @binding(4) var<storage, read_write> cnt: array<u32>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let j = id.x;
  if (j >= prm.nCol) { return; }
  let x = 2u * j;
  var t = -1;
  for (var y = 0u; y < prm.H; y++) {
    let i = y * prm.W + x;
    if (positive(range[i]) && below(psky[i], prm.keyBelowHalf)) { t = i32(y); break; }
  }
  top[j] = t;
  var n = 0u;
  if (t >= 0) {
    for (var y = max(0, t - i32(prm.a1)); y <= t - i32(prm.a0); y++) {
      let i = u32(y) * prm.W + x;
      if (positive(range[i]) || below(psky[i], prm.keyBelow07)) { continue; }
      n += 1u;
    }
  }
  cnt[j] = n;
}
`;

/** K, the band's length: off[n−1] + cnt[n−1] (one invocation). */
export const HZB_TOTAL = /* wgsl */ `${BAND_PARAMS}
@group(0) @binding(0) var<uniform> prm: B;
@group(0) @binding(1) var<storage, read> cnt: array<u32>;
@group(0) @binding(2) var<storage, read> off: array<u32>;
@group(0) @binding(3) var<storage, read_write> total: array<u32>;
@compute @workgroup_size(1)
fn main() {
  total[0] = off[prm.nCol - 1u] + cnt[prm.nCol - 1u];
}
`;

/** Per band column again: its band pixels' indices at off[j], rows in order (the CPU's push order). */
export const HZB_SCATTER = /* wgsl */ `${BAND_PARAMS}
@group(0) @binding(0) var<uniform> prm: B;
@group(0) @binding(1) var<storage, read> range: array<u32>;
@group(0) @binding(2) var<storage, read> psky: array<u32>;
@group(0) @binding(3) var<storage, read> top: array<i32>;
@group(0) @binding(4) var<storage, read> off: array<u32>;
@group(0) @binding(5) var<storage, read_write> bandIdx: array<u32>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let j = id.x;
  if (j >= prm.nCol) { return; }
  let t = top[j];
  if (t < 0) { return; }
  let x = 2u * j;
  var at = off[j];
  for (var y = max(0, t - i32(prm.a1)); y <= t - i32(prm.a0); y++) {
    let i = u32(y) * prm.W + x;
    if (positive(range[i]) || below(psky[i], prm.keyBelow07)) { continue; }
    bandIdx[at] = i;
    at += 1u;
  }
}
`;

/** The band's lin, 3 words per slot, copied as bits (slots ≥ K are left as they are). */
export const HZB_GATHER = /* wgsl */ `
@group(0) @binding(0) var<storage, read> total: array<u32>;
@group(0) @binding(1) var<storage, read> bandIdx: array<u32>;
@group(0) @binding(2) var<storage, read> lin: array<u32>;
@group(0) @binding(3) var<storage, read_write> bandLin: array<u32>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let k = id.x;
  if (k >= total[0]) { return; }
  let i = bandIdx[k];
  bandLin[3u * k] = lin[3u * i];
  bandLin[3u * k + 1u] = lin[3u * i + 1u];
  bandLin[3u * k + 2u] = lin[3u * i + 2u];
}
`;

/** Per list slot k < starts[72]: the range bits of its pixel (the CPU tail's range[i]). */
export const HZB_RANGE = /* wgsl */ `
@group(0) @binding(0) var<storage, read> starts: array<u32>;
@group(0) @binding(1) var<storage, read> outIdx: array<u32>;
@group(0) @binding(2) var<storage, read> range: array<u32>;
@group(0) @binding(3) var<storage, read_write> outRange: array<u32>;
@compute @workgroup_size(${RANGE_GROUP})
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let k = id.x;
  if (k >= starts[${LISTS}]) { return; }
  outRange[k] = range[outIdx[k]];
}
`;

/** The spot columns' range and P(sky) bits, all rows: spot[(s·H + y)·2 + {0, 1}]. */
export const HZB_SPOT = /* wgsl */ `${BAND_PARAMS}
@group(0) @binding(0) var<uniform> prm: B;
@group(0) @binding(1) var<storage, read> cols: array<u32>;
@group(0) @binding(2) var<storage, read> range: array<u32>;
@group(0) @binding(3) var<storage, read> psky: array<u32>;
@group(0) @binding(4) var<storage, read_write> spot: array<u32>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let k = id.x;
  if (k >= ${SPOT_COLUMNS}u * prm.H) { return; }
  let s = k / prm.H;
  let y = k - s * prm.H;
  let i = y * prm.W + cols[s];
  spot[2u * k] = range[i];
  spot[2u * k + 1u] = psky[i];
}
`;
