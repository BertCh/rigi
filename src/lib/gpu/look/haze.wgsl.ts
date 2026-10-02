// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// WGSL for the GPU haze fit (twin of look/haze-fit.ts fitHaze). Three groups of kernels:
//  1. per pixel: the photo box-resampled to linear on the geo grid, the depth-edge test, the
//     the edge / people masks (dilated between the prep and the bin kernel by luma gpu-raster
//     GPURasterDilation passes, see raster-dilate.ts) and the log-range bin, with per-bin counts;
//  2. exact order statistics per (bin, channel) for the 1st / 9th percentiles: a 3-pass radix
//     select over the f32 bit patterns (lin ≥ 0, so they sort as u32), 11 + 11 + 10 bits, with
//     atomic histograms, all on the GPU (no readback between passes);
//  3. the representative pixels: per (bin, channel) the pixels whose value lies between the 1st
//     and 9th percentile's bracketing order statistics (a superset of the CPU's [v0, v1]), in pixel
//     order, compacted into one list (block counts → per-list offsets → scatter), plus the airlight
//     band's pixels gathered by index, so the ~16 B/pixel lin + bins never come back to the CPU;
//  4. the physical fit's (H_M, kR, β_M) grid: one invocation per cell evaluates the robust SSE,
//     read back as 5 550 floats; the CPU re-checks the near-best cells in f64.

const NBINS = 24;
/** Words of one mask plane in HZ_PREP's `masks` / HZ_BIN's `near` (a 256-byte multiple: a view offset). */
export const planeWords = (pixels: number) => Math.ceil(pixels / 64) * 64;
/** Order statistics per (bin, channel): ranks ⌊0.01(n−1)⌋, +1, ⌊0.09(n−1)⌋, +1. */
export const SEL = NBINS * 3 * 4;
export const BUCKETS = 2048;

const PREP_PARAMS = /* wgsl */ `
struct P { W: u32, H: u32, pw: u32, rad: u32, fgRad: u32, lo: f32, span: f32, rmin: f32, rmax: f32 };
`;

/** @workgroup_size(256), 1-D over the W·H geo pixels (all prep kernels). */
export const HZ_PREP = /* wgsl */ `${PREP_PARAMS}
@group(0) @binding(0) var<uniform> prm: P;
@group(0) @binding(1) var<storage, read> photo: array<u32>;
@group(0) @binding(2) var<storage, read> xb: array<u32>;
@group(0) @binding(3) var<storage, read> yb: array<u32>;
@group(0) @binding(4) var<storage, read> lut: array<f32>;
@group(0) @binding(5) var<storage, read> range: array<f32>;
@group(0) @binding(6) var<storage, read> fgm: array<u32>; // 1 bit per pixel
@group(0) @binding(7) var<storage, read_write> lin: array<f32>;
// two planes of planeWords(W·H) words: the depth-edge mask, then the people mask (the dilation
// passes view each plane; one binding keeps the kernel within the default 8 storage buffers)
@group(0) @binding(8) var<storage, read_write> masks: array<u32>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let W = prm.W; let H = prm.H;
  let i = id.x;
  if (i >= W * H) { return; }
  let y = i / W;
  let x = i - y * W;
  // box over the geo pixel's photo footprint (bounds from the CPU, exact)
  let x0 = xb[2u * x]; let x1 = xb[2u * x + 1u];
  let y0 = yb[2u * y]; let y1 = yb[2u * y + 1u];
  var s = vec3<f32>(0.0);
  for (var yy = y0; yy < y1; yy++) {
    for (var xx = x0; xx < x1; xx++) {
      let p = photo[yy * prm.pw + xx];
      s += vec3<f32>(lut[p & 255u], lut[(p >> 8u) & 255u], lut[(p >> 16u) & 255u]);
    }
  }
  s *= 1.0 / f32((y1 - y0) * (x1 - x0));
  lin[3u * i] = s.x; lin[3u * i + 1u] = s.y; lin[3u * i + 2u] = s.z;
  // depth edges: sky, or a 4-neighbour at > 12 % log-range
  let r = range[i];
  var edge = r <= 0.0;
  if (!edge) {
    var nb = array<f32, 4>(r, r, r, r);
    if (x > 0u) { nb[0] = range[i - 1u]; }
    if (x + 1u < W) { nb[1] = range[i + 1u]; }
    if (y > 0u) { nb[2] = range[i - W]; }
    if (y + 1u < H) { nb[3] = range[i + W]; }
    for (var k = 0; k < 4; k++) {
      if (nb[k] <= 0.0 || abs(log(nb[k] / r)) > 0.12) { edge = true; }
    }
  }
  masks[i] = select(0u, 1u, edge);
  masks[((W * H + 63u) & ~63u) + i] = (fgm[i >> 5u] >> (i & 31u)) & 1u;
}
`;

