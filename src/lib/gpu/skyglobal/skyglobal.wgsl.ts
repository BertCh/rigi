// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// WGSL for the T6 skyline global search grid (twin: ./cpu.ts SkyGlobal.cellScore / gridCpu, itself
// a port of tools/matcher/stage1/skyglobal.py SkyGlobal.grid).
//
// CELLS: one invocation per (yaw, combo) cell scores the projected 360° max-elevation profile on the
// coarse score map, like the CPU, but in float32. Besides its point estimate (`mid`) it returns a
// certified interval [lo, hi] that contains the CPU's float64 value:
//  - a sample whose pixel coordinate lies within `eps` px of a pixel edge contributes the min / max
//    of both candidate pixels (f32 projection error is ~3e-4 px at worst; eps defaults to 5e-3);
//  - a sample within `eps` px of the u / v validity bounds (or |z − 0.1| ≤ zeps) may or may not be
//    counted: it contributes [min(0, Smin), max(0, Smax)] to the sum and 0..m to the count, and the
//    interval takes the worst case over the count (the coverage factor makes the score
//    x · min(1 / (n · covDen), 1 / cnt), monotone in cnt);
//  - the float32 sum error (GPU sequential and numpy pairwise) is bounded by (na + 8) · 2⁻²³ · Σ|v|.
// REDUCE: per yaw, the max of `lo` over combos, the argmax of `mid` (first index on ties) and the
// first combo whose score is a certain exact 0.
// FLAGS: marks every cell with hi ≥ maxLo(yaw) (of the certain zeros only the first); luma's
// GPUCompaction (./graph.ts) then compacts the marked cell indices, in ascending order, into the
// candidate list. The CPU re-scores exactly those cells in float64 (cpu.ts cellScore), which yields
// the CPU grid's per-yaw winner exactly.
//
// RESCORE / PICK (optional, GridGpuOptions.rescore "gpu"): the candidate re-score on the GPU. RESCORE
// recomputes each candidate cell's point estimate (the same expressions as CELLS' `mid`, float32)
// and keeps the per-yaw max through an order-preserving u32 key (atomicMax into bestKey); PICK then
// takes, among the candidates whose key equals the yaw's best, the smallest combo (gridCpu's "first
// max in combo order"), as an atomicMax of the complemented combo (the clear node can only write 0).
//
// @workgroup_size(64) for CELLS: 64 consecutive yaws of one combo per workgroup, so neighbouring
// invocations read neighbouring profile bins and the same combo constants. REDUCE uses 256
// invocations per yaw (one workgroup each) striding over the ≤ ~4000 combos. FLAGS is 256 × 1 over the flat cell index.
// REDUCE_SG_WGSL is REDUCE with subgroup operations (when the device has "subgroups"): the same
// max / min / (max mid, first index) results, since each is order-independent.

const HEADER = /* wgsl */ `
struct U {
  w: u32, h: u32, n: u32, sy: u32,
  nYaw: u32, nCombo: u32, cntReq: u32, cap: u32,
  eps: f32, zeps: f32, smin: f32, smax: f32,
};
`;

/** Per combo: fy fz rx ry rz ux uy uz ta t covDen vi (12 f32). */
export const COMBO_FLOATS = 12;

