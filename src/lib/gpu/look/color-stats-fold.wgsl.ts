// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// WGSL of the band-stats tail on the GPU (color-stats-fold.ts): finalizeBands (color-stats.ts; keep in
// sync) over the 52 folded sums, in float32. Per band: count, Σp(3), Σp²(3), Σl(3), Σl²(3) (13 values,
// BAND_STATS' layout) → means, floored stds and the empty-band back-fill (nearest trusted band, lower
// first). One invocation per band.
//
// Output: STATS_WORDS f32 words (STATS_LAYOUT offsets), the ColorStats CompositeLook.stats holds:
//   [0..3] count per band (exact integers in f32), [4] valid (1 / 0; -1 = the subgroup layout check of
//   BAND_STATS_SG failed: the sums are garbage, re-run without subgroups), [8..19] photoMean,
//   [20..31] photoStd, [32..43] layerMean, [44..55] layerStd (band-major, 3 per band), rest 0.
// When valid is not 1 the means / stds are identityStats' (0 / 1), as finalizeBands returns them.

/** f32 words of the folded ColorStats (256 B). */
export const STATS_WORDS = 64;
/** Word offsets in the folded ColorStats. */
export const STATS_LAYOUT = {
	count: 0,
	valid: 4,
	photoMean: 8,
	photoStd: 20,
	layerMean: 32,
	layerStd: 44,
} as const;

export const BAND_FINALIZE = /* wgsl */ `
// BAND_STATS' parameters plus minCount (one uniform shared by both nodes)
struct P { w: u32, h: u32, threads: u32, hasFg: u32, minRange: f32, minCount: u32 };
@group(0) @binding(0) var<uniform> prm: P;
@group(0) @binding(1) var<storage, read> folded: array<f32>;
@group(0) @binding(2) var<storage, read_write> outv: array<f32>;

const N_BANDS = 4u;

fn trusted(b: u32) -> bool { return folded[b * 13u] >= f32(prm.minCount); }

@compute @workgroup_size(4)
fn main(@builtin(local_invocation_index) k: u32) {
  var anyOk = false;
  var broken = false;
  for (var b = 0u; b < N_BANDS; b++) {
    anyOk = anyOk || trusted(b);
    // BAND_STATS_SG's failure marker (-1e20 per value) makes the folded count negative
    broken = broken || folded[b * 13u] < 0.0;
  }
  let valid = anyOk && !broken;
  outv[k] = select(folded[k * 13u], 0.0, broken);
  if (k == 0u) {
    outv[4] = select(select(0.0, 1.0, valid), -1.0, broken);
    for (var i = 5u; i < 8u; i++) { outv[i] = 0.0; }
    for (var i = 56u; i < 64u; i++) { outv[i] = 0.0; }
  }
  // the nearest trusted band (lower first at equal distance), as finalizeBands
  var src = k;
  if (!trusted(k)) {
    for (var dk = 1u; dk < N_BANDS; dk++) {
      if (k >= dk && trusted(k - dk)) { src = k - dk; break; }
      if (k + dk < N_BANDS && trusted(k + dk)) { src = k + dk; break; }
    }
  }
  let o = src * 13u;
  let n = folded[o];
  for (var c = 0u; c < 3u; c++) {
    let pm = folded[o + 1u + c] / n;
    let lm = folded[o + 7u + c] / n;
    let lo = select(0.004, 0.01, c == 0u);
    let ps = max(lo, sqrt(max(0.0, folded[o + 4u + c] / n - pm * pm)));
    let ls = max(lo, sqrt(max(0.0, folded[o + 10u + c] / n - lm * lm)));
    let j = k * 3u + c;
    outv[8u + j] = select(0.0, pm, valid);
    outv[20u + j] = select(1.0, ps, valid);
    outv[32u + j] = select(0.0, lm, valid);
    outv[44u + j] = select(1.0, ls, valid);
  }
}
`;