/** The log-range bin (−1 = unused) of pixels away from the dilated edge / people masks, and the per-bin counts. */
export const HZ_BIN = /* wgsl */ `${PREP_PARAMS}
@group(0) @binding(0) var<uniform> prm: P;
@group(0) @binding(1) var<storage, read> near: array<u32>; // the dilated masks, planes as in HZ_PREP's masks
@group(0) @binding(2) var<storage, read> range: array<f32>;
@group(0) @binding(3) var<storage, read> psky: array<f32>;
@group(0) @binding(4) var<storage, read_write> bins: array<i32>;
@group(0) @binding(5) var<storage, read_write> counts: array<atomic<u32>>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let W = prm.W; let H = prm.H;
  let i = id.x;
  if (i >= W * H) { return; }
  let nearBit = near[i] | near[((W * H + 63u) & ~63u) + i];
  let r = range[i];
  var b = -1;
  if (!(r < prm.rmin || r >= prm.rmax || nearBit != 0u || psky[i] > 0.3)) {
    b = i32(floor(((log(r) - prm.lo) / prm.span) * ${NBINS}.0));
    b = clamp(b, 0, ${NBINS - 1});
    atomicAdd(&counts[b], 1u);
  }
  bins[i] = b;
}
`;

const SEL_COMMON = /* wgsl */ `
struct S { W: u32, H: u32, pass_: u32, pad: u32 };
// per pass: low bit of the digit, digit width
fn shiftOf(p: u32) -> u32 { return select(select(0u, 10u, p == 1u), 21u, p == 0u); }
fn bitsOf(p: u32) -> u32 { return select(11u, 10u, p == 2u); }
`;

/** Selection state per (bin, channel, slot): the target rank, then (prefix, remaining rank). */
export const HZ_SEL_INIT = /* wgsl */ `${SEL_COMMON}
@group(0) @binding(0) var<storage, read> counts: array<u32>;
@group(0) @binding(1) var<storage, read_write> state: array<vec2<u32>>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let s = id.x;
  if (s >= ${SEL}u) { return; }
  let n = counts[s / 12u];
  let slot = s & 3u;
  let m = select(n - 1u, 0u, n == 0u);
  // ⌊q·(n−1)⌋ in integers (the CPU's f64 floor can land one lower when q·(n−1) is an integer, where
  // its interpolation weight is then ~1: the CPU side takes the next statistic for that case)
  let base = select(m * 9u / 100u, m / 100u, slot < 2u);
  let k = min(m, base + (slot & 1u));
  state[s] = vec2<u32>(0u, k);
}
`;

/** One radix pass: histogram the digit of every binned pixel whose higher bits match the prefix. */
export const HZ_HIST = /* wgsl */ `${SEL_COMMON}
@group(0) @binding(0) var<uniform> prm: S;
@group(0) @binding(1) var<storage, read> bins: array<i32>;
@group(0) @binding(2) var<storage, read> lin: array<f32>;
@group(0) @binding(3) var<storage, read> state: array<vec2<u32>>;
@group(0) @binding(4) var<storage, read_write> hist: array<atomic<u32>>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= prm.W * prm.H) { return; }
  let b = bins[i];
  if (b < 0) { return; }
  let p = prm.pass_;
  let sh = shiftOf(p);
  let mask = (1u << bitsOf(p)) - 1u;
  let hi = sh + bitsOf(p);
  for (var c = 0u; c < 3u; c++) {
    let v = bitcast<u32>(lin[3u * i + c]);
    let d = (v >> sh) & mask;
    let s0 = (u32(b) * 3u + c) * 4u;
    if (p == 0u) {
      atomicAdd(&hist[s0 * ${BUCKETS}u + d], 1u);
    } else {
      for (var k = 0u; k < 4u; k++) {
        if ((v >> hi) == state[s0 + k].x) { atomicAdd(&hist[(s0 + k) * ${BUCKETS}u + d], 1u); }
      }
    }
  }
}
`;

