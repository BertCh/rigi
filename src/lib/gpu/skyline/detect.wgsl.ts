// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// WGSL for the GPU skyline detector's sky-model fit, model image, Viterbi and column finish: the f32 twins
// of fitSkyModel, modelSky, viterbi and skylineColumnPart in src/lib/geo/skyline.ts (the CPU detector is
// the reference). Every kernel binds the uniform struct S at binding 0 (uniforms.ts SKYLINE_S). Fit
// workgroups write per-workgroup partial sums (no float atomics) that one solve workgroup adds in a fixed
// order. Planar rgb layout as in skyline.wgsl.ts (3·n f32).

const S = /* wgsl */ `
struct S {
  w: u32, h: u32, n: u32, ns: u32,
  below: u32, above: u32, win: u32, nsamp: u32,
  nwg: u32, nx: u32, pad0: u32, pad1: u32,
  edgeW: f32, jc: f32, cap: f32, pad2: f32,
};
@group(0) @binding(0) var<uniform> prm: S;
`;

const SM = /* wgsl */ `
fn sm(a: f32, b: f32, x: f32) -> f32 {
  let t = clamp((x - a) / (b - a), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}
`;

/** Floats in one fit workgroup's partial: 36 (upper triangle of AᵀA) + 24 (Aᵀb, 3 channels) + wsum + r2sum. */
export const SKYLINE_FIT_PARTIAL = 62;
/** Words of the model buffer: coef (3 × 8), sigma, valid, stopped, pad. */
export const SKYLINE_MODEL_WORDS = 32;
/** Fit samples per workgroup. */
export const SKYLINE_FIT_WG = 64;

/** Binding names, in order, of skylineFitAccumSource(seed, first). */
export function skylineFitAccumLayout(seed: boolean, first: boolean) {
	return [
		"prm",
		"rgb",
		"prior",
		...(seed ? [] : ["bound"]),
		...(first ? [] : ["model"]),
		"partials",
	];
}

/**
 * One sample (x, y step 4) per invocation: weight (seed: prior · (1 - y/h)^6; refit: the sky just above the
 * current boundary), the Cauchy reweight against `model` (not on the first iteration), then the 62 products
 * summed over the workgroup in a fixed tree order into partials[workgroup · 62 …].
 */
