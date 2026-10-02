// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// WGSL for the GPU sky refine (twin of sky/core.ts refineToWorking with refine = true): the fast
// colour guided filter at model resolution, the band blend, the bilinear upsample to working
// resolution, and toBytes. The box means are not here: they are luma GPUConvolutions (all-ones
// kernel, zero boundary, direct strategy) between LO_PREP, LO_SOLVE and LO_FINISH, divided by the
// analytic in-range window count, which is the CPU's clamped-window mean in exact arithmetic. f32
// summation order differs from the CPU's f64 running sums, so the float mask agrees to ~1e-5 rather
// than bit-exactly (scripts/gpu/sky-refine-conv-dawn.ts prints the numbers).
// Exact by construction: the full-res guide (RGBA byte → the CPU's fround(d / 255) through a LUT),
// the band test (thresholds rewritten as f32 compares, see LO_SOLVE) and toBytes (per-byte f32
// thresholds, so no f32-vs-f64 rounding of v·255).
// @workgroup_size(256): one texel (or one packed word) per invocation, 1-D; 256 fills an Apple GPU
// SIMD group ×8 and keeps the dispatch under 65535 groups up to 16 Mpx.

const PARAMS = /* wgsl */ `
struct P { lw: u32, lh: u32, W: u32, H: u32, r: u32, br: u32, eps: f32, pad: u32 };
`;

const RANGE = /* wgsl */ `
fn span(c: u32, r: u32, n: u32) -> vec2<u32> {
  return vec2<u32>(select(0u, c - r, c >= r), min(n, c + r + 1u));
}
`;

/**
 * Stack layout shared by the three low-res kernels and the GPUConvolutions between them: c planes,
 * each lh rows of lw, followed by r zero rows, one field of width lw and height c·(lh + r). The gap
 * keeps a vertical window of radius r from reaching the next plane, so one convolution over the
 * stack equals one convolution per plane with a zero boundary.
 */

/**
 * Stack S1 (13 planes): I.r, I.g, I.b, p, I.r·p, I.g·p, I.b·p, rr, gg, bb, rg, rb, gb (the inputs
 * of the box means of the guided filter). One invocation per stack element, so the gap rows are
 * written too (zeros): a full write, as the graph's clear audit requires.
 * @workgroup_size(256), 1-D.
 */
export const LO_PREP = /* wgsl */ `${PARAMS}
@group(0) @binding(0) var<uniform> prm: P;
@group(0) @binding(1) var<storage, read> gl: array<f32>;
@group(0) @binding(2) var<storage, read> gp: array<f32>;
@group(0) @binding(3) var<storage, read_write> s1: array<f32>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let n = prm.lw * prm.lh;
  let pitch = prm.lh + prm.r;
  let i = id.x;
  if (i >= 13u * pitch * prm.lw) { return; }
  let row = i / prm.lw;
  let x = i - row * prm.lw;
  let c = row / pitch;
  let y = row - c * pitch;
  var v = 0.0;
  if (y < prm.lh) {
    let j = y * prm.lw + x;
    let col = vec3<f32>(gl[j], gl[n + j], gl[2u * n + j]);
    let p = gp[j];
    switch (c) {
      case 0u: { v = col.x; }
      case 1u: { v = col.y; }
      case 2u: { v = col.z; }
      case 3u: { v = p; }
      case 4u: { v = col.x * p; }
      case 5u: { v = col.y * p; }
      case 6u: { v = col.z * p; }
      case 7u: { v = col.x * col.x; }
      case 8u: { v = col.y * col.y; }
      case 9u: { v = col.z * col.z; }
      case 10u: { v = col.x * col.y; }
      case 11u: { v = col.x * col.z; }
      default: { v = col.y * col.z; }
    }
  }
  s1[i] = v;
}
`;

/**
 * The colour guided-filter solve on the box SUMS of S1 (S3, after the horizontal and vertical
 * GPUConvolutions): means = sums / the in-range window count (the CPU's clamped-window mean, an
 * all-ones zero-boundary convolution over the analytic count), then
 * a = (Σ + εI)⁻¹ cov(I, p), b = mean(p) − a·mean(I) (cofactor inverse, as the CPU), written to the
 * 4-plane stack A1 (gap rows zero) for the next smoothing. Also the band indicator
 * max(straddle, unsure) into the lw × lh plane: the 2-D window max / min of p over the clamped
 * (2·br+1)² window. The CPU compares f32 p with the f64 constants 0.05 / 0.95:
 * p > 0.05 ⇔ p ≥ f32(0.05) (f32(0.05) > 0.05) and p < 0.95 ⇔ p ≤ f32(0.95) (f32(0.95) < 0.95).
 * One invocation per (x, y) of the lh + r rows of a plane (rows ≥ lh write the zero gap).
 * @workgroup_size(256), 1-D.
 */
