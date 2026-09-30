// WGSL for the texture-input look passes (textures.ts): gather nodes that read the renderer's
// targets (geometry rgba32float xyzr or r32float range, colour rgba8unorm(-srgb), masks r8unorm) with textureLoad and rebuild,
// bit for bit, the arrays the CPU builds before upload (capture.ts / composite.ts / haze.ts), plus
// the mask packer that writes the composite's RGBA8 masks in copyBufferToTexture's padded rows.
//
// Exactness rules (the array path is the reference):
// - Every CPU index / footprint is an f64 expression of the sizes only, so the CPU computes them
//   once per size into a u32 table (`tab`); the kernels never re-derive them in f32.
// - Texel values are exact: unorm8 → f32 → round(·255) recovers the byte; rgba32float loads are
//   the stored floats.
// - The CPU's f64 arithmetic rounded to f32 equals the correctly rounded quotient of two exact
//   integers here (luma, coverage, mask bytes / 255), which divr() gives: an f32 divide plus one
//   fma residual correction.
// - Row flips: `flip` = the texture's row 0 is the image's BOTTOM row (GL readPixels order, or an
//   image uploaded with copyExternalImage, which ignores flipY). Rows passed in are image rows,
//   row 0 = top.
// @workgroup_size(256): one output texel per invocation, 1-D over the output grid.

const COMMON = /* wgsl */ `
fn divr(n: f32, d: f32) -> f32 {
  let q = n / d;
  return q + fma(-q, d, n) / d;
}
fn trow(y: u32, h: u32, flip: u32) -> i32 { return i32(select(y, h - 1u - y, flip != 0u)); }
fn byte8(t: f32) -> u32 { return u32(round(t * 255.0)); }
// isTerrain: r > 0 and finite (NaN fails r > 0)
fn terrain(r: f32) -> bool { return r > 0.0 && r <= 3.4028234e38; }
// the range channel: alpha of the three engine's rgba32float xyzr target, or .r of an r32float one
fn rng(t: vec4<f32>, r1: u32) -> f32 { return select(t.a, t.r, r1 != 0u); }
`;

/**
 * Colour texture → packed RGBA8 words (row 0 = top) at W × H: the rounded mean of the source
 * texels in each output pixel's footprint (x: [xb[2x], xb[2x+1]), y likewise). A 1-texel footprint
 * (same size) copies the bytes exactly. `srgb` = an rgba8unorm-srgb texture (the WebGPU renderer's
 * photo): textureLoad decodes it to linear, so RGB is re-encoded to the stored sRGB byte
 * (textures-bench checks all 256 values round-trip exactly).
 */
export const TEX_PHOTO = /* wgsl */ `${COMMON}
struct P { W: u32, H: u32, srcH: u32, flip: u32, srgb: u32, pad0: u32, pad1: u32, pad2: u32 };
fn enc(v: f32) -> f32 { return select(1.055 * pow(v, 1.0 / 2.4) - 0.055, v * 12.92, v <= 0.0031308); }
@group(0) @binding(0) var<uniform> prm: P;
@group(0) @binding(1) var<storage, read> xb: array<u32>;
@group(0) @binding(2) var<storage, read> yb: array<u32>;
@group(0) @binding(3) var src: texture_2d<f32>;
@group(0) @binding(4) var<storage, read_write> outp: array<u32>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= prm.W * prm.H) { return; }
  let y = i / prm.W;
  let x = i - y * prm.W;
  let x0 = xb[2u * x]; let x1 = xb[2u * x + 1u];
  let y0 = yb[2u * y]; let y1 = yb[2u * y + 1u];
  var s = vec4<u32>(0u);
  for (var yy = y0; yy < y1; yy++) {
    let ty = trow(yy, prm.srcH, prm.flip);
    for (var xx = x0; xx < x1; xx++) {
      var t = textureLoad(src, vec2<i32>(i32(xx), ty), 0);
      if (prm.srgb != 0u) { t = vec4<f32>(enc(t.r), enc(t.g), enc(t.b), t.a); }
      s += vec4<u32>(byte8(t.r), byte8(t.g), byte8(t.b), byte8(t.a));
    }
  }
  let n = (x1 - x0) * (y1 - y0);
  let b = (s + vec4<u32>(n / 2u)) / n;
  outp[i] = b.r | (b.g << 8u) | (b.b << 16u) | (b.a << 24u);
}
`;

/**
 * composite.ts updateMasks' inputs on the w × h mask grid: the photo's luma I, the DEM coverage
 * (terrain share of the ss × ss geometry block × (1 − P(sky))) and the people mask.
 * tab: gx[w] = ⌊x·gw/w⌋, gy[h], skyU[w], skyV[h], fgU[w], fgV[h] (maskAt's texel indices).
 */
