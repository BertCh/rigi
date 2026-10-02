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
//
// Kernels (@workgroup_size(64) unless noted):
//  hzb-top     one invocation per band column j (x = 2j): the topmost terrain row (range > 0 and
//              P(sky) < 0.5) into top[j]
//  hzb-flags   @workgroup_size(256), one invocation per column-major slot j·H + y: the pixel index and
//              the in-band flag (the CPU's per-column walk, as flags)
//  (core GPUCompaction over elem / flag: the band's pixel indices in the CPU's push order, and K)
//  (core GPUGather: the band's lin at bandIdx, and range at the lists' outIdx, see haze-graph.ts)
//  hzb-spot    per (spot column, row): range and P(sky) bits of a few CPU-chosen columns, which the
//              CPU re-walks with airlightBand's own code (the per-call spot check)

/** Columns the CPU re-walks per call (hzb-spot). */
export const SPOT_COLUMNS = 8;
/** hzb-flags' workgroup size. */
export const FLAGS_GROUP = 256;

const BAND_PARAMS = /* wgsl */ `
struct B { W: u32, H: u32, nCol: u32, a0: u32, a1: u32, keyBelowHalf: u32, keyBelow07: u32, kMax: u32 };
fn isNan(b: u32) -> bool { return (b & 0x7fffffffu) > 0x7f800000u; }
fn orderKey(b: u32) -> u32 { return select(b | 0x80000000u, ~b, (b & 0x80000000u) != 0u); }
// x > 0 (f64 compare of the widened f32): +0's key is 0x80000000
fn positive(b: u32) -> bool { return !isNan(b) && orderKey(b) > 0x80000000u; }
// x < c, given the key of the largest f32 below c
fn below(b: u32, key: u32) -> bool { return !isNan(b) && orderKey(b) <= key; }
`;

/** Per band column: the topmost terrain row (−1: none). */
export const HZB_TOP = /* wgsl */ `${BAND_PARAMS}
@group(0) @binding(0) var<uniform> prm: B;
@group(0) @binding(1) var<storage, read> range: array<u32>;
@group(0) @binding(2) var<storage, read> psky: array<u32>;
@group(0) @binding(3) var<storage, read_write> top: array<i32>;
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
}
`;

/**
 * The band's compaction input, column-major: slot s = j·H + y of band column j (x = 2j) holds the
 * pixel index y·W + x and a flag, 1 when that pixel is in the band (its column's rows top − a1 …
 * top − a0, not a terrain-range pixel and not sky-like). One invocation per slot, every slot written.
 */
export const HZB_FLAGS = /* wgsl */ `${BAND_PARAMS}
@group(0) @binding(0) var<uniform> prm: B;
@group(0) @binding(1) var<storage, read> range: array<u32>;
@group(0) @binding(2) var<storage, read> psky: array<u32>;
@group(0) @binding(3) var<storage, read> top: array<i32>;
@group(0) @binding(4) var<storage, read_write> elem: array<u32>;
@group(0) @binding(5) var<storage, read_write> flag: array<u32>;
@compute @workgroup_size(${FLAGS_GROUP})
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let s = id.x;
  if (s >= prm.nCol * prm.H) { return; }
  let j = s / prm.H;
  let y = s - j * prm.H;
  let i = y * prm.W + 2u * j;
  elem[s] = i;
  let t = top[j];
  var inBand = t >= 0 && i32(y) >= max(0, t - i32(prm.a1)) && i32(y) <= t - i32(prm.a0);
  if (inBand && (positive(range[i]) || below(psky[i], prm.keyBelow07))) { inBand = false; }
  flag[s] = select(0u, 1u, inBand);
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
