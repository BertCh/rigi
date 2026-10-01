// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// WGSL for the batched terrain's GPU cull (WAG W1.5, terrain-cull.ts): a frustum cull of the
// tiles' bounding spheres, then an order-preserving compaction into per-slot instance buffers and
// one indexed indirect draw record per slot. Pure strings: the node check (terrain-cull-math.check.ts)
// parses them without a GPU, and terrain-cull-math.ts holds the CPU twins.
//
// Layouts (terrain-cull-math.ts packs them):
//   P (uniform, 80 B)  eye, near | right, tanX | up, tanY | fwd, kx | off (offset·tan), ky, n
//   cand[i] (32 B)     padded sphere (cx, cy, cz, r·1.02 + 1) in f32, table row, seg slot, 0, 0
//   segs[k] (16 B)     index count, first index (in the combined index buffer), 0, 0
//   args (5 × u32 per draw slot)  WebGPU's indexed indirect record:
//                      indexCount, instanceCount, firstIndex, baseVertex = 0, firstInstance = 0
//   inst0..inst3       the visible table rows of the seg drawn in that slot, in tile-set order
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
export const CULL_WGSL = /* wgsl */ `${PARAMS}
@group(0) @binding(0) var<uniform> prm: P;
@group(0) @binding(1) var<storage, read> cand: array<Cand>;
@group(0) @binding(2) var<storage, read_write> vis: array<u32>;

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
  if (i >= prm.n) { return; }
  vis[i] = select(0u, 1u, in_view(cand[i].sphere));
}
`;

/**
 * One workgroup: per seg slot the visible count and the first visible candidate; the draw slots in
 * the order of those first indices (BatchedTerrainCore.visibleRows' Map insertion order, so the
 * draws come in the CPU path's order); the records; then a stable compaction (per chunk of 256 and
 * per seg, an inclusive Hillis-Steele scan) of the visible rows into their slot's instance buffer.
 */
export const COMPACT_WGSL = /* wgsl */ `${PARAMS}
const SLOTS: u32 = ${CULL_SLOTS}u;
const WORDS: u32 = ${RECORD_WORDS}u;
const NONE: u32 = 0xffffffffu;

@group(0) @binding(0) var<uniform> prm: P;
@group(0) @binding(1) var<storage, read> cand: array<Cand>;
@group(0) @binding(2) var<storage, read> vis: array<u32>;
@group(0) @binding(3) var<storage, read> segs: array<vec4<u32>>;
@group(0) @binding(4) var<storage, read_write> args: array<u32>;
@group(0) @binding(5) var<storage, read_write> inst0: array<u32>;
@group(0) @binding(6) var<storage, read_write> inst1: array<u32>;
@group(0) @binding(7) var<storage, read_write> inst2: array<u32>;
@group(0) @binding(8) var<storage, read_write> inst3: array<u32>;

var<workgroup> count: array<atomic<u32>, ${CULL_SLOTS}>;
var<workgroup> first: array<atomic<u32>, ${CULL_SLOTS}>;
var<workgroup> slotOf: array<u32, ${CULL_SLOTS}>;
var<workgroup> base: array<u32, ${CULL_SLOTS}>;
var<workgroup> scan: array<u32, 256>;

fn put(slot: u32, pos: u32, row: u32) {
  if (slot == 0u) { inst0[pos] = row; }
  else if (slot == 1u) { inst1[pos] = row; }
  else if (slot == 2u) { inst2[pos] = row; }
  else { inst3[pos] = row; }
}

@compute @workgroup_size(256)
fn main(@builtin(local_invocation_index) t: u32) {
  let n = prm.n;
  if (t < SLOTS) {
    atomicStore(&count[t], 0u);
    atomicStore(&first[t], NONE);
  }
  workgroupBarrier();
  for (var i = t; i < n; i += 256u) {
    if (vis[i] != 0u) {
      let s = cand[i].seg;
      atomicAdd(&count[s], 1u);
      atomicMin(&first[s], i);
    }
  }
  workgroupBarrier();
  if (t == 0u) {
    for (var k = 0u; k < SLOTS; k++) {
      slotOf[k] = NONE;
      base[k] = 0u;
    }
    // draw slot s = the seg with the s-th smallest first visible index; segs with nothing visible
    // get no slot
    for (var s = 0u; s < SLOTS; s++) {
      var best = NONE;
      var bestFirst = NONE;
      for (var k = 0u; k < SLOTS; k++) {
        let fk = atomicLoad(&first[k]);
        if (slotOf[k] == NONE && fk < bestFirst) {
          bestFirst = fk;
          best = k;
        }
      }
      if (best != NONE) { slotOf[best] = s; }
    }
    for (var w = 0u; w < SLOTS * WORDS; w++) { args[w] = 0u; }
    for (var k = 0u; k < SLOTS; k++) {
      let s = slotOf[k];
      if (s != NONE) {
        args[s * WORDS] = segs[k].x;
        args[s * WORDS + 1u] = atomicLoad(&count[k]);
        args[s * WORDS + 2u] = segs[k].y;
      }
    }
  }
  workgroupBarrier();
  let chunks = (n + 255u) / 256u;
  for (var c = 0u; c < chunks; c++) {
    let i = c * 256u + t;
    var v = 0u;
    var sg = NONE;
    if (i < n) {
      v = vis[i];
      sg = cand[i].seg;
    }
    for (var k = 0u; k < SLOTS; k++) {
      let mine = select(0u, 1u, v != 0u && sg == k);
      scan[t] = mine;
      workgroupBarrier();
      for (var o = 1u; o < 256u; o = o << 1u) {
        var add = 0u;
        if (t >= o) { add = scan[t - o]; }
        workgroupBarrier();
        scan[t] = scan[t] + add;
        workgroupBarrier();
      }
      if (mine == 1u) { put(slotOf[k], base[k] + scan[t] - 1u, cand[i].row); }
      let total = scan[255];
      workgroupBarrier();
      if (t == 0u) { base[k] = base[k] + total; }
      workgroupBarrier();
    }
  }
}
`;