export const TEX_MASKS = /* wgsl */ `${COMMON}
struct P {
  w: u32, h: u32, gw: u32, gh: u32,
  ss: u32, flipGeo: u32, sky: u32, flipSky: u32,
  skyH: u32, fg: u32, flipFg: u32, fgH: u32,
  geoR: u32, pad0: u32, pad1: u32, pad2: u32,
};
@group(0) @binding(0) var<uniform> prm: P;
@group(0) @binding(1) var<storage, read> tab: array<u32>;
@group(0) @binding(2) var<storage, read> photo: array<u32>;
@group(0) @binding(3) var geo: texture_2d<f32>;
@group(0) @binding(4) var skyT: texture_2d<f32>;
@group(0) @binding(5) var fgT: texture_2d<f32>;
@group(0) @binding(6) var<storage, read_write> gI: array<f32>;
@group(0) @binding(7) var<storage, read_write> cov: array<f32>;
@group(0) @binding(8) var<storage, read_write> fgv: array<f32>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let w = prm.w; let h = prm.h;
  let i = id.x;
  if (i >= w * h) { return; }
  let y = i / w;
  let x = i - y * w;
  let p = photo[i];
  let lum = 2126u * (p & 255u) + 7152u * ((p >> 8u) & 255u) + 722u * ((p >> 16u) & 255u);
  gI[i] = divr(f32(lum), 2550000.0);
  var t = 0u;
  for (var dy = 0u; dy < prm.ss; dy++) {
    let gy = min(prm.gh - 1u, tab[w + y] + dy);
    let ty = trow(gy, prm.gh, prm.flipGeo);
    for (var dx = 0u; dx < prm.ss; dx++) {
      let gx = min(prm.gw - 1u, tab[x] + dx);
      if (terrain(rng(textureLoad(geo, vec2<i32>(i32(gx), ty), 0), prm.geoR))) { t++; }
    }
  }
  let ss2 = prm.ss * prm.ss;
  if (prm.sky != 0u) {
    let m = byte8(textureLoad(skyT, vec2<i32>(i32(tab[w + h + x]), trow(tab[2u * w + h + y], prm.skyH, prm.flipSky)), 0).r);
    cov[i] = divr(f32(t * (255u - m)), f32(ss2 * 255u));
  } else {
    cov[i] = divr(f32(t), f32(ss2));
  }
  if (prm.fg != 0u) {
    let m = byte8(textureLoad(fgT, vec2<i32>(i32(tab[2u * w + 2u * h + x]), trow(tab[3u * w + 2u * h + y], prm.fgH, prm.flipFg)), 0).r);
    fgv[i] = divr(f32(m), 255.0);
  }
}
`;

/**
 * composite.ts setStats' GPU inputs on the w × h layer grid: range (sanitised, 0 = sky), the layer
 * (linear RGBA, row 0 = top) and the people mask. tab: gx[w] = ⌊(x+½)·gw/w⌋, gy[h], fgU[w], fgV[h].
 */
export const TEX_STATS = /* wgsl */ `${COMMON}
struct P {
  w: u32, h: u32, gh: u32, flipGeo: u32,
  flipLayer: u32, fg: u32, flipFg: u32, fgH: u32,
  geoR: u32, pad0: u32, pad1: u32, pad2: u32,
};
@group(0) @binding(0) var<uniform> prm: P;
@group(0) @binding(1) var<storage, read> tab: array<u32>;
@group(0) @binding(2) var geo: texture_2d<f32>;
@group(0) @binding(3) var layerT: texture_2d<f32>;
@group(0) @binding(4) var fgT: texture_2d<f32>;
@group(0) @binding(5) var<storage, read_write> range: array<f32>;
@group(0) @binding(6) var<storage, read_write> layer: array<vec4<f32>>;
@group(0) @binding(7) var<storage, read_write> fgv: array<f32>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let w = prm.w; let h = prm.h;
  let i = id.x;
  if (i >= w * h) { return; }
  let y = i / w;
  let x = i - y * w;
  let r = rng(textureLoad(geo, vec2<i32>(i32(tab[x]), trow(tab[w + y], prm.gh, prm.flipGeo)), 0), prm.geoR);
  range[i] = select(0.0, r, terrain(r));
  layer[i] = textureLoad(layerT, vec2<i32>(i32(x), trow(y, h, prm.flipLayer)), 0);
  if (prm.fg != 0u) {
    let m = byte8(textureLoad(fgT, vec2<i32>(i32(tab[w + h + x]), trow(tab[2u * w + h + y], prm.fgH, prm.flipFg)), 0).r);
    fgv[i] = divr(f32(m), 255.0);
  } else {
    fgv[i] = 0.0;
  }
}
`;

/**
 * haze.ts fitHazeGpu's per-pixel inputs on the decimated W × H geo grid (row 0 = top): the raw
 * range and P(sky) (the sky mask, else range > 0 ? 0 : 1); the people bits are TEX_FGBITS.
 * tab: gx[W], gy[H] (geometry texel, image rows), skyX[W], skyY[H], fgX[W], fgY[H].
 */