export const LO_SOLVE = /* wgsl */ `${PARAMS}${RANGE}
@group(0) @binding(0) var<uniform> prm: P;
@group(0) @binding(1) var<storage, read> s3: array<f32>;
@group(0) @binding(2) var<storage, read> gp: array<f32>;
@group(0) @binding(3) var<storage, read_write> a1: array<f32>;
@group(0) @binding(4) var<storage, read_write> band: array<f32>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let pitch = prm.lh + prm.r;
  let plane = pitch * prm.lw;
  let i = id.x;
  if (i >= plane) { return; }
  let y = i / prm.lw;
  let x = i - y * prm.lw;
  if (y >= prm.lh) {
    for (var c = 0u; c < 4u; c++) { a1[c * plane + i] = 0.0; }
    return;
  }
  let sx = span(x, prm.r, prm.lw);
  let sy = span(y, prm.r, prm.lh);
  let inv = 1.0 / f32((sx.y - sx.x) * (sy.y - sy.x));
  var m: array<f32, 13>;
  for (var c = 0u; c < 13u; c++) { m[c] = s3[c * plane + i] * inv; }
  let mI = vec3<f32>(m[0], m[1], m[2]);
  let mp = m[3];
  let x0 = m[4] - mI.x * mp;
  let x1 = m[5] - mI.y * mp;
  let x2 = m[6] - mI.z * mp;
  let s00 = (m[7] - mI.x * mI.x) + prm.eps;
  let s11 = (m[8] - mI.y * mI.y) + prm.eps;
  let s22 = (m[9] - mI.z * mI.z) + prm.eps;
  let s01 = m[10] - mI.x * mI.y;
  let s02 = m[11] - mI.x * mI.z;
  let s12 = m[12] - mI.y * mI.z;
  let c00 = s11 * s22 - s12 * s12;
  let c01 = s02 * s12 - s01 * s22;
  let c02 = s01 * s12 - s02 * s11;
  let c11 = s00 * s22 - s02 * s02;
  let c12 = s01 * s02 - s00 * s12;
  let c22 = s00 * s11 - s01 * s01;
  let det = s00 * c00 + s01 * c01 + s02 * c02;
  let id_ = 1.0 / det;
  let a0 = (c00 * x0 + c01 * x1 + c02 * x2) * id_;
  let a1v = (c01 * x0 + c11 * x1 + c12 * x2) * id_;
  let a2 = (c02 * x0 + c12 * x1 + c22 * x2) * id_;
  a1[i] = a0;
  a1[plane + i] = a1v;
  a1[2u * plane + i] = a2;
  a1[3u * plane + i] = mp - a0 * mI.x - a1v * mI.y - a2 * mI.z;
  let ex = span(x, prm.br, prm.lw);
  let ey = span(y, prm.br, prm.lh);
  var mx = gp[y * prm.lw + x];
  var mn = mx;
  for (var yy = ey.x; yy < ey.y; yy++) {
    for (var xx = ex.x; xx < ex.y; xx++) {
      let v = gp[yy * prm.lw + xx];
      mx = max(mx, v);
      mn = min(mn, v);
    }
  }
  let p = gp[y * prm.lw + x];
  let straddle = mx > 0.5 && mn < 0.5;
  let unsure = p >= 0.05 && p <= 0.95;
  band[y * prm.lw + x] = select(0.0, 1.0, straddle || unsure);
}
`;

/**
 * Smoothed (a, b) and the band blend weight for the upsample: the box SUMS of the (a, b) stack (A3,
 * radius r) and of the band plane (B2, 3×3) divided by their in-range counts, and p passed through.
 * @workgroup_size(256), 1-D.
 */
export const LO_FINISH = /* wgsl */ `${PARAMS}${RANGE}
@group(0) @binding(0) var<uniform> prm: P;
@group(0) @binding(1) var<storage, read> a3: array<f32>;
@group(0) @binding(2) var<storage, read> b2: array<f32>;
@group(0) @binding(3) var<storage, read> gp: array<f32>;
@group(0) @binding(4) var<storage, read_write> abS: array<vec4<f32>>;
@group(0) @binding(5) var<storage, read_write> pb: array<vec2<f32>>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let n = prm.lw * prm.lh;
  let i = id.x;
  if (i >= n) { return; }
  let y = i / prm.lw;
  let x = i - y * prm.lw;
  let plane = (prm.lh + prm.r) * prm.lw;
  let sx = span(x, prm.r, prm.lw);
  let sy = span(y, prm.r, prm.lh);
  let inv = 1.0 / f32((sx.y - sx.x) * (sy.y - sy.x));
  abS[i] = vec4<f32>(a3[i], a3[plane + i], a3[2u * plane + i], a3[3u * plane + i]) * inv;
  let ex = span(x, 1u, prm.lw);
  let ey = span(y, 1u, prm.lh);
  pb[i] = vec2<f32>(gp[i], b2[i] / f32((ex.y - ex.x) * (ey.y - ey.x)));
}
`;

