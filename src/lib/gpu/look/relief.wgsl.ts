// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// WGSL for the GPU relief field (twin of look/relief/field.ts: castShadow, skyView,
// curvatureAndNormal). Same line sweeps, same hull pointers, same byte rounding; f32 instead of the
// CPU's f64 temporaries, so a byte can differ by 1 where a value sits on a rounding edge (the
// Dawn check scripts/gpu/relief-gradient-dawn.ts prints the byte-diff histogram against the CPU twin).
// The normal's gradient (central differences over the inner ring radius ra) is luma's
// GPUFiniteDifference2D on ra² phase planes (RELIEF_PHASE de-interleaves H; relief-graph.ts); PACK
// reads the gradient from them. Shadow and sky view stay custom line sweeps.
// The shadow bytes are packed four per u32 (little-endian, texel q in byte q & 3 of word q >> 2):
// RELIEF_SHADOW ORs them into a zeroed buffer, RELIEF_PACK unpacks them.

const PARAMS = /* wgsl */ `
struct P {
  res: u32, resH: u32, sa: u32, sb: u32,
  s: i32, sFloor: i32, sFrac: f32, drop: f32,
  w: f32, bias: f32, shadowConst: i32, pxH: f32,
  ra: i32, rb: i32, da: i32, db: i32,
  ka: f32, kb: f32, g: f32, svfR: f32,
};
const HOLE: f32 = -1.0e6;
const NEG: f32 = -3.0e38;
`;

/**
 * Cast shadow: the occluder surface propagated one row (along the sun's major axis) at a time,
 * rows strictly in order. One workgroup; the previous row's max(H, O) lives in workgroup memory,
 * double-buffered so a single barrier per row suffices.
 * @workgroup_size(256): res ≤ 2048 texels per row, 4–8 per invocation. `shadow` must be zeroed.
 */
export const RELIEF_SHADOW = /* wgsl */ `${PARAMS}
@group(0) @binding(0) var<uniform> prm: P;
@group(0) @binding(1) var<storage, read> H: array<f32>;
@group(0) @binding(2) var<storage, read_write> shadow: array<atomic<u32>>;
var<workgroup> rows: array<f32, 4096>;
@compute @workgroup_size(256)
fn main(@builtin(local_invocation_index) lid: u32) {
  let res = i32(prm.res);
  for (var n = 0; n < res; n++) {
    let a = select(n, res - 1 - n, prm.s > 0);
    let cur = u32(n & 1) * 2048u;
    let prv = 2048u - cur;
    for (var b = i32(lid); b < res; b += 256) {
      let q = u32(a) * prm.sa + u32(b) * prm.sb;
      var o = NEG;
      let b0 = b + prm.sFloor;
      if (n > 0 && b0 >= 0 && b0 + 1 < res) {
        let f = prm.sFrac;
        o = rows[prv + u32(b0)] * (1.0 - f) + rows[prv + u32(b0 + 1)] * f - prm.drop;
      }
      let h = H[q];
      rows[cur + u32(b)] = max(h, o);
      let t = clamp((h + prm.bias - o + prm.w) / (2.0 * prm.w), 0.0, 1.0);
      // neighbouring texels of one word belong to other invocations (or rows): OR the byte in
      atomicOr(&shadow[q >> 2u], u32(255.0 * (t * t * (3.0 - 2.0 * t)) + 0.5) << ((q & 3u) * 8u));
    }
    workgroupBarrier();
  }
}
`;

/** Half-resolution heights (2×2 means, HOLE if any is a hole). @workgroup_size(256), 1-D. */
export const RELIEF_DOWN = /* wgsl */ `${PARAMS}
@group(0) @binding(0) var<uniform> prm: P;
@group(0) @binding(1) var<storage, read> Hf: array<f32>;
@group(0) @binding(2) var<storage, read_write> Hh: array<f32>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let r = prm.resH;
  if (id.x >= r * r) { return; }
  let j = id.x / r;
  let i = id.x - j * r;
  let rf = prm.res;
  let q = 2u * j * rf + 2u * i;
  let a = Hf[q]; let b = Hf[q + 1u]; let c = Hf[q + rf]; let d = Hf[q + rf + 1u];
  Hh[id.x] = select(0.25 * (a + b + c + d), HOLE, min(min(a, b), min(c, d)) <= HOLE);
}
`;