/**
 * Pick the bucket holding each selection's remaining rank; extend its prefix. One workgroup per
 * selection (dispatch SEL workgroups of 256): each invocation sums 8 (pass 2: 4) consecutive
 * buckets, a workgroup inclusive scan of those sums finds the one chunk that holds the
 * rank, and that invocation walks its few buckets exactly as the serial walk did. u32 adds only, so
 * the result is the serial walk's: the first d with cum(d) + hist(d) > rank, or (no such d, e.g. an
 * empty bin) d = nb with cum = the block's total, the digit then clamped to nb − 1.
 */
export const HZ_SCAN = /* wgsl */ `${SEL_COMMON}
@group(0) @binding(0) var<uniform> prm: S;
@group(0) @binding(1) var<storage, read> hist: array<u32>;
@group(0) @binding(2) var<storage, read_write> state: array<vec2<u32>>;
var<workgroup> part: array<u32, 256>;
var<workgroup> st0: vec2<u32>;
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_index) lid: u32) {
  let s = wg.x;
  let p = prm.pass_;
  let bits = bitsOf(p);
  let nb = 1u << bits;
  let per = nb >> 8u;
  let b0 = select(s, s & ~3u, p == 0u) * ${BUCKETS}u + lid * per;
  if (lid == 0u) { st0 = state[s]; }
  var loc = 0u;
  for (var k = 0u; k < per; k++) { loc += hist[b0 + k]; }
  part[lid] = loc;
  workgroupBarrier();
  for (var off = 1u; off < 256u; off <<= 1u) {
    var v = 0u;
    if (lid >= off) { v = part[lid - off]; }
    workgroupBarrier();
    part[lid] += v;
    workgroupBarrier();
  }
  let st = st0;
  let incl = part[lid];
  var excl = 0u;
  if (lid > 0u) { excl = part[lid - 1u]; }
  if (excl <= st.y && st.y < incl) {
    var cum = excl;
    var d = 0u;
    for (; d < per; d++) {
      let h = hist[b0 + d];
      if (cum + h > st.y) { break; }
      cum += h;
    }
    state[s] = vec2<u32>((st.x << bits) | (lid * per + d), st.y - cum);
  } else if (lid == 255u && incl <= st.y) {
    state[s] = vec2<u32>((st.x << bits) | (nb - 1u), st.y - incl);
  }
}
`;

/**
 * HZ_SCAN with the workgroup inclusive scan done by subgroupInclusiveAdd (needs the "subgroups"
 * feature): each subgroup scans its lanes' sums, its last lane posts the subgroup total, and a lane
 * adds the totals of the subgroups before its own. u32 adds are associative, so incl / excl are
 * bit-identical to HZ_SCAN's. Rows are indexed by local_invocation_index / subgroup_size, which
 * assumes subgroups are contiguous runs of it (true for 1-D workgroups on Metal / Vulkan / D3D, not
 * guaranteed by WGSL): every subgroup checks that, and when any fails the whole workgroup (uniformly)
 * redoes the scan with HZ_SCAN's shared-memory steps, so no re-run is needed. Needs subgroup_size >= 4
 * (else the check fails too). The subgroup ops run in uniform control flow.
 */
