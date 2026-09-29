// WGSL for the GPU haze fit (twin of look/haze-fit.ts fitHaze). Three groups of kernels:
//  1. per pixel: the photo box-resampled to linear on the geo grid, the depth-edge test, the
//     separable dilations (edges, people) and the log-range bin, with per-bin counts;
//  2. exact order statistics per (bin, channel) for the 1st / 9th percentiles: a 3-pass radix
//     select over the f32 bit patterns (lin ≥ 0, so they sort as u32), 11 + 11 + 10 bits, with
//     atomic histograms, all on the GPU (no readback between passes);
//  3. the physical fit's (H_M, kR, β_M) grid: one invocation per cell evaluates the robust SSE,
//     read back as 5 550 floats; the CPU re-checks the near-best cells in f64.

const NBINS = 24;
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
@group(0) @binding(6) var<storage, read> fgm: array<u32>;
@group(0) @binding(7) var<storage, read_write> lin: array<f32>;
@group(0) @binding(8) var<storage, read_write> flags: array<u32>;
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
  flags[i] = select(0u, 1u, edge) | (fgm[i] << 1u);
}
`;

/** Horizontal dilation: bit 0 over ±rad, bit 1 over ±fgRad. */
export const HZ_DILH = /* wgsl */ `${PREP_PARAMS}
@group(0) @binding(0) var<uniform> prm: P;
@group(0) @binding(1) var<storage, read> flags: array<u32>;
@group(0) @binding(2) var<storage, read_write> outf: array<u32>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let W = prm.W;
  let i = id.x;
  if (i >= W * prm.H) { return; }
  let y = i / W;
  let x = i - y * W;
  let row = y * W;
  var e = 0u; var f = 0u;
  let a0 = select(0u, x - prm.rad, x >= prm.rad);
  for (var k = a0; k <= min(W - 1u, x + prm.rad); k++) { e |= flags[row + k] & 1u; }
  let b0 = select(0u, x - prm.fgRad, x >= prm.fgRad);
  for (var k = b0; k <= min(W - 1u, x + prm.fgRad); k++) { f |= flags[row + k] & 2u; }
  outf[i] = e | f;
}
`;

/** Vertical dilation, then the log-range bin (−1 = unused) and the per-bin counts. */
export const HZ_BIN = /* wgsl */ `${PREP_PARAMS}
@group(0) @binding(0) var<uniform> prm: P;
@group(0) @binding(1) var<storage, read> flagsH: array<u32>;
@group(0) @binding(2) var<storage, read> range: array<f32>;
@group(0) @binding(3) var<storage, read> psky: array<f32>;
@group(0) @binding(4) var<storage, read_write> bins: array<i32>;
@group(0) @binding(5) var<storage, read_write> counts: array<atomic<u32>>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let W = prm.W; let H = prm.H;
  let i = id.x;
  if (i >= W * H) { return; }
  let y = i / W;
  let x = i - y * W;
  var near = 0u;
  let a0 = select(0u, y - prm.rad, y >= prm.rad);
  for (var k = a0; k <= min(H - 1u, y + prm.rad); k++) { near |= flagsH[k * W + x] & 1u; }
  let b0 = select(0u, y - prm.fgRad, y >= prm.fgRad);
  for (var k = b0; k <= min(H - 1u, y + prm.fgRad); k++) { near |= flagsH[k * W + x] & 2u; }
  let r = range[i];
  var b = -1;
  if (!(r < prm.rmin || r >= prm.rmax || near != 0u || psky[i] > 0.3)) {
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

export const HZ_CLEAR = /* wgsl */ `
@group(0) @binding(0) var<storage, read_write> hist: array<u32>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x < arrayLength(&hist)) { hist[id.x] = 0u; }
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

/** Pick the bucket holding each selection's remaining rank; extend its prefix. */
export const HZ_SCAN = /* wgsl */ `${SEL_COMMON}
@group(0) @binding(0) var<uniform> prm: S;
@group(0) @binding(1) var<storage, read> hist: array<u32>;
@group(0) @binding(2) var<storage, read_write> state: array<vec2<u32>>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let s = id.x;
  if (s >= ${SEL}u) { return; }
  let p = prm.pass_;
  let h0 = select(s, s & ~3u, p == 0u) * ${BUCKETS}u;
  let nb = 1u << bitsOf(p);
  var st = state[s];
  var cum = 0u;
  var d = 0u;
  for (; d < nb; d++) {
    let h = hist[h0 + d];
    if (cum + h > st.y) { break; }
    cum += h;
  }
  st.x = (st.x << bitsOf(p)) | min(d, nb - 1u);
  st.y -= cum;
  state[s] = st;
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