export const CELLS_WGSL = /* wgsl */ `${HEADER}
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read> S: array<f32>;
@group(0) @binding(2) var<storage, read> prof: array<vec2<f32>>;
@group(0) @binding(3) var<storage, read> alpha: array<vec2<f32>>;
@group(0) @binding(4) var<storage, read> vfs: array<u32>;
@group(0) @binding(5) var<storage, read> combos: array<f32>;
@group(0) @binding(6) var<storage, read_write> cells: array<vec4<f32>>;

fn px(x: i32, y: i32) -> f32 {
  let xx = clamp(x, 0, i32(u.w) - 1);
  let yy = clamp(y, 0, i32(u.h) - 1);
  return S[u32(yy) * u.w + u32(xx)];
}
fn alt(i: i32, f: f32) -> i32 {
  if (f < u.eps) { return i - 1; }
  if (f > 1.0 - u.eps) { return i + 1; }
  return i;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let iy = gid.x;
  let ci = gid.y;
  if (iy >= u.nYaw || ci >= u.nCombo) { return; }
  let b = ci * 12u;
  let fy = combos[b]; let fz = combos[b + 1u];
  let rx = combos[b + 2u]; let ry = combos[b + 3u]; let rz = combos[b + 4u];
  let ux = combos[b + 5u]; let uy = combos[b + 6u]; let uz = combos[b + 7u];
  let ta = combos[b + 8u]; let t = combos[b + 9u]; let covDen = combos[b + 10u];
  let vi = u32(combos[b + 11u]);
  let off = vfs[vi * 2u];
  let hb = vfs[vi * 2u + 1u];
  let na = 2u * hb + 1u;
  let n = i32(u.n);
  var k = (i32(iy * u.sy) - i32(hb)) % n;
  if (k < 0) { k += n; }
  let fw = f32(u.w); let fh = f32(u.h);
  let x0 = 0.01 * fw; let x1 = 0.99 * fw;
  let y0 = 0.01 * fh; let y1 = 0.99 * fh;
  let eps = u.eps;
  var midSum = 0.0; var midCnt = 0u;
  var loSum = 0.0; var hiSum = 0.0; var sAbs = 0.0; var cnt = 0u;
  var loAmb = 0.0; var hiAmb = 0.0; var nAmb = 0u;
  for (var j = 0u; j < na; j++) {
    let a = alpha[off + j];
    let p = prof[u32(k)];
    k += 1;
    if (k == n) { k = 0; }
    let dx = a.x * p.y;
    let dy = a.y * p.y;
    let dz = p.x;
    let z = dy * fy + dz * fz;
    let zs = select(1.0, z, z > 0.1);
    let X = (0.5 + (dx * rx + dy * ry + dz * rz) / zs / ta * 0.5) * fw;
    let Y = (0.5 - (dx * ux + dy * uy + dz * uz) / zs / t * 0.5) * fh;
    let inMid = z > 0.1 && X >= x0 && X <= x1 && Y >= y0 && Y <= y1;
    let xi = i32(floor(X));
    let yi = i32(floor(Y));
    let v = px(xi, yi);
    if (inMid) { midSum += v; midCnt += 1u; }
    let amb = abs(z - 0.1) <= u.zeps || abs(X - x0) <= eps || abs(X - x1) <= eps ||
      abs(Y - y0) <= eps || abs(Y - y1) <= eps;
    if (amb) {
      loAmb += min(0.0, u.smin); hiAmb += max(0.0, u.smax); nAmb += 1u;
      sAbs += max(abs(u.smin), abs(u.smax));
      continue;
    }
    if (!inMid) { continue; }
    let xa = alt(xi, X - floor(X));
    let ya = alt(yi, Y - floor(Y));
    var mn = v; var mx = v;
    if (xa != xi || ya != yi) {
      let v2 = px(xa, yi); let v3 = px(xi, ya); let v4 = px(xa, ya);
      mn = min(min(v, v2), min(v3, v4));
      mx = max(max(v, v2), max(v3, v4));
    }
    loSum += mn; hiSum += mx; sAbs += max(abs(mn), abs(mx)); cnt += 1u;
  }
  let nc = f32(u.n) * covDen;
  var mid = 0.0;
  if (midCnt >= u.cntReq) { mid = midSum * min(1.0 / nc, 1.0 / f32(midCnt)); }
  var lo = 0.0; var hi = 0.0;
  // w = −1 marks a certain exact 0 (too few samples whatever the ambiguity): only the first one per
  // yaw can win, so FLAGS keeps just that one
  var tag = f32(nAmb);
  if (cnt + nAmb < u.cntReq) { tag = -1.0; }
  if (cnt + nAmb >= u.cntReq) {
    // g(c) = min(1 / (n·covDen), 1 / c): score = sum · g(cnt); g falls as c grows
    let g0 = min(1.0 / nc, 1.0 / f32(max(cnt, 1u)));
    let gm = min(1.0 / nc, 1.0 / f32(max(cnt + nAmb, 1u)));
    let xl = loSum + loAmb;
    let xh = hiSum + hiAmb;
    let margin = (f32(na) + 8.0) * 1.2e-7 * sAbs * g0 + 1e-6;
    let lv = select(xl * g0, xl * gm, xl >= 0.0);
    let hv = select(xh * gm, xh * g0, xh >= 0.0);
    lo = lv - margin - 2e-6 * abs(lv);
    hi = hv + margin + 2e-6 * abs(hv);
    if (cnt < u.cntReq) { lo = min(lo, 0.0); hi = max(hi, 0.0); }
  }
  cells[ci * u.nYaw + iy] = vec4<f32>(mid, lo, hi, tag);
}
`;

