// WGSL for the GPU band statistics (twin of look/color-stats.ts bandInputs + reduceBands): per
// pixel the photo's and the layer's Oklab, the validity mask (terrain beyond minRange, full layer
// coverage, no people, ≥ 3 px from the sky) and the range band; then per band Σ and Σ² of both
// Oklab triples and the count, reduced per workgroup. The CPU sums the per-workgroup partials in
// float64 and applies reduceBands' std floors and empty-band back-fill.
// @workgroup_size(64): 13 × 4 bands = 52 partial sums per invocation in workgroup memory
// (64 × 52 × 4 B = 13 KB, under the 16 KB limit); each invocation strides over ~20 pixels first.
// BAND_STATS_SG is the same with subgroup reductions (needs the "subgroups" feature): equal up to
// the float sums' reassociation.

export const STATS_VALUES = 52;

export const BAND_STATS = /* wgsl */ `
struct P { w: u32, h: u32, threads: u32, hasFg: u32, minRange: f32 };
@group(0) @binding(0) var<uniform> prm: P;
@group(0) @binding(1) var<storage, read> photo: array<u32>;
@group(0) @binding(2) var<storage, read> layer: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> range: array<f32>;
@group(0) @binding(4) var<storage, read> fg: array<f32>;
@group(0) @binding(5) var<storage, read> lut: array<f32>;
@group(0) @binding(6) var<storage, read_write> partial: array<f32>;
var<workgroup> sh: array<array<f32, 52>, 64>;

fn cbrt0(x: f32) -> f32 { return select(0.0, pow(x, 1.0 / 3.0), x > 0.0); }
fn oklab(c: vec3<f32>) -> vec3<f32> {
  let l = cbrt0(max(0.0, 0.4122214708 * c.r + 0.5363325363 * c.g + 0.0514459929 * c.b));
  let m = cbrt0(max(0.0, 0.2119034982 * c.r + 0.6806995451 * c.g + 0.1073969566 * c.b));
  let s = cbrt0(max(0.0, 0.0883024619 * c.r + 0.2817188376 * c.g + 0.6299787005 * c.b));
  return vec3<f32>(
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s);
}
fn sky(x: i32, y: i32) -> bool {
  return x >= 0 && y >= 0 && x < i32(prm.w) && y < i32(prm.h) && range[u32(y) * prm.w + u32(x)] == 0.0;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(local_invocation_index) lid: u32,
        @builtin(workgroup_id) wid: vec3<u32>) {
  var acc: array<f32, 52>;
  for (var k = 0u; k < 52u; k++) { acc[k] = 0.0; }
  let n = prm.w * prm.h;
  for (var i = gid.x; i < n; i += prm.threads) {
    let r = range[i];
    let L = layer[i];
    if (!(r > prm.minRange && L.a > 0.98)) { continue; }
    if (prm.hasFg != 0u && fg[i] >= 0.3) { continue; }
    let y = i32(i / prm.w);
    let x = i32(i) - y * i32(prm.w);
    var edge = false;
    for (var d = 1; d <= 3; d++) {
      if (sky(x, y - d) || sky(x - d, y) || sky(x + d, y)) { edge = true; }
    }
    if (edge) { continue; }
    let px = photo[i];
    let pc = vec3<f32>(lut[px & 255u], lut[(px >> 8u) & 255u], lut[(px >> 16u) & 255u]);
    let a = oklab(pc);
    let b = oklab(L.rgb * (1.0 / L.a));
    let band = select(select(select(3u, 2u, r < 20000.0), 1u, r < 5000.0), 0u, r < 1000.0);
    let o = band * 13u;
    acc[o] += 1.0;
    for (var c = 0u; c < 3u; c++) {
      acc[o + 1u + c] += a[c];
      acc[o + 4u + c] += a[c] * a[c];
      acc[o + 7u + c] += b[c];
      acc[o + 10u + c] += b[c] * b[c];
    }
  }
  sh[lid] = acc;
  workgroupBarrier();
  for (var s = 32u; s > 0u; s >>= 1u) {
    if (lid < s) {
      for (var k = 0u; k < 52u; k++) { sh[lid][k] += sh[lid + s][k]; }
    }
    workgroupBarrier();
  }
  if (lid == 0u) {
    for (var k = 0u; k < 52u; k++) { partial[wid.x * 52u + k] = sh[0][k]; }
  }
}
`;

/**
 * BAND_STATS with the per-workgroup reduction by subgroupAdd: each subgroup's 52 sums land in
 * workgroup memory, then invocation k < 52 adds sum k over the subgroups. Rows are indexed by
 * local_invocation_index / subgroup_size, which assumes subgroups are contiguous runs of it. That
 * holds for 1-D workgroups on Metal / Vulkan / D3D but WGSL doesn't guarantee it, so each subgroup
 * checks it and writes NaN partials when it fails (bandStatsGpu then re-runs BAND_STATS).
 * The pixel loop runs in uniform control flow (the subgroup ops require it).
 */
