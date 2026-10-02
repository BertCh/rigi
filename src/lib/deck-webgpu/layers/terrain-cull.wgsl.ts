// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// WGSL for the batched terrain's GPU cull (WAG W1.5, terrain-cull.ts): a frustum cull of the
// tiles' bounding spheres that writes one flag array per draw slot. The order-preserving compaction
// of the visible table rows into the slots' instance buffers (and their instanceCount) is luma's
// GPUCompaction (gpu-core), added to the graph per slot in terrain-cull.ts. Pure strings: the node
// check (terrain-cull-math.check.ts) parses them without a GPU, and terrain-cull-math.ts holds the
// CPU twins.
//
// Layouts (terrain-cull-math.ts packs them):
//   P (uniform, 80 B)  eye, near | right, tanX | up, tanY | fwd, kx | off (offset·tan), ky, n
//   cand[i] (32 B)     padded sphere (cx, cy, cz, r·1.02 + 1) in f32, table row, seg slot, 0, 0
//   flags[k·CAP + i]   1 when candidate i is in view and its seg slot is k (CAP = candidate capacity)
//   args (5 × u32 per draw slot)  WebGPU's indexed indirect record:
//                      indexCount, instanceCount, firstIndex, baseVertex = 0, firstInstance = 0
//                      (words 0 and 2 are static per seg set, written from the CPU; word 1 is
//                      GPUCompaction's `count`)
//   inst0..inst3       the visible table rows of seg slot k (the draw slot is the seg slot), in
//                      tile-set order
// firstInstance stays 0 (non-zero needs the optional 'indirect-first-instance' feature): every draw
// slot has its own instance buffer instead.

/** Draw slots (distinct mesh resolutions; the streamer uses 64 / 128 / 256). */
export const CULL_SLOTS = 4;
/** Words per indexed indirect record. */
export const RECORD_WORDS = 5;
/** Bytes of the uniform block P. */
export const CULL_PARAMS_BYTES = 80;
/** Bytes per candidate. */
export const CAND_BYTES = 32;
/** Margin coefficients (terrain-cull-math.ts cullMarginF32 is the twin). */
export const MARGIN_REL = 1e-5;
export const MARGIN_ABS = 1e-3;

const f = (x: number) => x.toExponential();

const PARAMS = /* wgsl */ `
struct P {
  eye: vec3<f32>, near: f32,
  right: vec3<f32>, tanX: f32,
  up: vec3<f32>, tanY: f32,
  fwd: vec3<f32>, kx: f32,
  off: vec2<f32>, ky: f32, n: u32,
};
struct Cand { sphere: vec4<f32>, row: u32, seg: u32, pad0: u32, pad1: u32 };
`;

/**
 * Conservative twin of camera.ts sphereInView in f32: a sphere is rejected only when it lies
 * outside a plane by more than `m`, a bound (> 100× the f32 rounding of every term: the f64 →
 * f32 inputs, the subtraction, the dot products, tan / k / offset) on how far the f32 test can
 * stray from the f64 one. So every sphere the CPU keeps is kept here (terrain-cull-math.check.ts).
 */
export const cullWgsl = (capacity: number) => /* wgsl */ `${PARAMS}
const CAP: u32 = ${capacity}u;
const SLOTS: u32 = ${CULL_SLOTS}u;
@group(0) @binding(0) var<uniform> prm: P;
@group(0) @binding(1) var<storage, read> cand: array<Cand>;
@group(0) @binding(2) var<storage, read_write> flags: array<u32>;

fn in_view(s: vec4<f32>) -> bool {
  let d = s.xyz - prm.eye;
  let r = s.w;
  let a = abs(s.xyz) + abs(prm.eye) + abs(d);
  let m = ${f(MARGIN_REL)} * (a.x + a.y + a.z + r) + ${f(MARGIN_ABS)};
  let z = dot(d, prm.fwd);
  if (z < prm.near - r - m) { return false; }
  let x = dot(d, prm.right);
  let y = dot(d, prm.up);
  let mx = m * (1.0 + abs(prm.off.x) + prm.tanX + prm.kx);
  let my = m * (1.0 + abs(prm.off.y) + prm.tanY + prm.ky);
  if (abs(x + prm.off.x * z) > prm.tanX * z + r * prm.kx + mx) { return false; }
  if (abs(y + prm.off.y * z) > prm.tanY * z + r * prm.ky + my) { return false; }
  return true;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= CAP) { return; }
  var inside = false;
  var seg = 0xffffffffu;
  if (i < prm.n) {
    inside = in_view(cand[i].sphere);
    seg = cand[i].seg;
  }
  for (var k = 0u; k < SLOTS; k++) {
    flags[k * CAP + i] = select(0u, 1u, inside && seg == k);
  }
}
`;

/** The cull at the smallest capacity, for the node check. */
export const CULL_WGSL = cullWgsl(64);