export const REDUCE_WGSL = /* wgsl */ `${HEADER}
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read> cells: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> red: array<vec4<f32>>;
var<workgroup> shLo: array<f32, 256>;
var<workgroup> shMid: array<f32, 256>;
var<workgroup> shArg: array<u32, 256>;
var<workgroup> shZero: array<u32, 256>;

@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_index) lid: u32) {
  let iy = wid.x;
  var mLo = -3.0e38; var mMid = -3.0e38; var mArg = 0xffffffffu; var zArg = 0xffffffffu;
  for (var c = lid; c < u.nCombo; c += 256u) {
    let e = cells[c * u.nYaw + iy];
    mLo = max(mLo, e.y);
    if (e.w < 0.0) { zArg = min(zArg, c); }
    if (e.x > mMid) { mMid = e.x; mArg = c; }
  }
  shLo[lid] = mLo; shMid[lid] = mMid; shArg[lid] = mArg; shZero[lid] = zArg;
  workgroupBarrier();
  for (var s = 128u; s > 0u; s >>= 1u) {
    if (lid < s) {
      shZero[lid] = min(shZero[lid], shZero[lid + s]);
      shLo[lid] = max(shLo[lid], shLo[lid + s]);
      let om = shMid[lid + s]; let oa = shArg[lid + s];
      if (om > shMid[lid] || (om == shMid[lid] && oa < shArg[lid])) { shMid[lid] = om; shArg[lid] = oa; }
    }
    workgroupBarrier();
  }
  if (lid == 0u) { red[iy] = vec4<f32>(shLo[0], shMid[0], bitcast<f32>(shArg[0]), bitcast<f32>(shZero[0])); }
}
`;

export const FLAGS_WGSL = /* wgsl */ `${HEADER}
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read> cells: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> red: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> vals: array<u32>;
@group(0) @binding(4) var<storage, read_write> flags: array<u32>;

// @workgroup_size(256), 1-D over the transients' capacity (2-D when that exceeds the dispatch limit,
// linearised here): vals[i] = i and flags[i] = 1 for every candidate cell, so luma's GPUCompaction
// returns the cell indices in ascending order. Both arrays are written in full (past nCells: 0).
@compute @workgroup_size(256)
fn main(
  @builtin(workgroup_id) wid: vec3<u32>,
  @builtin(num_workgroups) nwg: vec3<u32>,
  @builtin(local_invocation_index) lid: u32,
) {
  let i = (wid.y * nwg.x + wid.x) * 256u + lid;
  if (i >= arrayLength(&vals)) { return; }
  var keep = 0u;
  if (i < u.nYaw * u.nCombo) {
    let iy = i % u.nYaw;
    let ci = i / u.nYaw;
    let e = cells[i];
    let r = red[iy];
    if (e.z >= r.x && (e.w >= 0.0 || ci == bitcast<u32>(r.w))) { keep = 1u; }
  }
  vals[i] = i;
  flags[i] = keep;
}
`;

