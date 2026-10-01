// WGSL for the GPU sky prep: the photo's RGBA bytes at working size → the model's low-res RGB
// (`rgbLo`, also the refine's guide) and ONNX Runtime's normalised NCHW input, BIT-IDENTICAL to the
// CPU chain of sky/core.ts: rgbPlanes → resamplePlanes (separable area average) → normalise.
//
// Why a soft-float. The CPU chain is f64 arithmetic stored through Float32Arrays:
//   plane  s = fround(d / 255)                         (d a byte; a LUT here, as in the refine)
//   H pass tmp = fround(acc / scale), acc = Σ w·s in f64, taps in order, w = min(b, i+1) − max(a, i)
//   V pass the same over tmp
//   norm   fround((x − mean)·(1/std)) with f64 mean and 1/std
// The weights are f64, not integers, and every f64 add/multiply rounds, so a float sum (or an
// f32/double-float emulation) differs from the CPU in the last f32 bit for ~1 output in 10⁸ — the
// refine is identity-gated on rgbLo, so that is not acceptable. WGSL has no f64, hence this file
// carries a small exact soft-float: positive magnitudes M·2^e, M a 53-bit integer in two u32 words,
// with multiply, add, subtract, divide and the final round to f32 implemented with the IEEE
// round-to-nearest-even rules (guard / round / sticky; 55-bit restoring division). Each function
// here is the line-for-line twin of the u32 emulation in prep-ref.ts, which scripts/gpu/
// sky-prep-check.ts compares with native f64 and with the CPU functions (Object.is) on synthetic
// images and the repo photos. Weights, the two scales, the means and 1/std are computed on the CPU in
// f64 and shipped as raw words, so no constant is re-derived on the GPU. Everything is stored as u32
// bit patterns (never f32 arithmetic, so no flush-to-zero or NaN canonicalisation can touch a value).
//
// Scope (checked by prep.ts before any dispatch, else the CPU path runs): downsampling or equal size
// on both axes; the values are bytes/255 (≥ 1/255 or 0), so every f32 here is normal; subnormals read
// as zero and an out-of-range result writes a NaN that fails the verification.
// @workgroup_size(256): one output per invocation, 1-D, as the refine kernels.

const PARAMS = /* wgsl */ `
struct P { W: u32, H: u32, lw: u32, lh: u32, rowWords: u32, p0: u32, p1: u32, p2: u32 };
`;