/**
 * Sky view, one invocation per sweep line (the texels p, p − d, p − 2d, … starting where p + d
 * leaves the grid), all 8 azimuths in one dispatch (y = direction), each with its own hull and
 * per-direction output so the 8 terms are summed later in the CPU's order.
 * @workgroup_size(64): only 2·resH lines per direction, long serial walks; small groups spread them.
 */
export const RELIEF_SVF = /* wgsl */ `${PARAMS}
@group(0) @binding(0) var<uniform> prm: P;
@group(0) @binding(1) var<storage, read> Hh: array<f32>;
@group(0) @binding(2) var<storage, read_write> hull: array<i32>;
@group(0) @binding(3) var<storage, read_write> acc8: array<f32>;
var<private> DI: array<i32, 8> = array<i32, 8>(1, -1, 0, 0, 1, 1, -1, -1);
var<private> DJ: array<i32, 8> = array<i32, 8>(0, 0, 1, -1, 1, -1, 1, -1);
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let r = i32(prm.resH);
  let dir = id.y;
  let di = DI[dir];
  let dj = DJ[dir];
  let t = i32(id.x);
  let iE = select(0, r - 1, di > 0);
  let jE = select(0, r - 1, dj > 0);
  var i: i32;
  var j: i32;
  if (t < r) {
    if (di == 0) { return; }
    i = iE; j = t;
  } else {
    let tt = t - r;
    if (tt >= r || dj == 0) { return; }
    if (di != 0 && tt == iE) { return; }
    i = tt; j = jE;
  }
  let N = r * r;
  let base = i32(dir) * N;
  let stride = dj * r + di;
  let L = prm.pxH * select(1.0, sqrt(2.0), di != 0 && dj != 0);
  var p = j * r + i;
  hull[base + p] = -1;
  acc8[base + p] = 0.0;
  loop {
    i -= di; j -= dj;
    if (i < 0 || j < 0 || i >= r || j >= r) { break; }
    p = j * r + i;
    let h0 = Hh[p];
    var best = p + stride;
    var bh = Hh[best] - h0;
    var bd = L;
    var q = hull[base + best];
    loop {
      if (q < 0) { break; }
      let d = f32((q - p) / stride) * L;
      if (d > prm.svfR) { break; }
      let dh = Hh[q] - h0;
      if (dh * bd <= bh * d) { break; }
      best = q; bh = dh; bd = d;
      q = hull[base + q];
    }
    hull[base + p] = best;
    acc8[base + p] = select(0.0, bh / sqrt(bh * bh + bd * bd), bh > 0.0);
  }
}
`;

/** Σ of the 8 directions in the CPU's order (f32 adds, as the CPU's Float32Array acc). */
export const RELIEF_SUM = /* wgsl */ `${PARAMS}
@group(0) @binding(0) var<uniform> prm: P;
@group(0) @binding(1) var<storage, read> acc8: array<f32>;
@group(0) @binding(2) var<storage, read_write> acc: array<f32>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let N = prm.resH * prm.resH;
  if (id.x >= N) { return; }
  var a = 0.0;
  for (var k = 0u; k < 8u; k++) { a += acc8[k * N + id.x]; }
  acc[id.x] = a;
}
`;

/**
 * De-interleave H into ra² phase planes of wp² floats (wp = ceil(res / ra)): plane p = py · ra + px
 * holds H[ra · j + py][ra · i + px] at (j, i), coordinates clamped to the grid (clamped samples only
 * reach texels outside PACK's interior, where the gradient is not used). A central difference of one
 * plane at spacing ra · px is then H's central difference over ±ra texels.
 * @workgroup_size(256), 1-D over ra² · wp² elements.
 */
export const RELIEF_PHASE = /* wgsl */ `${PARAMS}
@group(0) @binding(0) var<uniform> prm: P;
@group(0) @binding(1) var<storage, read> H: array<f32>;
@group(0) @binding(2) var<storage, read_write> phase: array<f32>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let ra = u32(prm.ra);
  let wp = (prm.res + ra - 1u) / ra;
  let plane = wp * wp;
  if (id.x >= ra * ra * plane) { return; }
  let p = id.x / plane;
  let k = id.x - p * plane;
  let j = min(ra * (k / wp) + p / ra, prm.res - 1u);
  let i = min(ra * (k % wp) + p % ra, prm.res - 1u);
  phase[id.x] = H[j * prm.res + i];
}
`;

/**
 * Per full-res texel: R shadow, G sky view (bilinear from half res), B curvature, A coverage, and
 * the generalised normal, packed RGBA8 into u32 (little-endian = the CPU's byte order).
 * @workgroup_size(16, 16): 2-D neighbourhood reads (rings up to rb texels) stay cache-local.
 */