// REDUCE with subgroup ops: each subgroup folds its lanes with subgroupMax / subgroupMin, one lane
// per subgroup appends that partial to workgroup memory (slot from an atomic counter, so nothing is
// assumed about how invocations map to subgroups), and invocation 0 folds the ≤ 64 partials. The
// argmax is (max mid, then the smallest combo among the lanes holding it), exactly REDUCE's
// tie-break, and max / min are exact in any order, so red[] is identical to REDUCE's.
export const REDUCE_SG_WGSL = /* wgsl */ `enable subgroups;
${HEADER}
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read> cells: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> red: array<vec4<f32>>;
// one slot per subgroup: 256 invocations / the minimum subgroup size (WebGPU guarantees ≥ 4) = 64
var<workgroup> shLo: array<f32, 64>;
var<workgroup> shMid: array<f32, 64>;
var<workgroup> shArg: array<u32, 64>;
var<workgroup> shZero: array<u32, 64>;
var<workgroup> nSub: atomic<u32>;

@compute @workgroup_size(256)
fn main(
  @builtin(workgroup_id) wid: vec3<u32>,
  @builtin(local_invocation_index) lid: u32,
  @builtin(subgroup_invocation_id) sid: u32,
) {
  let iy = wid.x;
  if (lid == 0u) { atomicStore(&nSub, 0u); }
  var mLo = -3.0e38; var mMid = -3.0e38; var mArg = 0xffffffffu; var zArg = 0xffffffffu;
  for (var c = lid; c < u.nCombo; c += 256u) {
    let e = cells[c * u.nYaw + iy];
    mLo = max(mLo, e.y);
    if (e.w < 0.0) { zArg = min(zArg, c); }
    if (e.x > mMid) { mMid = e.x; mArg = c; }
  }
  workgroupBarrier();
  let sLo = subgroupMax(mLo);
  let sZero = subgroupMin(zArg);
  let sMid = subgroupMax(mMid);
  let sArg = subgroupMin(select(0xffffffffu, mArg, mMid == sMid));
  if (sid == 0u) {
    let s = atomicAdd(&nSub, 1u);
    shLo[s] = sLo; shMid[s] = sMid; shArg[s] = sArg; shZero[s] = sZero;
  }
  workgroupBarrier();
  if (lid == 0u) {
    let n = atomicLoad(&nSub);
    var rLo = shLo[0]; var rMid = shMid[0]; var rArg = shArg[0]; var rZero = shZero[0];
    for (var s = 1u; s < n; s++) {
      rZero = min(rZero, shZero[s]);
      rLo = max(rLo, shLo[s]);
      let om = shMid[s]; let oa = shArg[s];
      if (om > rMid || (om == rMid && oa < rArg)) { rMid = om; rArg = oa; }
    }
    red[iy] = vec4<f32>(rLo, rMid, bitcast<f32>(rArg), bitcast<f32>(rZero));
  }
}
`;

// Order-preserving float32 -> u32 key (bigger float = bigger key; -0 folded into +0 so ties match
// the CPU's ==). Key 0 is below every real key (it would be a negative NaN): "no candidate yet".
const KEY_FN = /* wgsl */ `
fn sortKey(f: f32) -> u32 {
  let b = bitcast<u32>(select(f, 0.0, f == 0.0));
  return select(b | 0x80000000u, ~b, (b & 0x80000000u) != 0u);
}
`;

