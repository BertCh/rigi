// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// WGSL for the GPU guided filter (twin of look/guided-filter.ts). The CPU takes box means from a
// float64 summed-area table; here each (2r+1)² clamped box mean is separable (a row mean, then a
// column mean of row means: every row of the clamped window has the same count), summed directly in
// f32. r ≤ ~6 at 512 px, so a direct sum is cheaper than a scan and keeps f32 error ~1e-7.
// @workgroup_size(256): one texel per invocation, 1-D over w·h; 256 fills an Apple GPU SIMD group ×8.

const PARAMS = /* wgsl */ `
struct P { w: u32, h: u32, r: u32, eps: f32 };
`;

const RANGE = /* wgsl */ `
fn span(c: u32, r: u32, n: u32) -> vec2<u32> {
  return vec2<u32>(select(0u, c - r, c >= r), min(n, c + r + 1u));
}
`;

/** Row means of (I, p, I², I·p). */
export const GF_H0 = /* wgsl */ `${PARAMS}${RANGE}
@group(0) @binding(0) var<uniform> prm: P;
@group(0) @binding(1) var<storage, read> gI: array<f32>;
@group(0) @binding(2) var<storage, read> gp: array<f32>;
@group(0) @binding(3) var<storage, read_write> outv: array<vec4<f32>>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let n = prm.w * prm.h;
  let i = id.x;
  if (i >= n) { return; }
  let y = i / prm.w;
  let x = i - y * prm.w;
  let s = span(x, prm.r, prm.w);
  var acc = vec4<f32>(0.0);
  for (var k = s.x; k < s.y; k++) {
    let a = gI[y * prm.w + k];
    let b = gp[y * prm.w + k];
    acc += vec4<f32>(a, b, a * a, a * b);
  }
  outv[i] = acc / f32(s.y - s.x);
}
`;

/** Column means of the row means, then a = cov(I, p) / (var(I) + ε), b = mean(p) − a·mean(I). */
export const GF_V0 = /* wgsl */ `${PARAMS}${RANGE}
@group(0) @binding(0) var<uniform> prm: P;
@group(0) @binding(1) var<storage, read> inv: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> ab: array<vec2<f32>>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let n = prm.w * prm.h;
  let i = id.x;
  if (i >= n) { return; }
  let y = i / prm.w;
  let x = i - y * prm.w;
  let s = span(y, prm.r, prm.h);
  var m = vec4<f32>(0.0);
  for (var k = s.x; k < s.y; k++) { m += inv[k * prm.w + x]; }
  m /= f32(s.y - s.x);
  let a = (m.w - m.x * m.y) / (m.z - m.x * m.x + prm.eps);
  ab[i] = vec2<f32>(a, m.y - a * m.x);
}
`;

/** Row means of (a, b). */
export const GF_H1 = /* wgsl */ `${PARAMS}${RANGE}
@group(0) @binding(0) var<uniform> prm: P;
@group(0) @binding(1) var<storage, read> ab: array<vec2<f32>>;
@group(0) @binding(2) var<storage, read_write> outv: array<vec2<f32>>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let n = prm.w * prm.h;
  let i = id.x;
  if (i >= n) { return; }
  let y = i / prm.w;
  let x = i - y * prm.w;
  let s = span(x, prm.r, prm.w);
  var acc = vec2<f32>(0.0);
  for (var k = s.x; k < s.y; k++) { acc += ab[y * prm.w + k]; }
  outv[i] = acc / f32(s.y - s.x);
}
`;

/** Column means of (a, b), then q = clamp(mean(a)·I + mean(b), 0, 1). */
export const GF_V1 = /* wgsl */ `${PARAMS}${RANGE}
@group(0) @binding(0) var<uniform> prm: P;
@group(0) @binding(1) var<storage, read> inv: array<vec2<f32>>;
@group(0) @binding(2) var<storage, read> gI: array<f32>;
@group(0) @binding(3) var<storage, read_write> q: array<f32>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let n = prm.w * prm.h;
  let i = id.x;
  if (i >= n) { return; }
  let y = i / prm.w;
  let x = i - y * prm.w;
  let s = span(y, prm.r, prm.h);
  var m = vec2<f32>(0.0);
  for (var k = s.x; k < s.y; k++) { m += inv[k * prm.w + x]; }
  m /= f32(s.y - s.x);
  q[i] = clamp(m.x * gI[i] + m.y, 0.0, 1.0);
}
`;