// Resample tap tables (built on the CPU from sky/core.ts resampleAxis): axis[j] = (start, count) for
// output column j (j < W) or row j − W (W ≤ j < W + H); axis[start + t] = (source index,
// bitcast weight).

/** Row resample lw → W of the six low-res planes (a, b, p, band): output W × lh. */
export const UP_H = /* wgsl */ `${PARAMS}
@group(0) @binding(0) var<uniform> prm: P;
@group(0) @binding(1) var<storage, read> axis: array<vec2<u32>>;
@group(0) @binding(2) var<storage, read> abS: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> pb: array<vec2<f32>>;
@group(0) @binding(4) var<storage, read_write> u4: array<vec4<f32>>;
@group(0) @binding(5) var<storage, read_write> u2: array<vec2<f32>>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= prm.W * prm.lh) { return; }
  let y = i / prm.W;
  let X = i - y * prm.W;
  let hd = axis[X];
  var a = vec4<f32>(0.0);
  var b = vec2<f32>(0.0);
  for (var k = hd.x; k < hd.x + hd.y; k++) {
    let tp = axis[k];
    let w = bitcast<f32>(tp.y);
    let j = y * prm.lw + tp.x;
    a += w * abS[j];
    b += w * pb[j];
  }
  u4[i] = a;
  u2[i] = b;
}
`;

/**
 * Column resample lh → H, then q = clamp(a·I + b, 0, 1) on the full-res guide and the band blend
 * band·q + (1 − band)·up. The guide is the working RGBA (one u32 per texel) through the CPU's
 * rgbPlanes LUT, fround(d / 255).
 */
export const UP_V = /* wgsl */ `${PARAMS}
@group(0) @binding(0) var<uniform> prm: P;
@group(0) @binding(1) var<storage, read> axis: array<vec2<u32>>;
@group(0) @binding(2) var<storage, read> u4: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> u2: array<vec2<f32>>;
@group(0) @binding(4) var<storage, read> rgba: array<u32>;
@group(0) @binding(5) var<storage, read> lut: array<f32>;
@group(0) @binding(6) var<storage, read_write> q: array<f32>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= prm.W * prm.H) { return; }
  let Y = i / prm.W;
  let X = i - Y * prm.W;
  let hd = axis[prm.W + Y];
  var a = vec4<f32>(0.0);
  var b = vec2<f32>(0.0);
  for (var k = hd.x; k < hd.x + hd.y; k++) {
    let tp = axis[k];
    let w = bitcast<f32>(tp.y);
    let j = tp.x * prm.W + X;
    a += w * u4[j];
    b += w * u2[j];
  }
  let px = rgba[i];
  let g = vec3<f32>(lut[px & 255u], lut[(px >> 8u) & 255u], lut[(px >> 16u) & 255u]);
  let v = clamp(a.x * g.x + a.y * g.y + a.z * g.z + a.w, 0.0, 1.0);
  q[i] = b.y * v + (1.0 - b.y) * b.x;
}
`;

/**
 * toBytes: byte = the number of thresholds ≤ v, where thr[k − 1] is the least f32 with
 * toBytes(v) ≥ k (built on the CPU; lut[256 + k − 1]). Four texels per u32, little-endian.
 */
export const PACK = /* wgsl */ `${PARAMS}
@group(0) @binding(0) var<uniform> prm: P;
@group(0) @binding(1) var<storage, read> q: array<f32>;
@group(0) @binding(2) var<storage, read> lut: array<f32>;
@group(0) @binding(3) var<storage, read_write> bytes: array<u32>;
fn toByte(v: f32) -> u32 {
  var lo = 0u;
  var hi = 255u;
  while (lo < hi) {
    let mid = (lo + hi) >> 1u;
    if (v >= lut[256u + mid]) { lo = mid + 1u; } else { hi = mid; }
  }
  return lo;
}
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let N = prm.W * prm.H;
  let w = id.x;
  if (4u * w >= N) { return; }
  var word = 0u;
  for (var k = 0u; k < 4u; k++) {
    let i = 4u * w + k;
    if (i < N) { word |= toByte(q[i]) << (8u * k); }
  }
  bytes[w] = word;
}
`;
