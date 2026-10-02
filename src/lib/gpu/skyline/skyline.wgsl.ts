// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// WGSL for the GPU skyline cost images: the per-pixel stages of src/lib/geo/skyline.ts (computeFeatures,
// heuristicSky, modelSky) in f32, one pixel (or one pixel-channel) per invocation. The CPU twin is the
// reference and runs in f64 over f32 images; these differ at f32 rounding level only (see README.md).
// Planar layouts: three-channel images are 3·n f32 (R plane, G plane, B plane).

const PARAMS = /* wgsl */ `
struct P { w: u32, h: u32, n: u32, pad: u32, sigma: f32, p1: f32, p2: f32, p3: f32 };
@group(0) @binding(0) var<uniform> prm: P;
`;

const SM = /* wgsl */ `
fn sm(a: f32, b: f32, x: f32) -> f32 {
  let t = clamp((x - a) / (b - a), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}
`;

/** rgba words → p0, the planar r/g/b bytes / 255. */
export const SKYLINE_UNPACK = /* wgsl */ `${PARAMS}
@group(0) @binding(1) var<storage, read> rgba: array<u32>;
@group(0) @binding(2) var<storage, read_write> p0: array<f32>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= prm.n) { return; }
  let v = rgba[i];
  p0[i] = f32(v & 255u) / 255.0;
  p0[prm.n + i] = f32((v >> 8u) & 255u) / 255.0;
  p0[2u * prm.n + i] = f32((v >> 16u) & 255u) / 255.0;
}
`;

/** Box blur of `nc` planes along x or y, radius `r`, clamped edges (CPU boxBlur / boxBlurH). */
export function skylineBlurSource(axis: "x" | "y", r: number, nc: number) {
	const tap =
		axis === "x"
			? "let xx = clamp(x + d, 0, w - 1); acc += src[base + u32(y * w + xx)];"
			: "let yy = clamp(y + d, 0, h - 1); acc += src[base + u32(yy * w + x)];";
	return /* wgsl */ `${PARAMS}
@group(0) @binding(1) var<storage, read> src: array<f32>;
@group(0) @binding(2) var<storage, read_write> dst: array<f32>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let idx = gid.x;
  if (idx >= ${nc}u * prm.n) { return; }
  let c = idx / prm.n;
  let p = idx % prm.n;
  let w = i32(prm.w);
  let h = i32(prm.h);
  let x = i32(p % prm.w);
  let y = i32(p / prm.w);
  let base = c * prm.n;
  var acc = 0.0;
  for (var d = -${r}; d <= ${r}; d++) {
    ${tap}
  }
  dst[idx] = acc / ${2 * r + 1}.0;
}
`;
}

/** Blurred-luminance gradient magnitude (border pixels 0). */
export const SKYLINE_GRAD = /* wgsl */ `${PARAMS}
@group(0) @binding(1) var<storage, read> rgb: array<f32>;
@group(0) @binding(2) var<storage, read_write> grad: array<f32>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= prm.n) { return; }
  let x = i % prm.w;
  let y = i / prm.w;
  if (x < 1u || y < 1u || x + 1u >= prm.w || y + 1u >= prm.h) { grad[i] = 0.0; return; }
  let n = prm.n;
  let w = prm.w;
  let lx = 0.3 * (rgb[i + 1u] - rgb[i - 1u]) + 0.59 * (rgb[n + i + 1u] - rgb[n + i - 1u]) + 0.11 * (rgb[2u * n + i + 1u] - rgb[2u * n + i - 1u]);
  let ly = 0.3 * (rgb[i + w] - rgb[i - w]) + 0.59 * (rgb[n + i + w] - rgb[n + i - w]) + 0.11 * (rgb[2u * n + i + w] - rgb[2u * n + i - w]);
  grad[i] = sqrt(lx * lx + ly * ly);
}
`;

