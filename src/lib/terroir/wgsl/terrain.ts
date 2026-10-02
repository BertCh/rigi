// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// WGSL port of the terroir terrain shading (../glsl/terrain.ts is the reference; same four switches, same
// values from ../glsl/values.ts) for deck-webgpu/layers/terrain-styles.ts. Everything terroir-specific
// lives here; deck-webgpu only gains small hooks that return its own string / object UNCHANGED while
// every switch is off (so the generated WGSL and the uniform layout are byte-identical to before:
// scripts/terroir/wgsl-identity-snap.ts).
//
//   TERROIR_COVER             terCover    class albedo + texture + organic edges (lit styles); on imagery
//                                         steep faces cross-fade to the class rendering
//   TERROIR_PATTERN           terPattern  scree dots, rock hatching, glacier hatching over the class albedo
//   TERROIR_SNOW              terSnow     date snowline, aspect offset, slope shedding (lit styles)
//   TERROIR_CONTOUR_INK       terInk      contour ink by class, no lines on water (contours, not Tanaka)
//   TERROIR_CONTOUR_ADAPTIVE  terAdaptive nested contour levels by range (contours, not Tanaka)
//
// WGSL differences: the cover is sampled with textureSampleLevel (legal in any control flow, nearest);
// fwidth(elev) is TerrainSample.dElev and fwidth(xy) is |dEnuDx.xy| + |dEnuDy.xy|; the Swiss index is a
// uniform override (terrainStyle.contourMajorEvery) and never changes a program. LOOK_WATER wins on
// water: ter_albedo leaves class 12 alone when `water` is set (it wraps ts_water_shade, as in WebGL).
import type { ShaderModule } from "@luma.gl/shadertools";
import { TER_BLOCK } from "../glsl/terrain";
import type { TerroirShader } from "../glsl/values";
import { HATCH_INK, HATCH_WGSL } from "../hatch";
import { PATTERN_KERNEL_WGSL, PATTERN_WGSL } from "../pattern";

export type TerroirFeatures = {
	terCover?: boolean;
	/** TERROIR_PATTERN: pattern fills on the class albedo (implies terCover) */
	terPattern?: boolean;
	/** TERROIR_HATCH: slope-driven rock hatching + scree dots (hillshade only, no pack needed) */
	terHatch?: boolean;
	terSnow?: boolean;
	terInk?: boolean;
	terAdaptive?: boolean;
};

const WGSL_TYPE = {
	float: "f32",
	vec2: "vec2<f32>",
	vec3: "vec4<f32>",
	vec4: "vec4<f32>",
	mat4: "mat4x4<f32>",
} as const;

const FIELDS = Object.entries(TER_BLOCK.fields) as [
	string,
	keyof typeof WGSL_TYPE,
][];

/** The TER_BLOCK uniforms as a luma module (vec3 → vec4, like TER_BLOCK.pack). */
export const terroirUniformModule = {
	name: "terroir",
	source: `struct TerroirUniforms {\n${FIELDS.map(([k, t]) => `  ${k}: ${WGSL_TYPE[t]},`).join("\n")}\n};\n@group(0) @binding(auto) var<uniform> terroir: TerroirUniforms;\n`,
	uniformTypes: Object.fromEntries(FIELDS.map(([k, t]) => [k, WGSL_TYPE[t]])),
	bindingLayout: [{ name: "terroir", group: 0 }],
} as unknown as ShaderModule;

const isLit = (style: string) => style === "hillshade" || style === "imagery";

/**
 * The terroir features a style program compiles in. `{}` (no keys) when there is nothing, so the
 * caller's feature object (and the pipeline key built from its truthy keys) is unchanged.
 */