export const HZ_SCAN_SG = /* wgsl */ `enable subgroups;
${SEL_COMMON}
@group(0) @binding(0) var<uniform> prm: S;
@group(0) @binding(1) var<storage, read> hist: array<u32>;
@group(0) @binding(2) var<storage, read_write> state: array<vec2<u32>>;
var<workgroup> part: array<u32, 256>;
var<workgroup> sgTotal: array<u32, 64>;
var<workgroup> layoutBad: atomic<u32>;
var<workgroup> layoutFlag: u32;
var<workgroup> st0: vec2<u32>;
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_index) lid: u32,
        @builtin(subgroup_invocation_id) sid: u32, @builtin(subgroup_size) ssz: u32) {
  let s = wg.x;
  let p = prm.pass_;
  let bits = bitsOf(p);
  let nb = 1u << bits;
  let per = nb >> 8u;
  let b0 = select(s, s & ~3u, p == 0u) * ${BUCKETS}u + lid * per;
  if (lid == 0u) { st0 = state[s]; }
  var loc = 0u;
  for (var k = 0u; k < per; k++) { loc += hist[b0 + k]; }
  // subgroup s covers lanes first .. first + ssz - 1 of the workgroup, first a multiple of ssz
  let first = subgroupBroadcastFirst(lid);
  let ok = subgroupAll(ssz >= 4u && lid == first + sid && first % ssz == 0u);
  let inSub = subgroupInclusiveAdd(loc);
  let row = lid / ssz;
  if (sid == ssz - 1u) { sgTotal[row] = inSub; }
  if (!ok) { atomicStore(&layoutBad, 1u); }
  workgroupBarrier();
  if (lid == 0u) { layoutFlag = atomicLoad(&layoutBad); }
  // workgroupUniformLoad has its own barrier, so the branch below is uniform control flow
  var incl = 0u;
  if (workgroupUniformLoad(&layoutFlag) == 0u) {
    var before = 0u;
    for (var r = 0u; r < row; r++) { before += sgTotal[r]; }
    incl = inSub + before;
  } else {
    part[lid] = loc;
    workgroupBarrier();
    for (var off = 1u; off < 256u; off <<= 1u) {
      var v = 0u;
      if (lid >= off) { v = part[lid - off]; }
      workgroupBarrier();
      part[lid] += v;
      workgroupBarrier();
    }
    incl = part[lid];
  }
  let st = st0;
  let excl = incl - loc;
  if (excl <= st.y && st.y < incl) {
    var cum = excl;
    var d = 0u;
    for (; d < per; d++) {
      let h = hist[b0 + d];
      if (cum + h > st.y) { break; }
      cum += h;
    }
    state[s] = vec2<u32>((st.x << bits) | (lid * per + d), st.y - cum);
  } else if (lid == 255u && incl <= st.y) {
    state[s] = vec2<u32>((st.x << bits) | (nb - 1u), st.y - incl);
  }
}
`;

/** Representative lists: one per (bin, channel), L = bin·3 + channel. */
export const LISTS = NBINS * 3;
/** Pixels per compaction block (one invocation each, walked in pixel order). */
export const BLOCK = 128;
/** The key of an element in no list (above every list id, within the sort's 7 key bits). */
export const LIST_NONE = 127;
/** Radix sort key bits of the list keys: ids 0..71 and LIST_NONE. */
export const LIST_KEY_BITS = 7;

/** Elements of the lists' key / value arrays: (pixel i, channel c) is element e = 3i + c. */
const LIST_COMMON = /* wgsl */ `
struct C { N: u32, nBlk: u32, K: u32, pad: u32 };
`;

/**
 * The 72-list compaction's key kernel (one invocation per element e = 3i + c, @workgroup_size(256)):
 * keys[e] = L = bin·3 + c when pixel i is binned and its channel lies in list L's [lo, hi] (the order
 * statistics of slots 0 and 3, i.e. ranks ⌊0.01(n−1)⌋ and ⌊0.09(n−1)⌋ + 1, which bracket the CPU's
 * interpolated percentiles v0 ≤ v1; f32 bits, lin ≥ 0 so they order as u32), else ${LIST_NONE}; vals[e] = e.
 * A stable core GPUSort by key then lays the lists out list-major, pixel order within a list (e
 * ascending within one channel = i ascending).
 */