/** Vertical colour step (3 rows above vs 3 rows at/below, on the 5-column blur `cs`): edge and signed step. */
export const SKYLINE_EDGE = /* wgsl */ `${PARAMS}
@group(0) @binding(1) var<storage, read> cs: array<f32>;
@group(0) @binding(2) var<storage, read_write> edge: array<f32>;
@group(0) @binding(3) var<storage, read_write> stp: array<f32>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= prm.n) { return; }
  let x = i % prm.w;
  let y = i / prm.w;
  if (y < 3u || y + 3u >= prm.h) { edge[i] = 0.0; stp[i] = 0.0; return; }
  var d2 = 0.0;
  var dl = 0.0;
  for (var c = 0u; c < 3u; c++) {
    var up = 0.0;
    var dn = 0.0;
    let base = c * prm.n;
    for (var j = 1u; j <= 3u; j++) {
      up += cs[base + (y - j) * prm.w + x];
      dn += cs[base + (y + j - 1u) * prm.w + x];
    }
    let d = (up - dn) / 3.0;
    d2 += d * d;
    var lw = 0.11;
    if (c == 0u) { lw = 0.3; } else if (c == 1u) { lw = 0.59; }
    dl += lw * d;
  }
  stp[i] = dl;
  edge[i] = sqrt(d2) * select(0.4, 1.0, dl > 0.0);
}
`;

/** heuristicSky. */
export const SKYLINE_PRIOR = /* wgsl */ `${PARAMS}${SM}
@group(0) @binding(1) var<storage, read> rgb: array<f32>;
@group(0) @binding(2) var<storage, read> tex: array<f32>;
@group(0) @binding(3) var<storage, read_write> prior: array<f32>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= prm.n) { return; }
  let r = rgb[i];
  let g = rgb[prm.n + i];
  let b = rgb[2u * prm.n + i];
  let l = 0.3 * r + 0.59 * g + 0.11 * b;
  let mx = max(r, max(g, b));
  let mn = min(r, min(g, b));
  var sat = 0.0;
  if (mx > 0.0) { sat = (mx - mn) / mx; }
  let t = tex[i];
  let blue = sm(0.02, 0.12, b - r) * sm(-0.02, 0.04, b - g);
  let blueSky = blue * sm(0.15, 0.4, l);
  let cloud = sm(0.5, 0.7, l) * (1.0 - sm(0.15, 0.3, sat)) * (1.0 - sm(0.04, 0.12, t));
  let green = sm(0.0, 0.06, g - b);
  let smoothTerm = 1.0 - sm(0.015, 0.05, t);
  prior[i] = max(blueSky * smoothTerm, cloud) * (1.0 - green);
}
`;

/** modelSky: `rows` is h × 9 f32, the per-row quadratic in u for r, g, b (a, b, q each; CPU rowPoly in f64). */
export const SKYLINE_MODEL = /* wgsl */ `${PARAMS}${SM}
@group(0) @binding(1) var<storage, read> rgb: array<f32>;
@group(0) @binding(2) var<storage, read> tex: array<f32>;
@group(0) @binding(3) var<storage, read> rows: array<f32>;
@group(0) @binding(4) var<storage, read_write> sky: array<f32>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= prm.n) { return; }
  let x = i % prm.w;
  let y = i / prm.w;
  let u = f32(x) / f32(prm.w) - 0.5;
  let o = y * 9u;
  let pr = rows[o] + u * (rows[o + 1u] + u * rows[o + 2u]);
  let pg = rows[o + 3u] + u * (rows[o + 4u] + u * rows[o + 5u]);
  let pb = rows[o + 6u] + u * (rows[o + 7u] + u * rows[o + 8u]);
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
  let sig2 = (2.0 * prm.sigma) * (2.0 * prm.sigma);
  var p = exp(-(dl * dl + chroma2) / sig2);
  let grey = sm(0.0, 0.08, psat - sat) * sm(0.45, 0.6, mx);
  if (dl > 0.0) { p = max(p, max(grey, 0.2)); }
  else { p = max(p, grey * (1.0 - sm(0.08, 0.2, -dl))); }
  let green = sm(0.0, 0.06, g - b);
  let smoothTerm = 1.0 - sm(0.03, 0.1, tex[i]);
  sky[i] = p * smoothTerm * (1.0 - green);
}
`;