export function skylineFitAccumSource(seed: boolean, first: boolean) {
	const names = skylineFitAccumLayout(seed, first);
	const decl: Record<string, string> = {
		rgb: "var<storage, read> rgb: array<f32>",
		prior: "var<storage, read> prior: array<f32>",
		bound: "var<storage, read> bound: array<i32>",
		model: "var<storage, read> model: array<f32>",
		partials: "var<storage, read_write> partials: array<f32>",
	};
	const binds = names
		.slice(1)
		.map((n, i) => `@group(0) @binding(${i + 1}) ${decl[n]};`)
		.join("\n");
	const weight = seed
		? `let tt = 1.0 - f32(y) / f32(prm.h);
    let t2 = tt * tt;
    var wt = prior[i] * t2 * t2 * t2;`
		: `let d = bound[x] - i32(y);
    var wt = 0.0;
    if (d > 4) { wt = (0.2 + prior[i]) * select(0.2, 1.0, d < i32(prm.above)); }`;
	const reweight = first
		? ""
		: `var r2 = 0.0;
      for (var c = 0u; c < 3u; c++) {
        var p = 0.0;
        for (var k = 0u; k < 8u; k++) { p += model[c * 8u + k] * phi[k]; }
        let e = ch[c] - p;
        r2 += e * e;
      }
      let sg = model[24];
      wt = wt / (1.0 + r2 / (sg * sg));
      v[61] = wt * r2;`;
	return /* wgsl */ `${S}
${binds}
var<workgroup> sh: array<f32, ${SKYLINE_FIT_PARTIAL * SKYLINE_FIT_WG}>;
@compute @workgroup_size(${SKYLINE_FIT_WG})
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>, @builtin(workgroup_id) wid: vec3<u32>) {
  let t = lid.x;
  var v: array<f32, ${SKYLINE_FIT_PARTIAL}>;
  for (var k = 0u; k < ${SKYLINE_FIT_PARTIAL}u; k++) { v[k] = 0.0; }
  let s = gid.x;
  if (s < prm.nsamp) {
    let x = (s % prm.nx) * 4u;
    let y = (s / prm.nx) * 4u;
    let i = y * prm.w + x;
    ${weight}
    if (wt > 0.0) {
      let u = f32(x) / f32(prm.w) - 0.5;
      let vv = f32(y) / f32(prm.h) - 0.5;
      var phi: array<f32, 8>;
      phi[0] = 1.0; phi[1] = u; phi[2] = vv; phi[3] = u * u; phi[4] = u * vv; phi[5] = vv * vv;
      phi[6] = vv * vv * vv; phi[7] = u * vv * vv;
      var ch: array<f32, 3>;
      ch[0] = rgb[i]; ch[1] = rgb[prm.n + i]; ch[2] = rgb[2u * prm.n + i];
      ${reweight}
      v[60] = wt;
      var idx = 0u;
      for (var j = 0u; j < 8u; j++) {
        for (var k = j; k < 8u; k++) { v[idx] = wt * phi[j] * phi[k]; idx++; }
      }
      for (var c = 0u; c < 3u; c++) {
        for (var j = 0u; j < 8u; j++) { v[36u + c * 8u + j] = wt * phi[j] * ch[c]; }
      }
    }
  }
  for (var k = 0u; k < ${SKYLINE_FIT_PARTIAL}u; k++) { sh[k * ${SKYLINE_FIT_WG}u + t] = v[k]; }
  workgroupBarrier();
  for (var st = ${SKYLINE_FIT_WG / 2}u; st > 0u; st = st >> 1u) {
    if (t < st) {
      for (var k = 0u; k < ${SKYLINE_FIT_PARTIAL}u; k++) {
        sh[k * ${SKYLINE_FIT_WG}u + t] += sh[k * ${SKYLINE_FIT_WG}u + t + st];
      }
    }
    workgroupBarrier();
  }
  if (t < ${SKYLINE_FIT_PARTIAL}u) { partials[wid.x * ${SKYLINE_FIT_PARTIAL}u + t] = sh[t * ${SKYLINE_FIT_WG}u]; }
}
`;
}

/**
 * Sums the fit partials in workgroup order, then one thread runs the ridge + Gaussian elimination with
 * partial pivoting of fitSkyModel's solve (the three right-hand sides together: the pivots depend on the
 * matrix only) and updates `model` (coef, sigma, valid, stopped). `first` (iteration 0) initialises the
 * model and fails (valid 0) when wsum < 20; later iterations keep the previous model and stop updating
 * when wsum < 20, as the CPU returns `{ coef, sigma }` there.
 */