export function terroirFeatures(
	style: string,
	t: TerroirShader | null | undefined,
	tanaka: boolean,
): TerroirFeatures {
	if (!t?.defines.length) return {};
	const d = new Set<string>(t.defines);
	const lit = isLit(style);
	const lines = style === "contours" && !tanaka;
	const out: TerroirFeatures = {};
	if (lit && d.has("TERROIR_COVER") && t.grid) out.terCover = true;
	if (out.terCover && d.has("TERROIR_PATTERN")) out.terPattern = true;
	if (style === "hillshade" && d.has("TERROIR_HATCH")) out.terHatch = true;
	if (lit && d.has("TERROIR_SNOW") && t.grid) out.terSnow = true;
	if (lines && d.has("TERROIR_CONTOUR_INK") && t.grid) out.terInk = true;
	if (lines && d.has("TERROIR_CONTOUR_ADAPTIVE")) out.terAdaptive = true;
	return out;
}

/** Does the program sample the cover texture (needs the binding)? */
export const terroirNeedsCover = (ft: TerroirFeatures) =>
	!!(ft.terCover || ft.terSnow || ft.terInk);
export const terroirOn = (ft: TerroirFeatures) =>
	!!(ft.terCover || ft.terSnow || ft.terInk || ft.terAdaptive || ft.terHatch);

/** `base` (an albedo expression) wrapped in the cover / snow albedo; `base` itself when off. */
export function terroirAlbedoExpr(ft: TerroirFeatures, base: string) {
	return ft.terCover || ft.terSnow || ft.terHatch
		? `ter_albedo(${base}, n, s)`
		: base;
}

/** Imagery: the class rendering replaces the orthophoto on steep faces; `shaded` = the style's lit colour. */
export function terroirSteepStmt(ft: TerroirFeatures, shaded: string) {
	return ft.terCover
		? `    base = mix(base, ${shaded}, ter_steep(s.normal, s.enu.xy));\n`
		: "";
}

/** The contours program's tail with the terroir lines (replaces the classic tail). */
export const TERROIR_CONTOUR_TAIL = /* wgsl */ `\
  let minorCol = to_linear(terrainStyle.contourMinorCol.rgb);
  let majorCol = to_linear(terrainStyle.contourMajorCol.rgb);
  let terC = ter_contour(s, near, dist, minorCol, majorCol);
  return ts_premul(terC.rgb, terC.a * terrainStyle.contourOpacity);
`;