/** The soft-float (twin of prep-ref.ts). F = M·2^e, M = h·2^32 + l ∈ [2^52, 2^53), or 0 (h = l = 0). */
const SOFT = /* wgsl */ `
struct F { h: u32, l: u32, e: i32 };

fn zeroF() -> F { return F(0u, 0u, 0); }
fn isZeroF(a: F) -> bool { return (a.h | a.l) == 0u; }

fn mulFull(a: u32, b: u32) -> vec2<u32> {
  let a0 = a & 0xffffu; let a1 = a >> 16u;
  let b0 = b & 0xffffu; let b1 = b >> 16u;
  let p00 = a0 * b0; let p01 = a0 * b1; let p10 = a1 * b0; let p11 = a1 * b1;
  let mid = (p00 >> 16u) + (p01 & 0xffffu) + (p10 & 0xffffu);
  let lo = ((mid & 0xffffu) << 16u) | (p00 & 0xffffu);
  let hi = p11 + (p01 >> 16u) + (p10 >> 16u) + (mid >> 16u);
  return vec2<u32>(lo, hi);
}

fn incF(h0: u32, l0: u32, e: i32) -> F {
  let l = l0 + 1u;
  let h = h0 + select(0u, 1u, l == 0u);
  if (h == 0x200000u) { return F(0x100000u, 0u, e + 1); }
  return F(h, l, e);
}

fn fromF32(bits: u32) -> F {
  if ((bits & 0x7fffffffu) < 0x00800000u) { return zeroF(); }
  let m24 = (bits & 0x7fffffu) | 0x800000u;
  let f = i32((bits >> 23u) & 0xffu);
  return F(m24 >> 3u, m24 << 29u, f - 150 - 29);
}

fn fromF64(lo: u32, hi: u32) -> F {
  let f = i32((hi >> 20u) & 0x7ffu);
  if (f == 0) { return zeroF(); }
  return F((hi & 0xfffffu) | 0x100000u, lo, f - 1075);
}

fn mulF(a: F, b: F) -> F {
  if (isZeroF(a) || isZeroF(b)) { return zeroF(); }
  let ll = mulFull(a.l, b.l);
  let lh = mulFull(a.l, b.h);
  let hl = mulFull(a.h, b.l);
  let hh = mulFull(a.h, b.h);
  let p0 = ll.x;
  var p1 = ll.y + lh.x;
  var c1 = select(0u, 1u, p1 < ll.y);
  let p1b = p1 + hl.x;
  c1 += select(0u, 1u, p1b < p1);
  p1 = p1b;
  var p2 = lh.y + hl.y;
  var c2 = select(0u, 1u, p2 < lh.y);
  var t = p2 + hh.x;
  c2 += select(0u, 1u, t < p2);
  p2 = t;
  t = p2 + c1;
  c2 += select(0u, 1u, t < p2);
  p2 = t;
  let p3 = hh.y + c2;
  let top = (p3 >> 9u) & 1u;
  let sh1 = 20u + top;
  let l = (p1 >> sh1) | (p2 << (32u - sh1));
  let h = (p2 >> sh1) | (p3 << (32u - sh1));
  let rem = p1 & ((1u << sh1) - 1u);
  let half = 1u << (sh1 - 1u);
  let e = a.e + b.e + 52 + i32(top);
  let up = rem > half || (rem == half && (p0 != 0u || (l & 1u) == 1u));
  if (up) { return incF(h, l, e); }
  return F(h, l, e);
}

fn shrSticky(lo: u32, hi: u32, d: u32) -> vec2<u32> {
  if (d == 0u) { return vec2<u32>(lo, hi); }
  if (d >= 64u) { return vec2<u32>(select(0u, 1u, (lo | hi) != 0u), 0u); }
  if (d >= 32u) {
    let k = d - 32u;
    let nl = select(hi >> k, hi, k == 0u);
    let lost = select(0u, 1u, lo != 0u || (hi & ((1u << k) - 1u)) != 0u);
    return vec2<u32>(nl | lost, 0u);
  }
  let nl = (lo >> d) | (hi << (32u - d));
  let lost = select(0u, 1u, (lo & ((1u << d) - 1u)) != 0u);
  return vec2<u32>(nl | lost, hi >> d);
}

fn shl64(lo: u32, hi: u32, k: u32) -> vec2<u32> {
  if (k == 0u) { return vec2<u32>(lo, hi); }
  if (k >= 32u) { return vec2<u32>(0u, lo << (k - 32u)); }
  return vec2<u32>(lo << k, (hi << k) | (lo >> (32u - k)));
}

// a + b, or a − b when sub (a ≥ b)
fn addSub(a0: F, b0: F, sub: bool) -> F {
  if (isZeroF(b0)) { return a0; }
  if (isZeroF(a0)) { return b0; }
  var a = a0;
  var b = b0;
  if (a.e < b.e) { a = b0; b = a0; }
  let d = u32(a.e - b.e);
  let xl = a.l << 3u;
  let xh = (a.h << 3u) | (a.l >> 29u);
  let y = shrSticky(b.l << 3u, (b.h << 3u) | (b.l >> 29u), d);
  var sl: u32;
  var sh: u32;
  if (sub) {
    sl = xl - y.x;
    sh = xh - y.y - select(0u, 1u, xl < y.x);
  } else {
    sl = xl + y.x;
    sh = xh + y.y + select(0u, 1u, sl < xl);
  }
  var e = a.e;
  if (sub) {
    if ((sl | sh) == 0u) { return zeroF(); }
    let lz = select(32u + countLeadingZeros(sl), countLeadingZeros(sh), sh != 0u);
    let k = lz - 8u;
    let s = shl64(sl, sh, k);
    sl = s.x;
    sh = s.y;
    e -= i32(k);
  } else if (((sh >> 24u) & 1u) == 1u) {
    let lost = sl & 1u;
    sl = ((sl >> 1u) | (sh << 31u)) | lost;
    sh = sh >> 1u;
    e += 1;
  }
  let l = (sl >> 3u) | (sh << 29u);
  let h = sh >> 3u;
  let low3 = sl & 7u;
  let up = low3 > 4u || (low3 == 4u && (l & 1u) == 1u);
  if (up) { return incF(h, l, e); }
  return F(h, l, e);
}
fn addF(a: F, b: F) -> F { return addSub(a, b, false); }
fn subF(a: F, b: F) -> F { return addSub(a, b, true); }

fn divF(a: F, b: F) -> F {
  if (isZeroF(a)) { return zeroF(); }
  var rl = a.l;
  var rh = a.h;
  var ql = 0u;
  var qh = 0u;
  for (var i = 0u; i < 55u; i++) {
    let ge = rh > b.h || (rh == b.h && rl >= b.l);
    if (ge) {
      let nl = rl - b.l;
      rh = rh - b.h - select(0u, 1u, rl < b.l);
      rl = nl;
    }
    qh = (qh << 1u) | (ql >> 31u);
    ql = (ql << 1u) | select(0u, 1u, ge);
    rh = (rh << 1u) | (rl >> 31u);
    rl = rl << 1u;
  }
  let sticky = (rl | rh) != 0u;
  let g = select(1u, 2u, ((qh >> 22u) & 1u) == 1u);
  let l = (ql >> g) | (qh << (32u - g));
  let h = qh >> g;
  let rbits = ql & ((1u << g) - 1u);
  let half = 1u << (g - 1u);
  let e = a.e - b.e - 54 + i32(g);
  let up = rbits > half || (rbits == half && (sticky || (l & 1u) == 1u));
  if (up) { return incF(h, l, e); }
  return F(h, l, e);
}

// fround of a positive F, as f32 bits (a NaN when out of f32's normal range)
fn toF32(a: F) -> u32 {
  if (isZeroF(a)) { return 0u; }
  let low29 = a.l & 0x1fffffffu;
  var m24 = (a.h << 3u) | (a.l >> 29u);
  let half = 1u << 28u;
  if (low29 > half || (low29 == half && (m24 & 1u) == 1u)) { m24 += 1u; }
  var e = a.e + 29;
  if (m24 == 0x1000000u) { m24 = 0x800000u; e += 1; }
  let f = e + 23 + 127;
  if (f < 1 || f > 254) { return 0x7fc00000u; }
  return (u32(f) << 23u) | (m24 & 0x7fffffu);
}
`;