export function skylineFitSolveSource(first: boolean) {
	const gate = first
		? `for (var k = 0u; k < ${SKYLINE_MODEL_WORDS}u; k++) { model[k] = 0.0; }
  model[24] = 0.1;
  let wsum = tot[60];
  if (wsum < 20.0) { model[26] = 1.0; return; }`
		: `if (model[25] < 0.5 || model[26] > 0.5) { return; }
  let wsum = tot[60];
  if (wsum < 20.0) { model[26] = 1.0; return; }`;
	const tail = first
		? "model[25] = 1.0;"
		: "model[24] = clamp(sqrt(tot[61] / wsum), 0.015, 0.05);";
	return /* wgsl */ `${S}
@group(0) @binding(1) var<storage, read> partials: array<f32>;
@group(0) @binding(2) var<storage, read_write> model: array<f32>;
var<workgroup> tot: array<f32, ${SKYLINE_FIT_PARTIAL}>;
@compute @workgroup_size(64)
fn main(@builtin(local_invocation_id) lid: vec3<u32>) {
  let t = lid.x;
  if (t < ${SKYLINE_FIT_PARTIAL}u) {
    var a = 0.0;
    for (var g = 0u; g < prm.nwg; g++) { a += partials[g * ${SKYLINE_FIT_PARTIAL}u + t]; }
    tot[t] = a;
  }
  workgroupBarrier();
  if (t != 0u) { return; }
  ${gate}
  var m: array<f32, 64>;
  var xb: array<f32, 24>;
  var off = 0u;
  for (var j = 0u; j < 8u; j++) {
    for (var k = j; k < 8u; k++) {
      let a = tot[off + k - j];
      m[j * 8u + k] = a;
      m[k * 8u + j] = a;
    }
    off += 8u - j;
    m[j * 8u + j] += 1e-3 * wsum;
    for (var c = 0u; c < 3u; c++) { xb[j * 3u + c] = tot[36u + c * 8u + j]; }
  }
  for (var c = 0u; c < 8u; c++) {
    var p = c;
    for (var r = c + 1u; r < 8u; r++) {
      if (abs(m[r * 8u + c]) > abs(m[p * 8u + c])) { p = r; }
    }
    for (var k = 0u; k < 8u; k++) {
      let tt = m[c * 8u + k]; m[c * 8u + k] = m[p * 8u + k]; m[p * 8u + k] = tt;
    }
    for (var q = 0u; q < 3u; q++) {
      let tt = xb[c * 3u + q]; xb[c * 3u + q] = xb[p * 3u + q]; xb[p * 3u + q] = tt;
    }
    var d = m[c * 8u + c];
    if (d == 0.0) { d = 1e-12; }
    for (var r = c + 1u; r < 8u; r++) {
      let f = m[r * 8u + c] / d;
      for (var k = c; k < 8u; k++) { m[r * 8u + k] -= f * m[c * 8u + k]; }
      for (var q = 0u; q < 3u; q++) { xb[r * 3u + q] -= f * xb[c * 3u + q]; }
    }
  }
  for (var ci = 7; ci >= 0; ci--) {
    let c = u32(ci);
    var dd = m[c * 8u + c];
    if (dd == 0.0) { dd = 1e-12; }
    for (var q = 0u; q < 3u; q++) {
      var s = xb[c * 3u + q];
      for (var k = c + 1u; k < 8u; k++) { s -= m[c * 8u + k] * xb[k * 3u + q]; }
      xb[c * 3u + q] = s / dd;
    }
  }
  for (var c = 0u; c < 3u; c++) {
    for (var j = 0u; j < 8u; j++) { model[c * 8u + j] = xb[j * 3u + c]; }
  }
  ${tail}
}
`;
}

/**
 * modelSky from the fitted model buffer (per-row quadratic in u evaluated inline). With valid = 0 the
 * stage has no model and the output is `fallback` (the heuristic prior for the seed stage, the previous
 * sky for a failed refit), as detectSkyline keeps the earlier sky there.
 */
export const SKYLINE_MODEL_G = /* wgsl */ `${S}${SM}
@group(0) @binding(1) var<storage, read> rgb: array<f32>;
@group(0) @binding(2) var<storage, read> tex: array<f32>;
@group(0) @binding(3) var<storage, read> model: array<f32>;
@group(0) @binding(4) var<storage, read> fallback: array<f32>;
@group(0) @binding(5) var<storage, read_write> sky: array<f32>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= prm.n) { return; }
  if (model[25] < 0.5) { sky[i] = fallback[i]; return; }
  let x = i % prm.w;
  let y = i / prm.w;
  let u = f32(x) / f32(prm.w) - 0.5;
  let v = f32(y) / f32(prm.h) - 0.5;
  var pc: array<f32, 3>;
  for (var c = 0u; c < 3u; c++) {
    let o = c * 8u;
    let a = model[o] + model[o + 2u] * v + model[o + 5u] * v * v + model[o + 6u] * v * v * v;
    let b = model[o + 1u] + model[o + 4u] * v + model[o + 7u] * v * v;
    pc[c] = a + u * (b + u * model[o + 3u]);
  }
  let pr = pc[0];
  let pg = pc[1];
  let pb = pc[2];
  let r = rgb[i];
  let g = rgb[prm.n + i];
  let b = rgb[2u * prm.n + i];
  let dr = r - pr;
  let dg = g - pg;
  let db = b - pb;
  let dl = (dr + dg + db) / 3.0;
  let chroma2 = (dr - dl) * (dr - dl) + (dg - dl) * (dg - dl) + (db - dl) * (db - dl);
  let mx = max(r, max(g, b));
  var sat = 0.0;
  if (mx > 0.0) { sat = (mx - min(r, min(g, b))) / mx; }
  let pmx = max(max(pr, max(pg, pb)), 0.001);
  let psat = (pmx - min(pr, min(pg, pb))) / pmx;
  let sig2 = (2.0 * model[24]) * (2.0 * model[24]);
  var p = exp(-(dl * dl + chroma2) / sig2);
  let grey = sm(0.0, 0.08, psat - sat) * sm(0.45, 0.6, mx);
  if (dl > 0.0) { p = max(p, max(grey, 0.2)); }
  else { p = max(p, grey * (1.0 - sm(0.08, 0.2, -dl))); }
  let green = sm(0.0, 0.06, g - b);
  let smoothTerm = 1.0 - sm(0.03, 0.1, tex[i]);
  sky[i] = p * smoothTerm * (1.0 - green);
}
`;

