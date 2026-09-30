// WGSL for the GPU sky refine (twin of sky/core.ts refineToWorking with refine = true): the fast
// colour guided filter at model resolution, the band blend, the bilinear upsample to working
// resolution, and toBytes. Every pass mirrors one CPU loop and rounds to f32 where the CPU stores a
// Float32Array; the CPU sums in f64 (running box sums, 3×3 inverse), we sum directly in f32, so the
// float mask agrees to ~1e-6 rather than bit-exactly.
// Exact by construction: the full-res guide (RGBA byte → the CPU's fround(d / 255) through a LUT),
// the band test (thresholds rewritten as f32 compares, see LO_V) and toBytes (per-byte f32
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
 * Row pass at model resolution. Box means (radius r) of I, p, I·p, the six I_a·I_b, and the row max /
 * min of p (radius br) for the band. Output per texel, 4 × vec4:
 * [mI.rgb, mp], [mIp.rgb, pmax], [m(rr, gg, bb), pmin], [m(rg, rb, gb), 0].
 */
export const LO_H = /* wgsl */ `${PARAMS}${RANGE}
@group(0) @binding(0) var<uniform> prm: P;
@group(0) @binding(1) var<storage, read> gl: array<f32>;
@group(0) @binding(2) var<storage, read> gp: array<f32>;
@group(0) @binding(3) var<storage, read_write> t: array<vec4<f32>>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let n = prm.lw * prm.lh;
  let i = id.x;
  if (i >= n) { return; }
  let y = i / prm.lw;
  let x = i - y * prm.lw;
  let s = span(x, prm.r, prm.lw);
  var mI = vec3<f32>(0.0);
  var mp = 0.0;
  var mIp = vec3<f32>(0.0);
  var d = vec3<f32>(0.0);
  var o = vec3<f32>(0.0);
  for (var k = s.x; k < s.y; k++) {
    let j = y * prm.lw + k;
    let c = vec3<f32>(gl[j], gl[n + j], gl[2u * n + j]);
    let p = gp[j];
    mI += c;
    mp += p;
    mIp += c * p;
    d += c * c;
    o += vec3<f32>(c.x * c.y, c.x * c.z, c.y * c.z);
  }
  let cnt = f32(s.y - s.x);
  let e = span(x, prm.br, prm.lw);
  var mx = gp[i];
  var mn = gp[i];
  for (var k = e.x; k < e.y; k++) {
    let v = gp[y * prm.lw + k];
    mx = max(mx, v);
    mn = min(mn, v);
  }
  t[4u * i] = vec4<f32>(mI / cnt, mp / cnt);
  t[4u * i + 1u] = vec4<f32>(mIp / cnt, mx);
  t[4u * i + 2u] = vec4<f32>(d / cnt, mn);
  t[4u * i + 3u] = vec4<f32>(o / cnt, 0.0);
}
`;

/**
 * Column pass: box means of the row means, then the colour guided-filter solve
 * a = (Σ + εI)⁻¹ cov(I, p), b = mean(p) − a·mean(I) (cofactor inverse, as the CPU), and the band
 * indicator max(straddle, unsure). The CPU compares f32 p with the f64 constants 0.05 / 0.95:
 * p > 0.05 ⇔ p ≥ f32(0.05) (f32(0.05) > 0.05) and p < 0.95 ⇔ p ≤ f32(0.95) (f32(0.95) < 0.95).
 */