/** Padded copyTextureToBuffer rows → the dense RGBA words the refine imports (one u32 per pixel). */
export const PREP_UNPACK = /* wgsl */ `${PARAMS}
@group(0) @binding(0) var<uniform> prm: P;
@group(0) @binding(1) var<storage, read> pad: array<u32>;
@group(0) @binding(2) var<storage, read_write> rgba: array<u32>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= prm.W * prm.H) { return; }
  let y = i / prm.W;
  rgba[i] = pad[y * prm.rowWords + (i - y * prm.W)];
}
`;

/**
 * Opacity gate: flag = 1 when any pixel of the unpacked photo has alpha != 255 (flag starts zeroed).
 * ImageBitmap bytes only equal getImageData's for opaque pixels (premultiply round trips), so a photo
 * with any translucent pixel must not take the GPU prep (sky/prep.ts).
 */
export const PREP_ALPHA = /* wgsl */ `${PARAMS}
@group(0) @binding(0) var<uniform> prm: P;
@group(0) @binding(1) var<storage, read> rgba: array<u32>;
@group(0) @binding(2) var<storage, read_write> flag: atomic<u32>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= prm.W * prm.H) { return; }
  if ((rgba[i] >> 24u) != 255u) { atomicStore(&flag, 1u); }
}
`;

/**
 * Horizontal pass: tmp[(c·H + y)·lw + j] = fround(Σ w·s / scaleH) over row y's taps; s = LUT[byte].
 * axH: (start, count) per output j, then taps (index, w lo, w hi); cst[0..1] = scaleH words.
 */