export const RELIEF_PACK = /* wgsl */ `${PARAMS}
@group(0) @binding(0) var<uniform> prm: P;
@group(0) @binding(1) var<storage, read> H: array<f32>;
@group(0) @binding(2) var<storage, read> shadow: array<u32>;
@group(0) @binding(3) var<storage, read> acc: array<f32>;
// GPUFiniteDifference2D's gradient of the phase planes: plane p = (j % ra) · ra + i % ra, at
// (j / ra, i / ra), planes of wp² vec2 back to back
@group(0) @binding(4) var<storage, read> grad: array<vec2<f32>>;
@group(0) @binding(5) var<storage, read_write> field: array<u32>;
@group(0) @binding(6) var<storage, read_write> gen: array<u32>;
fn at(i: i32, j: i32) -> f32 { return H[u32(j) * prm.res + u32(i)]; }
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let res = i32(prm.res);
  let i = i32(id.x);
  let j = i32(id.y);
  if (i >= res || j >= res) { return; }
  let q = u32(j) * prm.res + u32(i);
  var R = 0u;
  if (prm.shadowConst >= 0) { R = u32(prm.shadowConst); } else { R = (shadow[q >> 2u] >> ((q & 3u) * 8u)) & 255u; }
  // sky view: half-res centres at full-res 2i + 0.5, clamped at the borders
  let rh = i32(prm.resH);
  let v = clamp((f32(j) - 0.5) / 2.0, 0.0, f32(rh - 1));
  let j0 = min(rh - 2, i32(v));
  let fv = v - f32(j0);
  let u = clamp((f32(i) - 0.5) / 2.0, 0.0, f32(rh - 1));
  let i0 = min(rh - 2, i32(u));
  let fu = u - f32(i0);
  let k0 = u32(j0 * rh + i0);
  let a = acc[k0] + (acc[k0 + 1u] - acc[k0]) * fu;
  let b = acc[k0 + u32(rh)] + (acc[k0 + u32(rh) + 1u] - acc[k0 + u32(rh)]) * fu;
  let G = u32(max(0.0, 255.5 - (a + (b - a) * fv) * (255.0 / 8.0)));
  let h0 = H[q];
  var B = 128u;
  let A = select(0u, 255u, h0 > HOLE);
  var gn = 0u;
  let rb = prm.rb;
  if (h0 > HOLE && i >= rb && j >= rb && i < res - rb && j < res - rb) {
    let ra = prm.ra; let da = prm.da; let db = prm.db;
    let xp = at(i + ra, j); let xm = at(i - ra, j);
    let yp = at(i, j + ra); let ym = at(i, j - ra);
    var ringA = array<f32, 8>(xp, xm, yp, ym,
      at(i + da, j + da), at(i - da, j - da), at(i - da, j + da), at(i + da, j - da));
    var ringB = array<f32, 8>(at(i + rb, j), at(i - rb, j), at(i, j + rb), at(i, j - rb),
      at(i + db, j + db), at(i - db, j - db), at(i - db, j + db), at(i + db, j - db));
    var sa = 0.0; var sb = 0.0; var lo = h0;
    for (var k = 0; k < 8; k++) {
      // relative to h0: 8·h0 − Σ without the f32 cancellation of two ~24 km sums
      sa += ringA[k] - h0; sb += ringB[k] - h0;
      lo = min(lo, min(ringA[k], ringB[k]));
    }
    if (lo > HOLE) {
      let x = clamp(-prm.ka * sa - prm.kb * sb, -3.0, 3.0);
      B = u32(127.5 + (127.5 * x * (27.0 + x * x)) / (27.0 + 9.0 * x * x) + 0.5);
      let ur = u32(ra);
      let wp = (prm.res + ur - 1u) / ur;
      let gg = grad[((u32(j) % ur) * ur + u32(i) % ur) * wp * wp + (u32(j) / ur) * wp + u32(i) / ur];
      // the normal leans away from the slope: minus the central difference (xp - xm, yp - ym) / (2 ra px)
      let gx = -gg.x;
      let gy = -gg.y;
      let l = 0.5 / sqrt(gx * gx + gy * gy + 1.0);
      gn = u32(255.0 * (0.5 + gx * l) + 0.5) | (u32(255.0 * (0.5 + gy * l) + 0.5) << 8u) | (255u << 24u);
    }
  }
  field[q] = R | (G << 8u) | (B << 16u) | (A << 24u);
  gen[q] = gn;
}
`;
