// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// WGSL for the GPU guided filter (twin of look/guided-filter.ts). The box means are NOT here: they are
// luma GPUConvolutions (all-ones kernel, zero boundary, direct strategy, one horizontal and one
// vertical pass) between GF_PREP, GF_SOLVE and GF_FINISH, and the kernels here divide the window SUMS
// by the analytic in-range window count, which is the CPU's clamped-window mean in exact arithmetic.
// f32 summation differs from the CPU's f64 summed-area table, so q agrees to ~1e-5, not bit for bit
// (scripts/gpu/guided-filter-conv-dawn.ts prints the numbers).
//
// Stack layout: c planes, each h rows of w, followed by r zero rows, one field of width w and height
// c·(h + r). The gap keeps a vertical window of radius r from reaching the next plane, so one
// convolution over the stack equals one convolution per plane with a zero boundary.
// @workgroup_size(256): one stack element per invocation, 1-D; 256 fills an Apple GPU SIMD group ×8.

import { BOX_SPAN_WGSL } from "../core/wgsl/box";

const PARAMS = /* wgsl */ `
struct P { w: u32, h: u32, r: u32, eps: f32 };
`;

const RANGE = BOX_SPAN_WGSL;

/** Stack S1 (4 planes): I, p, I², I·p. Gap rows are written too (zeros): a full write. */
export const GF_PREP = /* wgsl */ `${PARAMS}
@group(0) @binding(0) var<uniform> prm: P;
@group(0) @binding(1) var<storage, read> gI: array<f32>;
@group(0) @binding(2) var<storage, read> gp: array<f32>;
@group(0) @binding(3) var<storage, read_write> s1: array<f32>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let pitch = prm.h + prm.r;
  let i = id.x;
  if (i >= 4u * pitch * prm.w) { return; }
  let row = i / prm.w;
  let x = i - row * prm.w;
  let c = row / pitch;
  let y = row - c * pitch;
  var v = 0.0;
  if (y < prm.h) {
    let j = y * prm.w + x;
    let a = gI[j];
    let b = gp[j];
    switch (c) {
      case 0u: { v = a; }
      case 1u: { v = b; }
      case 2u: { v = a * a; }
      default: { v = a * b; }
    }
  }
  s1[i] = v;
}
`;

/**
 * From the box SUMS of S1 (S3): means = sums / count, then a = cov(I, p) / (var(I) + ε),
 * b = mean(p) − a·mean(I), into the 2-plane stack (gap rows zero). One invocation per (x, y) of the
 * h + r rows of a plane.
 */
export const GF_SOLVE = /* wgsl */ `${PARAMS}${RANGE}
@group(0) @binding(0) var<uniform> prm: P;
@group(0) @binding(1) var<storage, read> s3: array<f32>;
@group(0) @binding(2) var<storage, read_write> ab: array<f32>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let pitch = prm.h + prm.r;
  let plane = pitch * prm.w;
  let i = id.x;
  if (i >= plane) { return; }
  let y = i / prm.w;
  let x = i - y * prm.w;
  if (y >= prm.h) {
    ab[i] = 0.0;
    ab[plane + i] = 0.0;
    return;
  }
  let sx = span(x, prm.r, prm.w);
  let sy = span(y, prm.r, prm.h);
  let inv = 1.0 / f32((sx.y - sx.x) * (sy.y - sy.x));
  let mI = s3[i] * inv;
  let mp = s3[plane + i] * inv;
  let mII = s3[2u * plane + i] * inv;
  let mIp = s3[3u * plane + i] * inv;
  let a = (mIp - mI * mp) / (mII - mI * mI + prm.eps);
  ab[i] = a;
  ab[plane + i] = mp - a * mI;
}
`;

/** q = clamp(mean(a)·I + mean(b), 0, 1) from the box SUMS of the (a, b) stack (AB3). */
export const GF_FINISH = /* wgsl */ `${PARAMS}${RANGE}
@group(0) @binding(0) var<uniform> prm: P;
@group(0) @binding(1) var<storage, read> ab3: array<f32>;
@group(0) @binding(2) var<storage, read> gI: array<f32>;
@group(0) @binding(3) var<storage, read_write> q: array<f32>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let n = prm.w * prm.h;
  let i = id.x;
  if (i >= n) { return; }
  let y = i / prm.w;
  let x = i - y * prm.w;
  let plane = (prm.h + prm.r) * prm.w;
  let sx = span(x, prm.r, prm.w);
  let sy = span(y, prm.r, prm.h);
  let inv = 1.0 / f32((sx.y - sx.x) * (sy.y - sy.x));
  q[i] = clamp((ab3[i] * gI[i] + ab3[plane + i]) * inv, 0.0, 1.0);
}
`;