export const LO_V = /* wgsl */ `${PARAMS}${RANGE}
@group(0) @binding(0) var<uniform> prm: P;
@group(0) @binding(1) var<storage, read> t: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> gp: array<f32>;
@group(0) @binding(3) var<storage, read_write> ab: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read_write> band: array<f32>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let n = prm.lw * prm.lh;
  let i = id.x;
  if (i >= n) { return; }
  let y = i / prm.lw;
  let x = i - y * prm.lw;
  let s = span(y, prm.r, prm.lh);
  var m0 = vec4<f32>(0.0);
  var m1 = vec3<f32>(0.0);
  var m2 = vec3<f32>(0.0);
  var m3 = vec3<f32>(0.0);
  for (var k = s.x; k < s.y; k++) {
    let j = 4u * (k * prm.lw + x);
    m0 += t[j];
    m1 += t[j + 1u].xyz;
    m2 += t[j + 2u].xyz;
    m3 += t[j + 3u].xyz;
  }
  let cnt = f32(s.y - s.x);
  m0 /= cnt;
  m1 /= cnt;
  m2 /= cnt;
  m3 /= cnt;
  let mI = m0.xyz;
  let mp = m0.w;
  let x0 = m1.x - mI.x * mp;
  let x1 = m1.y - mI.y * mp;
  let x2 = m1.z - mI.z * mp;
  let s00 = (m2.x - mI.x * mI.x) + prm.eps;
  let s11 = (m2.y - mI.y * mI.y) + prm.eps;
  let s22 = (m2.z - mI.z * mI.z) + prm.eps;
  let s01 = m3.x - mI.x * mI.y;
  let s02 = m3.y - mI.x * mI.z;
  let s12 = m3.z - mI.y * mI.z;
  let c00 = s11 * s22 - s12 * s12;
  let c01 = s02 * s12 - s01 * s22;
  let c02 = s01 * s12 - s02 * s11;
  let c11 = s00 * s22 - s02 * s02;
  let c12 = s01 * s02 - s00 * s12;
  let c22 = s00 * s11 - s01 * s01;
  let det = s00 * c00 + s01 * c01 + s02 * c02;
  let id_ = 1.0 / det;
  let a0 = (c00 * x0 + c01 * x1 + c02 * x2) * id_;
  let a1 = (c01 * x0 + c11 * x1 + c12 * x2) * id_;
  let a2 = (c02 * x0 + c12 * x1 + c22 * x2) * id_;
  ab[i] = vec4<f32>(a0, a1, a2, mp - a0 * mI.x - a1 * mI.y - a2 * mI.z);
  let e = span(y, prm.br, prm.lh);
  var mx = t[4u * i + 1u].w;
  var mn = t[4u * i + 2u].w;
  for (var k = e.x; k < e.y; k++) {
    let j = 4u * (k * prm.lw + x);
    mx = max(mx, t[j + 1u].w);
    mn = min(mn, t[j + 2u].w);
  }
  let p = gp[i];
  let straddle = mx > 0.5 && mn < 0.5;
  let unsure = p >= 0.05 && p <= 0.95;
  band[i] = select(0.0, 1.0, straddle || unsure);
}
`;

/** Row box means of (a, b) (radius r) and of the band (radius 1). */
export const LO_H2 = /* wgsl */ `${PARAMS}${RANGE}
@group(0) @binding(0) var<uniform> prm: P;
@group(0) @binding(1) var<storage, read> ab: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> band: array<f32>;
@group(0) @binding(3) var<storage, read_write> abH: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read_write> bandH: array<f32>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let n = prm.lw * prm.lh;
  let i = id.x;
  if (i >= n) { return; }
  let y = i / prm.lw;
  let x = i - y * prm.lw;
  let s = span(x, prm.r, prm.lw);
  var acc = vec4<f32>(0.0);
  for (var k = s.x; k < s.y; k++) { acc += ab[y * prm.lw + k]; }
  abH[i] = acc / f32(s.y - s.x);
  let e = span(x, 1u, prm.lw);
  var b = 0.0;
  for (var k = e.x; k < e.y; k++) { b += band[y * prm.lw + k]; }
  bandH[i] = b / f32(e.y - e.x);
}
`;

/** Column box means: smoothed (a, b) and, for the upsample, (p, band). */
export const LO_V2 = /* wgsl */ `${PARAMS}${RANGE}
@group(0) @binding(0) var<uniform> prm: P;
@group(0) @binding(1) var<storage, read> abH: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> bandH: array<f32>;
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
  let s = span(y, prm.r, prm.lh);
  var acc = vec4<f32>(0.0);
  for (var k = s.x; k < s.y; k++) { acc += abH[k * prm.lw + x]; }
  abS[i] = acc / f32(s.y - s.x);
  let e = span(y, 1u, prm.lh);
  var b = 0.0;
  for (var k = e.x; k < e.y; k++) { b += bandH[k * prm.lw + x]; }
  pb[i] = vec2<f32>(gp[i], b / f32(e.y - e.x));
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