/**
 * Viterbi unary cost, one invocation per column: prefix sums of (1 - s) and s down the column (cumA / cumB,
 * [y · w + x] so neighbouring columns coalesce), then unary[x · ns + y] for y in [0, h].
 */
export const SKYLINE_UNARY = /* wgsl */ `${S}
@group(0) @binding(1) var<storage, read> sky: array<f32>;
@group(0) @binding(2) var<storage, read> edge: array<f32>;
@group(0) @binding(3) var<storage, read_write> cumA: array<f32>;
@group(0) @binding(4) var<storage, read_write> cumB: array<f32>;
@group(0) @binding(5) var<storage, read_write> unary: array<f32>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let x = gid.x;
  if (x >= prm.w) { return; }
  var a = 0.0;
  var b = 0.0;
  cumA[x] = 0.0;
  cumB[x] = 0.0;
  for (var y = 0u; y < prm.h; y++) {
    let s = sky[y * prm.w + x];
    a += 1.0 - s;
    b += s;
    cumA[(y + 1u) * prm.w + x] = a;
    cumB[(y + 1u) * prm.w + x] = b;
  }
  for (var y = 0u; y <= prm.h; y++) {
    let below = cumB[min(prm.h, y + prm.below) * prm.w + x] - cumB[y * prm.w + x];
    var e = 0.0;
    if (y > 2u && y < prm.h) { e = edge[y * prm.w + x]; }
    var y0 = 0u;
    if (y > prm.above) { y0 = y - prm.above; }
    let c0 = cumA[y0 * prm.w + x];
    let above = cumA[y * prm.w + x] - c0 + 0.2 * c0;
    unary[x * prm.ns + y] = above + below - prm.edgeW * min(e, 0.35);
  }
}
`;

/**
 * Viterbi DP over columns in ONE workgroup (256 threads), then the final argmin and the backtrack by
 * thread 0. Step x: argmin of the previous column (lowest index on ties), then for each y the best of
 * prev[y'] + jc · |y - y'| over y' in [y - win, y + win] (win = ceil(cap / jc): a farther y' can never
 * beat gmin + cap), preferring the nearer y' (left first) on ties, then the truncation gmin + cap.
 * dp holds two columns (ping-pong by x parity), back[x · ns + y] the argmin, bound the result.
 */