/** The shared WGSL for a feature set (empty when nothing is on). `relief` / `water`: the style's LOOK_RELIEF / LOOK_WATER. */
export function terroirWGSL(
	ft: TerroirFeatures,
	opt: { relief: boolean; water: boolean },
): string {
	if (!terroirOn(ft)) return "";
	const cover = terroirNeedsCover(ft);
	const parts: string[] = [];
	parts.push(/* wgsl */ `\
// ---- terroir (src/lib/terroir/wgsl/terrain.ts) ----
fn ter_hash(p: vec2<f32>) -> f32 {
  var p3 = fract(vec3<f32>(p.x, p.y, p.x) * 0.1031);
  p3 += dot(p3, p3.yzx + vec3<f32>(33.33));
  return fract((p3.x + p3.y) * p3.z);
}
fn ter_noise(p: vec2<f32>) -> f32 {
  let i = floor(p);
  var f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(ter_hash(i), ter_hash(i + vec2<f32>(1.0, 0.0)), f.x), mix(ter_hash(i + vec2<f32>(0.0, 1.0)), ter_hash(i + vec2<f32>(1.0, 1.0)), f.x), f.y);
}
fn ter_fbm(p: vec2<f32>) -> f32 {
  return 0.55 * ter_noise(p) + 0.3 * ter_noise(p * 2.13 + vec2<f32>(7.1)) + 0.15 * ter_noise(p * 4.37 - vec2<f32>(3.3));
}
`);
	if (cover)
		parts.push(/* wgsl */ `\
@group(0) @binding(auto) var terroirCover: texture_2d<f32>; // r8unorm class ids, nearest
@group(0) @binding(auto) var terroirCoverSampler: sampler;

// cover class at ENU (x, y): nearest texel, 0 outside the pack; domain-warped so 25 m cells read as organic edges
fn ter_class(xy: vec2<f32>) -> i32 {
  let w = (vec2<f32>(ter_noise(xy / 70.0), ter_noise(xy / 70.0 + vec2<f32>(17.3))) - vec2<f32>(0.5)) * 44.0
    + (vec2<f32>(ter_noise(xy / 19.0 + vec2<f32>(5.1)), ter_noise(xy / 19.0 - vec2<f32>(9.7))) - vec2<f32>(0.5)) * 16.0;
  let q = xy + w;
  let b = vec4<f32>(1.0, q.x, q.y, q.x * q.y);
  let q2 = q * q;
  let uv = vec2<f32>(dot(terroir.uvU, b) + dot(terroir.uvQ.xy, q2), dot(terroir.uvV, b) + dot(terroir.uvQ.zw, q2));
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > terroir.cover.w || uv.y > 1.0) { return 0; }
  return i32(textureSampleLevel(terroirCover, terroirCoverSampler, uv, 0.0).r * 255.0 + 0.5);
}
fn ter_pal(c: i32) -> vec4<f32> {
  let j = c - (c / 4) * 4;
  if (c < 4) { return terroir.pal0[j]; }
  if (c < 8) { return terroir.pal1[j]; }
  if (c < 12) { return terroir.pal2[j]; }
  return terroir.pal3[j];
}
fn ter_ink(c: i32) -> vec3<f32> {
  let k = ter_pal(c).a;
  if (k > 1.5) { return terroir.inkIce.rgb; }
  if (k > 0.5) { return terroir.inkRock.rgb; }
  return terroir.inkSoil.rgb;
}
`);
	if (ft.terInk || ft.terAdaptive)
		parts.push(/* wgsl */ `\
// ---- contours: nested levels thinned with range, ink by cover ----
fn ter_line(e: f32, fw: f32, widthPx: f32) -> f32 {
  let d = abs(fract(e - 0.5) - 0.5) / max(fw, 1e-6);
  return 1.0 - smoothstep(widthPx * 0.5, widthPx * 0.5 + 1.0, d);
}
// (line, casing) of interval iv (m); fwE = metres of elevation per pixel (continuous across levels)
fn ter_lines(elev: f32, fwE: f32, iv: f32, widthPx: f32, casingPx: f32, dens: vec2<f32>) -> vec2<f32> {
  let e = elev / iv;
  let fw = fwE / iv;
  let f = 1.0 - smoothstep(dens.x, dens.y, fw);
  return vec2<f32>(ter_line(e, fw, widthPx), ter_line(e, fw, widthPx + casingPx)) * f;
}
// vec4(minor, major, minor casing, major casing)
fn ter_contour_a(elev: f32, fwE: f32, range: f32, minorIv: f32, majorIv: f32, w: f32, wMajor: f32, casingPx: f32, dens0: vec4<f32>) -> vec4<f32> {
  var dens = dens0;
  var m0 = minorIv;
  var m1 = minorIv;
  var j0 = majorIv;
  var j1 = majorIv;
  var t = 0.0;
${
	ft.terAdaptive
		? /* wgsl */ `\
  // level k up to boundary k (± the band), then k + 1: the lines that k + 1 drops fade out over the band
  var ad = terroir.adapt;
  var k = 0;
  for (var i = 0; i < 3; i++) {
    let b = ad[i];
    if (b <= 0.0) { break; }
    let hi = b * (1.0 + ad.w);
    if (range >= hi) {
      k = i + 1;
    } else {
      t = smoothstep(b * (1.0 - ad.w), hi, range);
      break;
    }
  }
  var mi = vec4<f32>(minorIv, terroir.minorLv.x, terroir.minorLv.y, terroir.minorLv.z);
  var ma = vec4<f32>(majorIv, terroir.majorLv.x, terroir.majorLv.y, terroir.majorLv.z);
  m0 = mi[k];
  j0 = ma[k];
  m1 = mi[min(k + 1, 3)];
  j1 = ma[min(k + 1, 3)];
  // a stricter screen density for the minor lines: none closer than ~10 px
  dens = vec4<f32>(dens.xy * 0.65, dens.zw);
`
		: ""
}  let a0 = ter_lines(elev, fwE, m0, w, casingPx, dens.xy);
  let a1 = ter_lines(elev, fwE, m1, w, casingPx, dens.xy);
  let b0 = ter_lines(elev, fwE, j0, wMajor, casingPx, dens.zw);
  let b1 = ter_lines(elev, fwE, j1, wMajor, casingPx, dens.zw);
  let mn = max(a0 * (1.0 - t), a1);
  let mj = max(b0 * (1.0 - t), b1);
  return vec4<f32>(mn.x, mj.x, mn.y, mj.y);
}
// the classic style-2 contour with the terroir options: linear rgb + straight alpha before contourOpacity
fn ter_contour(s: TerrainSample, near: f32, dist: f32, minorCol: vec3<f32>, majorCol: vec3<f32>) -> vec4<f32> {
  let fadeMix = dist * near;
  let casing = terrainStyle.casing;
  let A = ter_contour_a(s.elev, s.dElev, s.range, terrainStyle.contourInterval, terrainStyle.contourInterval * terrainStyle.contourMajorEvery,
    terrainStyle.contourWidth, terrainStyle.contourWidth * terrainStyle.contourMajorMul, casing.y, terrainStyle.densityFade);
  var lc = ts_line_ramp(ts_elev_t(s.elev));
  if (terrainStyle.contourSolid > 0.5) {
    lc = select(minorCol, majorCol, A.y * terrainStyle.majorAlpha >= A.x * terrainStyle.minorAlpha);
  }
  let a = max(A.x * terrainStyle.minorAlpha, A.y * terrainStyle.majorAlpha) * fadeMix;
${
	ft.terInk
		? /* wgsl */ `\
  let c = ter_class(s.enu.xy);
  // lakes keep their own symbology
  if (c == 12) { return vec4<f32>(0.0); }
  if (c > 0) { lc = ter_ink(c); }
`
		: ""
}  if (casing.x > 0.5) {
    let cs = max(A.z * casing.z, A.w) * fadeMix;
    return vec4<f32>(mix(terrainStyle.casingCol.rgb, lc, a / max(cs, 1e-3)), max(a, cs * casing.w));
  }
  return vec4<f32>(lc, a);
}
`);
	if (ft.terCover || ft.terSnow || ft.terHatch)
		parts.push(/* wgsl */ `\
// ---- cover albedo, snow, warm light / cool shade ----
${
	ft.terCover || ft.terSnow
		? /* wgsl */ `\
// px = ground metres per pixel: detail fades before it aliases. The noise domain leans with the
// height, so cliffs get texture across the face instead of vertical streaks.
fn ter_cover_albedo(c: i32, p: vec2<f32>, px: f32, elev: f32) -> vec3<f32> {
  let base = ter_pal(c).rgb;
  let xy = p + vec2<f32>(0.71, -0.71) * elev;
  let fine = 1.0 - smoothstep(3.0, 14.0, px);
  let mid = 1.0 - smoothstep(40.0, 160.0, px);
  var v = 0.0;
  if (c >= 5 && c <= 7) {
    v = (ter_noise(xy / 5.0) - 0.5) * 0.55 * fine + (ter_fbm(xy / 80.0) - 0.5) * 0.45 * mid;
  } else if (c == 4) {
    v = ${ft.terPattern ? "" : "(ter_hash(floor(xy / 3.0)) - 0.5) * 0.5 * fine + "}(ter_fbm(xy / 60.0) - 0.5) * 0.25 * mid;
  } else if (c == 3) {
    v = (ter_noise(xy / 8.0) - 0.5) * 0.25 * fine + (ter_fbm(xy / 40.0) - 0.5) * 0.35 * mid;
  } else if (c >= 8 && c != 12 && c != 13) {
    v = (ter_fbm(xy / 220.0) - 0.5) * 0.2;
  } else if (c <= 2) {
    v = (ter_fbm(xy / 150.0) - 0.5) * 0.06;
  }
  return base * max(1.0 + v * terroir.cover.y, 0.0);
}
fn ter_snow(elev: f32, n: vec3<f32>, slopeDeg: f32, xy: vec2<f32>) -> f32 {
  let sl = length(n.xy);
  let north = select(0.0, n.y / max(sl, 1e-6), sl > 1e-4);
  let line = terroir.snow.x - terroir.snow.y * north * smoothstep(0.03, 0.25, sl) + (ter_fbm(xy / 700.0) - 0.5) * 260.0;
  let above = smoothstep(line - 120.0, line + 160.0, elev);
  let shed = 1.0 - smoothstep(terroir.snow.z, terroir.snow.w, slopeDeg + (ter_noise(xy / 50.0) - 0.5) * 10.0);
  return above * shed * terroir.snowCol.a;
}
`
		: ""
}${ft.terPattern ? PATTERN_WGSL : ft.terHatch ? PATTERN_KERNEL_WGSL : ""}${ft.terHatch ? HATCH_WGSL : ""}// fb = the look's albedo (alpine belts or the relief ramp) where there is no class
fn ter_albedo(fb: vec3<f32>, n: vec3<f32>, s: TerrainSample) -> vec3<f32> {
  let xy = s.enu.xy;
  let px = max(length(abs(s.dEnuDx.xy) + abs(s.dEnuDy.xy)), 1e-3);
${ft.terPattern || ft.terHatch ? "  let patFw = abs(s.dEnuDx.xy) + abs(s.dEnuDy.xy);\n" : ""}${ft.terPattern ? "  let patLit = dot(n, fog.sun.xyz);\n" : ""}  let slopeDeg = degrees(acos(clamp(n.z, -1.0, 1.0)));
  var col = fb;
  var c = 0;
${
	ft.terCover
		? `  c = ter_class(xy);\n  if (c > 0${opt.water ? " && c != 12" : ""}) { col = mix(fb, ${ft.terPattern ? "ter_pattern_cover(c, xy, ter_cover_albedo(c, xy, px, s.elev), patFw, patLit)" : "ter_cover_albedo(c, xy, px, s.elev)"}, terroir.cover.x); }\n`
		: ""
}${ft.terHatch ? `  col = mix(col, col * vec3<f32>(${HATCH_INK}), ter_hatch(n, xy, s.elev, patFw, s.dElev, c));\n` : ""}${ft.terSnow ? "  if (c != 12) { col = mix(col, terroir.snowCol.rgb, ter_snow(s.elev, n, slopeDeg, xy)); }\n" : ""}${
	opt.relief
		? "  // the Swiss relief already splits warm light / cool shade\n  return col;\n"
		: `  // Imhof: warm light, cool shade, from the look's sun
  let lit = dot(n, fog.sun.xyz);
  return col * mix(vec3<f32>(0.9, 0.95, 1.07), vec3<f32>(1.04, 1.0, 0.94), smoothstep(-0.05, 0.45, lit));
`
}}
`);
	if (ft.terCover)
		parts.push(/* wgsl */ `\
// imagery: how much of the class rendering replaces the orthophoto (steep faces, where it smears)
fn ter_steep(n: vec3<f32>, xy: vec2<f32>) -> f32 {
  let c = ter_class(xy);
  if (c > 0 && c != 12) { return (1.0 - smoothstep(0.3, 0.55, n.z)) * terroir.cover.z; }
  return 0.0;
}
`);
	return parts.join("");
}