/** RESCORE: one invocation per candidate slot; score[i] = f32 point estimate, bestKey[iy] = max key. */
export const RESCORE_WGSL = /* wgsl */ `${HEADER}${KEY_FN}
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read> S: array<f32>;
@group(0) @binding(2) var<storage, read> prof: array<vec2<f32>>;
@group(0) @binding(3) var<storage, read> alpha: array<vec2<f32>>;
@group(0) @binding(4) var<storage, read> vfs: array<u32>;
@group(0) @binding(5) var<storage, read> combos: array<f32>;
@group(0) @binding(6) var<storage, read> list: array<u32>;
@group(0) @binding(7) var<storage, read_write> score: array<f32>;
@group(0) @binding(8) var<storage, read_write> bestKey: array<atomic<u32>>;

fn px(x: i32, y: i32) -> f32 {
  let xx = clamp(x, 0, i32(u.w) - 1);
  let yy = clamp(y, 0, i32(u.h) - 1);
  return S[u32(yy) * u.w + u32(xx)];
}

// CELLS' point estimate (midSum / midCnt branch) for cell (iy, ci), expression for expression
fn cellMid(iy: u32, ci: u32) -> f32 {
  let b = ci * 12u;
  let fy = combos[b]; let fz = combos[b + 1u];
  let rx = combos[b + 2u]; let ry = combos[b + 3u]; let rz = combos[b + 4u];
  let ux = combos[b + 5u]; let uy = combos[b + 6u]; let uz = combos[b + 7u];
  let ta = combos[b + 8u]; let t = combos[b + 9u]; let covDen = combos[b + 10u];
  let vi = u32(combos[b + 11u]);
  let off = vfs[vi * 2u];
  let hb = vfs[vi * 2u + 1u];
  let na = 2u * hb + 1u;
  let n = i32(u.n);
  var k = (i32(iy * u.sy) - i32(hb)) % n;
  if (k < 0) { k += n; }
  let fw = f32(u.w); let fh = f32(u.h);
  let x0 = 0.01 * fw; let x1 = 0.99 * fw;
  let y0 = 0.01 * fh; let y1 = 0.99 * fh;
  var midSum = 0.0; var midCnt = 0u;
  for (var j = 0u; j < na; j++) {
    let a = alpha[off + j];
    let p = prof[u32(k)];
    k += 1;
    if (k == n) { k = 0; }
    let dx = a.x * p.y;
    let dy = a.y * p.y;
    let dz = p.x;
    let z = dy * fy + dz * fz;
    let zs = select(1.0, z, z > 0.1);
    let X = (0.5 + (dx * rx + dy * ry + dz * rz) / zs / ta * 0.5) * fw;
    let Y = (0.5 - (dx * ux + dy * uy + dz * uz) / zs / t * 0.5) * fh;
    let inMid = z > 0.1 && X >= x0 && X <= x1 && Y >= y0 && Y <= y1;
    if (inMid) { midSum += px(i32(floor(X)), i32(floor(Y))); midCnt += 1u; }
  }
  let nc = f32(u.n) * covDen;
  var mid = 0.0;
  if (midCnt >= u.cntReq) { mid = midSum * min(1.0 / nc, 1.0 / f32(midCnt)); }
  return mid;
}

// @workgroup_size(256), 1-D over u.cap (2-D past the dispatch limit, linearised here)
@compute @workgroup_size(256)
fn main(
  @builtin(workgroup_id) wid: vec3<u32>,
  @builtin(num_workgroups) nwg: vec3<u32>,
  @builtin(local_invocation_index) lid: u32,
) {
  let i = (wid.y * nwg.x + wid.x) * 256u + lid;
  if (i >= u.cap || i >= list[0]) { return; }
  let c = list[1u + i];
  let iy = c % u.nYaw;
  let m = cellMid(iy, c / u.nYaw);
  score[i] = m;
  atomicMax(&bestKey[iy], sortKey(m));
}
`;

/** PICK: per candidate whose key equals its yaw's best, argOut[iy] = max(~combo) (= the first combo). */
export const PICK_WGSL = /* wgsl */ `${HEADER}${KEY_FN}
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read> list: array<u32>;
@group(0) @binding(2) var<storage, read> score: array<f32>;
@group(0) @binding(3) var<storage, read_write> bestKey: array<atomic<u32>>;
@group(0) @binding(4) var<storage, read_write> argOut: array<atomic<u32>>;

@compute @workgroup_size(256)
fn main(
  @builtin(workgroup_id) wid: vec3<u32>,
  @builtin(num_workgroups) nwg: vec3<u32>,
  @builtin(local_invocation_index) lid: u32,
) {
  let i = (wid.y * nwg.x + wid.x) * 256u + lid;
  if (i >= u.cap || i >= list[0]) { return; }
  let c = list[1u + i];
  let iy = c % u.nYaw;
  if (sortKey(score[i]) == atomicLoad(&bestKey[iy])) {
    atomicMax(&argOut[iy], ~(c / u.nYaw));
  }
}
`;