export const TEX_HAZE = /* wgsl */ `${COMMON}
struct P {
  W: u32, H: u32, gh: u32, flipGeo: u32,
  sky: u32, flipSky: u32, skyH: u32, fg: u32,
  flipFg: u32, fgH: u32, geoR: u32, pad0: u32,
};
@group(0) @binding(0) var<uniform> prm: P;
@group(0) @binding(1) var<storage, read> tab: array<u32>;
@group(0) @binding(2) var geo: texture_2d<f32>;
@group(0) @binding(3) var skyT: texture_2d<f32>;
@group(0) @binding(4) var<storage, read_write> range: array<f32>;
@group(0) @binding(5) var<storage, read_write> psky: array<f32>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let W = prm.W; let H = prm.H;
  let i = id.x;
  if (i >= W * H) { return; }
  let y = i / W;
  let x = i - y * W;
  let r = rng(textureLoad(geo, vec2<i32>(i32(tab[x]), trow(tab[W + y], prm.gh, prm.flipGeo)), 0), prm.geoR);
  range[i] = r;
  if (prm.sky != 0u) {
    let m = byte8(textureLoad(skyT, vec2<i32>(i32(tab[W + H + x]), trow(tab[2u * W + H + y], prm.skyH, prm.flipSky)), 0).r);
    psky[i] = divr(f32(m), 255.0);
  } else {
    psky[i] = select(1.0, 0.0, r > 0.0);
  }
}
`;

/**
 * The people mask as haze.ts packs it: bit i & 31 of word i >> 5 = fg byte > 64 at pixel i of the
 * W × H grid. One word (32 pixels) per invocation; the same prm / tab as TEX_HAZE.
 */
export const TEX_FGBITS = /* wgsl */ `${COMMON}
struct P {
  W: u32, H: u32, gh: u32, flipGeo: u32,
  sky: u32, flipSky: u32, skyH: u32, fg: u32,
  flipFg: u32, fgH: u32, geoR: u32, pad0: u32,
};
@group(0) @binding(0) var<uniform> prm: P;
@group(0) @binding(1) var<storage, read> tab: array<u32>;
@group(0) @binding(2) var fgT: texture_2d<f32>;
@group(0) @binding(3) var<storage, read_write> fgm: array<u32>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let W = prm.W; let H = prm.H;
  let wi = id.x;
  if (wi >= (W * H + 31u) / 32u) { return; }
  var v = 0u;
  if (prm.fg != 0u) {
    for (var k = 0u; k < 32u; k++) {
      let i = wi * 32u + k;
      if (i >= W * H) { break; }
      let y = i / W;
      let x = i - y * W;
      let m = byte8(textureLoad(fgT, vec2<i32>(i32(tab[2u * W + 2u * H + x]), trow(tab[3u * W + 2u * H + y], prm.fgH, prm.flipFg)), 0).r);
      if (m > 64u) { v |= 1u << k; }
    }
  }
  fgm[wi] = v;
}
`;

/** Zero a u32 buffer (its bound range). */
export const ZERO_U32 = /* wgsl */ `
@group(0) @binding(0) var<storage, read_write> buf: array<u32>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x < arrayLength(&buf)) { buf[id.x] = 0u; }
}
`;

/**
 * The composite's mask texture from the guided-filter outputs: Math.round(q·255) exactly (b8), in rows
 * of `rowWords` u32 (copyBufferToTexture's 256-byte row pitch). rgba (fmt 4): r = coverage,
 * g = cut, b = people, a = 255, one word per texel. r8 (fmt 1): coverage only, four texels a word.
 */
export const PACK_MASKS = /* wgsl */ `
struct P { w: u32, h: u32, rowWords: u32, fmt: u32, cut: u32, fg: u32, pad0: u32, pad1: u32 };
@group(0) @binding(0) var<uniform> prm: P;
@group(0) @binding(1) var<storage, read> qc: array<f32>;
@group(0) @binding(2) var<storage, read> qg: array<f32>;
@group(0) @binding(3) var<storage, read> qf: array<f32>;
@group(0) @binding(4) var<storage, read_write> outp: array<u32>;
fn b8(q: f32) -> u32 {
  // Math.round(q·255) = k ⇔ (2k−1)/510 ≤ q < (2k+1)/510, i.e. q·512 − (2k∓1) vs 2q: q·512 and 2q
  // are exact and the subtraction is exact near the threshold (Sterbenz), so the test is exact;
  // the f32 estimate is off by at most one
  var k = u32(floor(q * 255.0 + 0.5));
  let q512 = q * 512.0;
  if (k > 0u && !(q512 - f32(2u * k - 1u) >= 2.0 * q)) { k -= 1u; }
  else if (k < 255u && q512 - f32(2u * k + 1u) >= 2.0 * q) { k += 1u; }
  return k;
}
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= prm.rowWords * prm.h) { return; }
  let y = i / prm.rowWords;
  let wx = i - y * prm.rowWords;
  var v = 0u;
  if (prm.fmt == 4u) {
    if (wx < prm.w) {
      let j = y * prm.w + wx;
      v = b8(qc[j]) | (255u << 24u);
      if (prm.cut != 0u) { v |= b8(qg[j]) << 8u; }
      if (prm.fg != 0u) { v |= b8(qf[j]) << 16u; }
    }
  } else {
    for (var k = 0u; k < 4u; k++) {
      let x = 4u * wx + k;
      if (x < prm.w) { v |= b8(qc[y * prm.w + x]) << (8u * k); }
    }
  }
  outp[i] = v;
}
`;