export const BAND_STATS_SG = /* wgsl */ `enable subgroups;
struct P { w: u32, h: u32, threads: u32, hasFg: u32, minRange: f32 };
@group(0) @binding(0) var<uniform> prm: P;
@group(0) @binding(1) var<storage, read> photo: array<u32>;
@group(0) @binding(2) var<storage, read> layer: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> range: array<f32>;
@group(0) @binding(4) var<storage, read> fg: array<f32>;
@group(0) @binding(5) var<storage, read> lut: array<f32>;
@group(0) @binding(6) var<storage, read_write> partial: array<f32>;
// one row per subgroup (≥ 4 lanes each, so at most 16 in a 64-wide workgroup)
var<workgroup> sh: array<array<f32, 52>, 16>;
var<private> acc: array<f32, 52>;

fn cbrt0(x: f32) -> f32 { return select(0.0, pow(x, 1.0 / 3.0), x > 0.0); }
fn oklab(c: vec3<f32>) -> vec3<f32> {
  let l = cbrt0(max(0.0, 0.4122214708 * c.r + 0.5363325363 * c.g + 0.0514459929 * c.b));
  let m = cbrt0(max(0.0, 0.2119034982 * c.r + 0.6806995451 * c.g + 0.1073969566 * c.b));
  let s = cbrt0(max(0.0, 0.0883024619 * c.r + 0.2817188376 * c.g + 0.6299787005 * c.b));
  return vec3<f32>(
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s);
}
fn sky(x: i32, y: i32) -> bool {
  return x >= 0 && y >= 0 && x < i32(prm.w) && y < i32(prm.h) && range[u32(y) * prm.w + u32(x)] == 0.0;
}

// BAND_STATS's per-pixel body (early returns instead of continue)
fn addPixel(i: u32) {
  let r = range[i];
  let L = layer[i];
  if (!(r > prm.minRange && L.a > 0.98)) { return; }
  if (prm.hasFg != 0u && fg[i] >= 0.3) { return; }
  let y = i32(i / prm.w);
  let x = i32(i) - y * i32(prm.w);
  var edge = false;
  for (var d = 1; d <= 3; d++) {
    if (sky(x, y - d) || sky(x - d, y) || sky(x + d, y)) { edge = true; }
  }
  if (edge) { return; }
  let px = photo[i];
  let pc = vec3<f32>(lut[px & 255u], lut[(px >> 8u) & 255u], lut[(px >> 16u) & 255u]);
  let a = oklab(pc);
  let b = oklab(L.rgb * (1.0 / L.a));
  let band = select(select(select(3u, 2u, r < 20000.0), 1u, r < 5000.0), 0u, r < 1000.0);
  let o = band * 13u;
  acc[o] += 1.0;
  for (var c = 0u; c < 3u; c++) {
    acc[o + 1u + c] += a[c];
    acc[o + 4u + c] += a[c] * a[c];
    acc[o + 7u + c] += b[c];
    acc[o + 10u + c] += b[c] * b[c];
  }
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(local_invocation_index) lid: u32,
        @builtin(workgroup_id) wid: vec3<u32>, @builtin(subgroup_invocation_id) sid: u32,
        @builtin(subgroup_size) ssz: u32) {
  for (var k = 0u; k < 52u; k++) { acc[k] = 0.0; }
  let n = prm.w * prm.h;
  // the same pixel order per invocation as BAND_STATS (i = gid.x + t·threads)
  for (var base = 0u; base < n; base += prm.threads) {
    let i = base + gid.x;
    if (i < n) { addPixel(i); }
  }
  let sg = lid / ssz;
  // every lane of this subgroup in the same row (rows then map 1:1 to subgroups)
  let ok = subgroupAll(sg == subgroupBroadcastFirst(lid) / ssz);
  // NaN via a var: a const bitcast<f32>(0x7fc00000u) is a WGSL const-eval error
  var nanBits = 0x7fc00000u;
  let nan = bitcast<f32>(nanBits);
  for (var k = 0u; k < 52u; k++) {
    let v = subgroupAdd(acc[k]);
    if (sid == 0u) { sh[sg][k] = select(nan, v, ok); }
  }
  workgroupBarrier();
  if (lid < 52u) {
    var t = 0.0;
    for (var g = 0u; g < (64u + ssz - 1u) / ssz; g++) { t += sh[g][lid]; }
    partial[wid.x * 52u + lid] = t;
  }
}
`;