export const SKYLINE_DP = /* wgsl */ `${S}
@group(0) @binding(1) var<storage, read> unary: array<f32>;
@group(0) @binding(2) var<storage, read_write> dp: array<f32>;
@group(0) @binding(3) var<storage, read_write> back: array<i32>;
@group(0) @binding(4) var<storage, read_write> bound: array<i32>;
var<workgroup> redV: array<f32, 256>;
var<workgroup> redI: array<u32, 256>;
@compute @workgroup_size(256)
fn main(@builtin(local_invocation_id) lid: vec3<u32>) {
  let t = lid.x;
  let ns = prm.ns;
  let w = prm.w;
  for (var y = t; y < ns; y += 256u) { dp[y] = unary[y]; }
  storageBarrier();
  workgroupBarrier();
  for (var x = 1u; x < w; x++) {
    let pb = ((x - 1u) & 1u) * ns;
    let cb = (x & 1u) * ns;
    var bv = 3.0e38;
    var bi = 0u;
    for (var y = t; y < ns; y += 256u) {
      let v = dp[pb + y];
      if (v < bv) { bv = v; bi = y; }
    }
    redV[t] = bv;
    redI[t] = bi;
    workgroupBarrier();
    for (var st = 128u; st > 0u; st = st >> 1u) {
      if (t < st) {
        let ov = redV[t + st];
        let oi = redI[t + st];
        if (ov < redV[t] || (ov == redV[t] && oi < redI[t])) { redV[t] = ov; redI[t] = oi; }
      }
      workgroupBarrier();
    }
    let gmin = redV[0];
    let garg = redI[0];
    workgroupBarrier();
    for (var y = t; y < ns; y += 256u) {
      var best = dp[pb + y];
      var arg = y;
      for (var d = 1u; d <= prm.win; d++) {
        let cost = prm.jc * f32(d);
        if (y >= d) {
          let c = dp[pb + y - d] + cost;
          if (c < best) { best = c; arg = y - d; }
        }
        if (y + d < ns) {
          let c = dp[pb + y + d] + cost;
          if (c < best) { best = c; arg = y + d; }
        }
      }
      if (gmin + prm.cap < best) { best = gmin + prm.cap; arg = garg; }
      dp[cb + y] = best + unary[x * ns + y];
      back[x * ns + y] = i32(arg);
    }
    storageBarrier();
    workgroupBarrier();
  }
  if (t == 0u) {
    let fb = ((w - 1u) & 1u) * ns;
    var best = 3.0e38;
    var arg = 0u;
    for (var y = 0u; y < ns; y++) {
      let v = dp[fb + y];
      if (v < best) { best = v; arg = y; }
    }
    bound[w - 1u] = i32(arg);
    for (var x = w - 1u; x > 0u; x--) {
      arg = u32(back[x * ns + arg]);
      bound[x - 1u] = i32(arg);
    }
  }
}
`;

/**
 * skylineColumnPart per column: out[x] = row (bits of an f32, NaN when the column has no usable boundary),
 * out[w + x] = raw weight. NaN is written as its u32 bit pattern, so no float NaN passes through the
 * shader compiler.
 */
export const SKYLINE_COLUMN = /* wgsl */ `${S}${SM}
@group(0) @binding(1) var<storage, read> sky: array<f32>;
@group(0) @binding(2) var<storage, read> edge: array<f32>;
@group(0) @binding(3) var<storage, read> stp: array<f32>;
@group(0) @binding(4) var<storage, read> bound: array<i32>;
@group(0) @binding(5) var<storage, read_write> out: array<u32>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let x = gid.x;
  if (x >= prm.w) { return; }
  let w = prm.w;
  let win = 12u;
  let yb = bound[x];
  out[x] = 0x7fc00000u;
  out[w + x] = 0u;
  if (yb < i32(win) + 2 || yb > i32(prm.h) - i32(win)) { return; }
  let y = u32(yb);
  let e0 = edge[(y - 1u) * w + x];
  let e1 = edge[y * w + x];
  let e2 = edge[(y + 1u) * w + x];
  let den = e0 - 2.0 * e1 + e2;
  var dy = 0.0;
  if (den < 0.0) { dy = clamp(0.5 * (e0 - e2) / den, -0.5, 0.5); }
  out[x] = bitcast<u32>(f32(yb) + dy);
  var sAbove = 0.0;
  var sBelow = 0.0;
  for (var j = 3u; j < win + 3u; j++) {
    sAbove += sky[(y - j) * w + x];
    sBelow += sky[min(prm.h - 1u, y + j - 2u) * w + x];
  }
  sAbove = sAbove / f32(win);
  sBelow = sBelow / f32(win);
  let contrast = sm(0.03, 0.15, e1);
  let polarity = 0.2 + 0.8 * sm(-0.02, 0.03, stp[y * w + x]);
  out[w + x] = bitcast<u32>(contrast * polarity * sm(0.3, 0.8, sAbove) * (1.0 - sBelow));
}
`;

/** The final sky plane as bytes, round(clamp01(s) · 255), four pixels per u32 (little endian). */
export const SKYLINE_PACK = /* wgsl */ `${S}
@group(0) @binding(1) var<storage, read> sky: array<f32>;
@group(0) @binding(2) var<storage, read_write> packed: array<u32>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let j = gid.x;
  if (j * 4u >= prm.n) { return; }
  var word = 0u;
  for (var b = 0u; b < 4u; b++) {
    let i = j * 4u + b;
    if (i < prm.n) { word |= u32(floor(clamp(sky[i], 0.0, 1.0) * 255.0 + 0.5)) << (8u * b); }
  }
  packed[j] = word;
}
`;