export const HZ_LIST_KEY = /* wgsl */ `${LIST_COMMON}
@group(0) @binding(0) var<uniform> prm: C;
@group(0) @binding(1) var<storage, read> bins: array<i32>;
@group(0) @binding(2) var<storage, read> lin: array<f32>;
@group(0) @binding(3) var<storage, read> state: array<vec2<u32>>;
@group(0) @binding(4) var<storage, read_write> keys: array<u32>;
@group(0) @binding(5) var<storage, read_write> vals: array<u32>;
var<workgroup> thr: array<vec2<u32>, ${NBINS * 3}>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3<u32>, @builtin(local_invocation_index) lid: u32) {
  for (var L = lid; L < ${NBINS * 3}u; L += 256u) { thr[L] = vec2<u32>(state[4u * L].x, state[4u * L + 3u].x); }
  workgroupBarrier();
  let e = id.x;
  if (e >= 3u * prm.N) { return; }
  let i = e / 3u;
  let c = e - i * 3u;
  let b = bins[i];
  var key = ${LIST_NONE}u;
  if (b >= 0) {
    let L = u32(b) * 3u + c;
    let v = bitcast<u32>(lin[e]);
    if (v >= thr[L].x && v <= thr[L].y) { key = L; }
  }
  keys[e] = key;
  vals[e] = e;
}
`;

/** The lists' pixel indices from the sort's element order: outIdx[k] = sortedVals[k] / 3. @workgroup_size(256). */
export const HZ_LIST_INDEX = /* wgsl */ `${LIST_COMMON}
@group(0) @binding(0) var<uniform> prm: C;
@group(0) @binding(1) var<storage, read> sortedVals: array<u32>;
@group(0) @binding(2) var<storage, read_write> outIdx: array<u32>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let k = id.x;
  if (k >= 3u * prm.N) { return; }
  outIdx[k] = sortedVals[k] / 3u;
}
`;

/**
 * The physical grid: cell (hk, a, b) → the robust SSE of evalPhys (kR, β_M, H_M index hk) plus its
 * priors. @workgroup_size(64): 5 550 cells, each ~1–2 k exp()s.
 */
export const HZ_GRID = /* wgsl */ `
struct G { S: u32, NH: u32, NA: u32, NB: u32,
  air: vec4<f32>, betaR0: vec4<f32>,
  lam: f32, jBar: f32, priorK: f32, pad: f32 };
@group(0) @binding(0) var<uniform> prm: G;
@group(0) @binding(1) var<storage, read> reps: array<f32>;
@group(0) @binding(2) var<storage, read> repOff: array<vec2<u32>>;
@group(0) @binding(3) var<storage, read> Iw: array<vec2<f32>>;
@group(0) @binding(4) var<storage, read> hmPrior: array<f32>;
@group(0) @binding(5) var<storage, read_write> err: array<f32>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let cells = prm.NH * prm.NA * prm.NB;
  let cell = id.x;
  if (cell >= cells) { return; }
  let hk = cell / (prm.NA * prm.NB);
  let rem = cell - hk * prm.NA * prm.NB;
  let a = rem / prm.NB;
  let b = rem - a * prm.NB;
  let kR = exp(log(0.25) + (f32(a) / f32(prm.NA - 1u)) * log(40.0 / 0.25));
  let bM = exp(log(1e-7) + (f32(b) / f32(prm.NB - 1u)) * log(3e-2 / 1e-7));
  let stride = 1u + prm.NH;
  var e = 0.0;
  var t: array<f32, ${NBINS}>;
  for (var c = 0u; c < 3u; c++) {
    let bR = kR * prm.betaR0[c];
    let A = prm.air[c];
    var num = 0.0; var den = 0.0;
    for (var s = 0u; s < prm.S; s++) {
      let ro = repOff[c * prm.S + s];
      var acc = 0.0;
      for (var k = 0u; k < ro.y; k++) {
        let o = ro.x + k * stride;
        acc += exp(-bR * reps[o] - bM * reps[o + 1u + hk]);
      }
      let tt = acc / f32(ro.y);
      t[s] = tt;
      let iw = Iw[c * prm.S + s];
      num += iw.y * tt * (iw.x - A * (1.0 - tt));
      den += iw.y * tt * tt;
    }
    if (prm.jBar >= 0.0) { num += prm.lam * prm.jBar; den += prm.lam; }
    let J = clamp(select(0.0, num / den, den > 1e-12), 0.0, A);
    for (var s = 0u; s < prm.S; s++) {
      let iw = Iw[c * prm.S + s];
      let r = iw.x - (J * t[s] + A * (1.0 - t[s]));
      e += iw.y * r * r;
    }
  }
  let lk = log(kR);
  err[cell] = e + prm.priorK * (lk * lk * 0.5 + hmPrior[hk]);
}
`;