export const PREP_H = /* wgsl */ `${PARAMS}${SOFT}
@group(0) @binding(0) var<uniform> prm: P;
@group(0) @binding(1) var<storage, read> axH: array<u32>;
@group(0) @binding(2) var<storage, read> cst: array<u32>;
@group(0) @binding(3) var<storage, read> lut: array<f32>;
@group(0) @binding(4) var<storage, read> rgba: array<u32>;
@group(0) @binding(5) var<storage, read_write> tmp: array<u32>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= 3u * prm.H * prm.lw) { return; }
  let j = i % prm.lw;
  let r = i / prm.lw;
  let y = r % prm.H;
  let c = r / prm.H;
  let start = axH[2u * j];
  let count = axH[2u * j + 1u];
  var acc = zeroF();
  for (var t = 0u; t < count; t++) {
    let o = start + 3u * t;
    let px = rgba[y * prm.W + axH[o]];
    let d = (px >> (8u * c)) & 255u;
    acc = addF(acc, mulF(fromF64(axH[o + 1u], axH[o + 2u]), fromF32(bitcast<u32>(lut[d]))));
  }
  tmp[i] = toF32(divF(acc, fromF64(cst[0], cst[1])));
}
`;

/**
 * Vertical pass: rgbLo[(c·lh + j)·lw + x] = fround(Σ w·tmp / scaleV) over column x's taps.
 * axV as axH for the rows; cst[2..3] = scaleV words.
 */
export const PREP_V = /* wgsl */ `${PARAMS}${SOFT}
@group(0) @binding(0) var<uniform> prm: P;
@group(0) @binding(1) var<storage, read> axV: array<u32>;
@group(0) @binding(2) var<storage, read> cst: array<u32>;
@group(0) @binding(3) var<storage, read> tmp: array<u32>;
@group(0) @binding(4) var<storage, read_write> lo: array<u32>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= 3u * prm.lh * prm.lw) { return; }
  let x = i % prm.lw;
  let r = i / prm.lw;
  let j = r % prm.lh;
  let c = r / prm.lh;
  let start = axV[2u * j];
  let count = axV[2u * j + 1u];
  var acc = zeroF();
  for (var t = 0u; t < count; t++) {
    let o = start + 3u * t;
    let s = tmp[(c * prm.H + axV[o]) * prm.lw + x];
    acc = addF(acc, mulF(fromF64(axV[o + 1u], axV[o + 2u]), fromF32(s)));
  }
  lo[i] = toF32(divF(acc, fromF64(cst[2], cst[3])));
}
`;

/**
 * ImageNet normalise: inp[i] = fround((lo[i] − mean_c)·(1/std_c)), c = plane. cst[4 + 2c..] = mean_c,
 * cst[10 + 2c..] = 1/std_c (f64 words). The sign is handled outside the magnitude arithmetic
 * (round-to-nearest-even is symmetric).
 */
export const PREP_NORM = /* wgsl */ `${PARAMS}${SOFT}
@group(0) @binding(0) var<uniform> prm: P;
@group(0) @binding(1) var<storage, read> cst: array<u32>;
@group(0) @binding(2) var<storage, read> lo: array<u32>;
@group(0) @binding(3) var<storage, read_write> inp: array<u32>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let n = prm.lw * prm.lh;
  let i = id.x;
  if (i >= 3u * n) { return; }
  let c = i / n;
  let x = fromF32(lo[i]);
  let m = fromF64(cst[4u + 2u * c], cst[5u + 2u * c]);
  let s = fromF64(cst[10u + 2u * c], cst[11u + 2u * c]);
  var mag: F;
  var neg = false;
  if (isZeroF(x)) {
    mag = m;
    neg = true;
  } else if (x.e > m.e || (x.e == m.e && (x.h > m.h || (x.h == m.h && x.l >= m.l)))) {
    mag = subF(x, m);
  } else {
    mag = subF(m, x);
    neg = true;
  }
  let bits = toF32(mulF(mag, s));
  inp[i] = select(bits, bits | 0x80000000u, neg && bits != 0u);
}
`;
