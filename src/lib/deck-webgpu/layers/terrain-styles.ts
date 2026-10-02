// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// WGSL port of the terrain styles (README.md "Ports": layers/terrain-styles.ts). Plugs into
// TerrainCore (and the batched terrain port) through the TerrainShaderPart seam, without editing it:
//
//   const styles = new TerrainStyles(device, {style: "contours", look, contourInterval: 50});
//   core.look = styles.terrainLook(elevRange, haze);   // relief ramp, elevRange, fog, nearDiscard
//   styles.applyTo(core, [...drapePlugins]);          // = core.setShaderParts(styles.shading,
//                                                     //     [...drapePlugins, styles.finish?])
//   // on every style / settings change: if (styles.set({...})) styles.applyTo(core, plugins);
//   //                                   core.look = styles.terrainLook(...)
//
// Source (WebGL, the reference): deck/terrain-layer.ts `fs` (styles 0 hillshade, 1 imagery,
// 2 contours, 4 elevation bands, 5 slope, 6 slopeClass) with look/glsl/{ramps, relief,
// atmosphere, composite} for LOOK_ALPINE / LOOK_TANAKA / LOOK_SLOPE / LOOK_RELIEF /
// LOOK_ATMOSPHERE / LOOK_HARMONIZE. Uniform values: style/deck-apply.ts deckTerrainStyle, exactly
// as setTerrainShaderProps fills them.
//
// What moved where:
//   - the style is a PIPELINE choice here (one generated terrain_base per style + look defines;
//     key = `terrain-styles|<style>|<defines>`), not a runtime uniform: it decides TERRAIN_NO_FOG,
//     and luma's WGSL preprocessor has no #if ==. A style change rebuilds the colour pipeline only.
//   - style 3 (geometry range) and 7 (normal pass) are gone: the geometry MRT covers them.
//   - derivatives come from TerrainSample (WGSL uniformity): fwidth(elev / I) = s.dElev / I,
//     the face normal = cross(s.dEnuDx, s.dEnuDy), fwidth(xy) = |dEnuDx.xy| + |dEnuDy.xy|,
//     imagery = s.img / s.imgAvg (textureLod 3). The one derivative with no TerrainSample field
//     (slopeClass: fwidth of the slope angle) is taken at the TOP of terrain_base, which the core
//     calls in uniform control flow, before any branch or discard.
//   - contours, bands and slopeClass (alpha < 1) return PREMULTIPLIED colour and set
//     TERRAIN_NO_FOG (the WebGL path never hazed them); the slope debug style hazes itself
//     (range · 0.3) and sets TERRAIN_NO_FOG too.
//   - LOOK_ATMOSPHERE replaces the haze with the physical aerial perspective in a trailing plugin
//     (`finish`, TERRAIN_NO_FOG set), so the photo drape (layers/drape.ts plugins, which WebGL mixed
//     in BEFORE the haze) still gets hazed: plugins = [...drape, finish]. Its eye is camera.eye
//     (the pass camera: the photo camera in the photo view, the orbit camera in the world view).
//   - nearFade and nearDiscard are per-pass uniforms: nearDiscard (already halved, like
//     TerrainLook.nearDiscard) discards only in the photo view's colour pass (frame.view "photo");
//     the geometry pass discard stays in TerrainCore (TerrainLook.nearDiscard).
//   - shade() / haze() are the foundation's fog_shade / fog_apply (fogFromLook(look, haze) carries
//     the same sun, ambient/direct, haze colour and density); hypso() is the core's (relief ramp +
//     elevRange from TerrainLook): terrainLook() fills both consistently.
//   - LOOK_HARMONIZE lives only inside the WebGL photo projection, i.e. the drape port: this file
//     exports its WGSL + uniform module (terrainHarmonizeModule, TERRAIN_HARMONIZE_WGSL) for it.
//   - the projective photo drape, projection tint and the Truth toggle are layers/drape.ts.
import type { Device, Texture } from "@luma.gl/core";
import type { ShaderModule } from "@luma.gl/shadertools";
import { ATM_CURV } from "#/lib/look/atmosphere";
import { BAND_CENTERS_LOG10 } from "#/lib/look/color-stats";
import type { harmonizeValues } from "#/lib/look/composite";
import type { ReliefField, ResidentReliefField } from "#/lib/look/relief/field";
import { waterWgsl } from "#/lib/look/water/water";
import { waterWaveSeconds } from "#/lib/look/water/waves";
import {
	type DeckTerrainStyle,
	deckTerrainStyle,
} from "#/lib/style/deck-apply";
import { CLASSIC } from "#/lib/style/defaults";
import { TER_BLOCK } from "#/lib/terroir/glsl/terrain";
import {
	coverTexels,
	type TerroirShader,
	terroirBlockValues,
	terroirMajorEvery,
} from "#/lib/terroir/glsl/values";
import {
	TERROIR_CONTOUR_TAIL,
	type TerroirFeatures,
	terroirAlbedoExpr,
	terroirFeatures,
	terroirNeedsCover,
	terroirOn,
	terroirSteepStmt,
	terroirUniformModule,
	terroirWGSL,
} from "#/lib/terroir/wgsl/terrain";
import type { PassContext } from "../pass";
import { USAGE } from "../targets";
import type { TerrainLook, TerrainShaderPart } from "../terrain";
import { fogFromLook } from "../wgsl";

// ---------------------------------------------------------------------------------------------
// uniform modules: one field table → WGSL struct + luma uniformTypes in the same order

type WgslType = "f32" | "vec2<f32>" | "vec4<f32>" | "mat4x4<f32>";

function uniformModule<F extends Record<string, WgslType>>(
	name: string,
	struct: string,
	fields: F,
) {
	const body = Object.entries(fields)
		.map(([k, t]) => `  ${k}: ${t},`)
		.join("\n");
	return {
		name,
		source: `struct ${struct} {\n${body}\n};\n@group(0) @binding(auto) var<uniform> ${name}: ${struct};\n`,
		uniformTypes: fields,
		bindingLayout: [{ name, group: 0 }],
	} as const satisfies ShaderModule;
}

/**
 * deck/terrain-layer.ts terrainUniforms minus what lives elsewhere now (sun / shade / haze → fog,
 * relief ramp / elevRange → terrain, photo drape → layers/drape.ts). Padded to 16 bytes: mat4s and
 * vec4s first, then the f32s in fours, then the vec2 at a 16-byte boundary + 2 pads.
 */
export const terrainStyleModule = uniformModule(
	"terrainStyle",
	"TerrainStyleUniforms",
	{
		lineC0: "mat4x4<f32>",
		lineC1: "mat4x4<f32>",
		lineDE: "mat4x4<f32>",
		bandC0: "mat4x4<f32>",
		bandC1: "mat4x4<f32>",
		bandDE: "mat4x4<f32>",
		densityFade: "vec4<f32>",
		contourMinorCol: "vec4<f32>",
		contourMajorCol: "vec4<f32>",
		/** on, extra px, minor multiplier, alpha */
		casing: "vec4<f32>",
		casingCol: "vec4<f32>",
		/** rgb, line whiten */
		bandLineCol: "vec4<f32>",
		/** alpha, line alpha, ground fade lo, hi */
		bandParams: "vec4<f32>",
		/** saturation, brightness, contrast, on */
		imgAdj: "vec4<f32>",
		/** linear rgb, amount */
		imgTint: "vec4<f32>",
		/** the slope layer's four class colours (linear rgb, -) */
		slopeC0: "vec4<f32>",
		slopeC1: "vec4<f32>",
		slopeC2: "vec4<f32>",
		slopeC3: "vec4<f32>",
		contourInterval: "f32",
		contourMajorEvery: "f32",
		contourWidth: "f32",
		contourOpacity: "f32",
		fadeNear: "f32",
		fadeFar: "f32",
		fadeFloor: "f32",
		contourMajorMul: "f32",
		minorAlpha: "f32",
		majorAlpha: "f32",
		contourSolid: "f32",
		nearFade: "f32",
		nearDiscard: "f32",
		slopeAlpha: "f32",
		lineN: "f32",
		bandN: "f32",
		/** shadeMin, 1 - shadeMin */
		bandShade: "vec2<f32>",
		pad0: "f32",
		pad1: "f32",
	},
);

/** REL_BLOCK (look/glsl/relief.ts), vec3 → vec4. */
export const terrainReliefModule = uniformModule(
	"terrainRelief",
	"TerrainReliefUniforms",
	{
		sunDir: "vec4<f32>",
		sunColor: "vec4<f32>",
		extent: "vec4<f32>",
		realism: "f32",
		generalize: "f32",
		curvature: "f32",
		edge: "f32",
	},
);

/** ATM_BLOCK (look/glsl/atmosphere.ts) without `eye` (camera.eye), vec3 → vec4. */
export const terrainAtmModule = uniformModule(
	"terrainAtm",
	"TerrainAtmUniforms",
	{
		betaR: "vec4<f32>",
		sunDir: "vec4<f32>",
		sunColor: "vec4<f32>",
		airlight: "vec4<f32>",
		h: "vec2<f32>",
		betaM: "f32",
		strength: "f32",
		mieG: "f32",
		airlightMix: "f32",
		pad0: "f32",
		pad1: "f32",
	},
);

/** The wave clock of LOOK_WATER_WAVES (look/water/waves.ts); present only in a waves program. */
export const terrainWaterModule = uniformModule(
	"terrainWater",
	"TerrainWaterUniforms",
	{ time: "f32", pad0: "f32", pad1: "f32", pad2: "f32" },
);

/** HARM_BLOCK (look/glsl/composite.ts): for the drape port's LOOK_HARMONIZE. */
export const terrainHarmonizeModule = uniformModule(
	"terrainHarmonize",
	"TerrainHarmonizeUniforms",
	{
		pm: "mat4x4<f32>",
		ps: "mat4x4<f32>",
		lm: "mat4x4<f32>",
		ls: "mat4x4<f32>",
		amount: "f32",
		chroma: "f32",
		pad0: "f32",
		pad1: "f32",
	},
);

/** look/composite.ts harmonizeValues() → terrainHarmonize uniforms. */
export function harmonizeUniforms(v: ReturnType<typeof harmonizeValues>) {
	return { ...v, pad0: 0, pad1: 0 };
}

// ---------------------------------------------------------------------------------------------
// WGSL (ports of the GLSL chunks; ts_ prefix keeps them apart from the core's names)

const f = (x: number) => x.toExponential(9);

/** Shared helpers every style program gets. */
const COMMON_WGSL = /* wgsl */ `\
fn ts_srgb(c: vec3<f32>) -> vec3<f32> { return pow(c, vec3<f32>(2.2)); }
fn ts_elev_t(h: f32) -> f32 {
  return clamp((h - terrain.elevRange.x) / max(terrain.elevRange.y - terrain.elevRange.x, 1.0), 0.0, 1.0);
}
// "topology" ramp for contour lines, and the band ramp (stops sRGB, mixed in sRGB, then pow 2.2)
fn ts_line_ramp(t: f32) -> vec3<f32> {
  return to_linear(ramp_eval(terrainStyle.lineC0, terrainStyle.lineC1, terrainStyle.lineDE, terrainStyle.lineN, clamp(t, 0.0, 1.0)));
}
fn ts_band_ramp(t: f32) -> vec3<f32> {
  return to_linear(ramp_eval(terrainStyle.bandC0, terrainStyle.bandC1, terrainStyle.bandDE, terrainStyle.bandN, clamp(t, 0.0, 1.0)));
}
// contourLine(e, widthPx) with fwidth(e) passed in (fwidth(elev / I) = s.dElev / I)
fn ts_contour_line(e: f32, fw: f32, widthPx: f32) -> f32 {
  let d = abs(fract(e - 0.5) - 0.5) / max(fw, 1e-6);
  return 1.0 - smoothstep(widthPx * 0.5, widthPx * 0.5 + 1.0, d);
}
// terrain closer than the GPS error is in the wrong place anyway: fade it
fn ts_near_fade(range: f32) -> f32 {
  if (terrainStyle.nearFade > 0.0) {
    return smoothstep(terrainStyle.nearFade * 0.5, terrainStyle.nearFade, range);
  }
  return 1.0;
}
// linear colour + straight alpha → the colour target's premultiplied (rgb·a, a)
fn ts_premul(rgb: vec3<f32>, alpha: f32) -> vec4<f32> {
  let a = clamp(alpha, 0.0, 1.0);
  return vec4<f32>(max(rgb, vec3<f32>(0.0)) * a, a);
}
`;

/** LOOK_ALPINE: look/glsl/ramps.ts ALPINE_FNS; `grad` = fwidth(elev) / |fwidth(xy)| from the caller. */
const ALPINE_WGSL = /* wgsl */ `\
fn ts_hash(p0: vec2<f32>) -> f32 {
  var p = fract(p0 * vec2<f32>(0.1031, 0.1030));
  p += dot(p, p.yx + 33.33);
  return fract((p.x + p.y) * p.x);
}
fn ts_noise(p: vec2<f32>) -> f32 {
  let i = floor(p);
  var fr = fract(p);
  fr = fr * fr * (3.0 - 2.0 * fr);
  return mix(mix(ts_hash(i), ts_hash(i + vec2<f32>(1.0, 0.0)), fr.x),
             mix(ts_hash(i + vec2<f32>(0.0, 1.0)), ts_hash(i + vec2<f32>(1.0, 1.0)), fr.x), fr.y);
}
fn ts_fbm(p: vec2<f32>) -> f32 {
  return 0.55 * ts_noise(p) + 0.3 * ts_noise(p * 2.13 + 7.1) + 0.15 * ts_noise(p * 4.37 - 3.3);
}
// valley greens ~400 m, forest belt, alpine meadow above the treeline (1900 m), rock from the
// rockline (2450 m); stops sRGB, mixed in linear
fn ts_alpine_base(h: f32) -> vec3<f32> {
  let c0 = ts_srgb(vec3<f32>(0.56, 0.66, 0.45));
  let c1 = ts_srgb(vec3<f32>(0.40, 0.53, 0.34));
  let c2 = ts_srgb(vec3<f32>(0.35, 0.47, 0.31));
  let c3 = ts_srgb(vec3<f32>(0.60, 0.65, 0.42));
  let c4 = ts_srgb(vec3<f32>(0.64, 0.62, 0.52));
  let c5 = ts_srgb(vec3<f32>(0.64, 0.64, 0.63));
  if (h < 900.0) { return mix(c0, c1, smoothstep(400.0, 900.0, h)); }
  if (h < 1500.0) { return mix(c1, c2, smoothstep(900.0, 1500.0, h)); }
  if (h < 2050.0) { return mix(c2, c3, smoothstep(1650.0, 2050.0, h)); }
  if (h < 2450.0) { return mix(c3, c4, smoothstep(2050.0, 2450.0, h)); }
  return mix(c4, c5, smoothstep(2450.0, 2950.0, h));
}
fn ts_alpine_albedo(elev: f32, n: vec3<f32>, xy: vec2<f32>, grad: f32) -> vec3<f32> {
  let slopeDeg = degrees(acos(clamp(n.z, -1.0, 1.0)));
  // ~400 m patchiness so the belts don't read as contour stripes
  let nz = ts_fbm(xy / 700.0) - 0.5;
  let fine = ts_noise(xy / 90.0) - 0.5;
  let h = elev + nz * 260.0;
  var col = ts_alpine_base(h);
  // rock on steep slopes; below the treeline steep ground is mostly forest
  let rockStart = mix(50.0, 30.0, smoothstep(1400.0, 2650.0, h));
  let rock = smoothstep(rockStart - 4.0, rockStart + 14.0, slopeDeg + fine * 5.0);
  col = mix(col, ts_srgb(mix(vec3<f32>(0.54, 0.52, 0.48), vec3<f32>(0.6), smoothstep(1500.0, 3000.0, h))), rock);
  // snow above the snowline (2900 m), only where it can lie
  let sl = 2900.0 + nz * 220.0;
  let snowH = smoothstep(sl - 120.0, sl + 180.0, elev);
  let snowS = 1.0 - smoothstep(32.0, 48.0, slopeDeg + fine * 10.0 - smoothstep(sl, sl + 900.0, elev) * 8.0);
  col = mix(col, ts_srgb(vec3<f32>(0.95, 0.97, 1.0)), snowH * snowS);
  // lakes: a DEM lake is one constant elevation, so its gradient is exactly 0 (below 2600 m)
  let water = (1.0 - smoothstep(0.0004, 0.0015, grad)) * (1.0 - smoothstep(2500.0, 2600.0, elev));
  return mix(col, ts_srgb(vec3<f32>(0.33, 0.50, 0.60)), water * 0.9);
}
`;

/** LOOK_TANAKA: look/glsl/ramps.ts TANAKA_FNS with fwidth(elev) passed in. */
const TANAKA_WGSL = /* wgsl */ `\
// Kennelly & Kimerling (2001): lines white on slopes facing the light, dark facing away
fn ts_tanaka_contour(elev: f32, dElev: f32, interval: f32, n: vec3<f32>, lightDir: vec3<f32>) -> vec4<f32> {
  let e = elev / interval;
  let fw = max(dElev / interval, 1e-6);
  let sl = length(n.xy);
  var lit = 0.0;
  if (sl > 1e-4 && length(lightDir.xy) > 1e-4) { lit = dot(n.xy / sl, normalize(lightDir.xy)); }
  let widthPx = (0.4 + 0.8 * abs(lit)) * mix(1.0, 1.4, clamp(sl * 1.6, 0.0, 1.0));
  let d = abs(fract(e - 0.5) - 0.5) / fw;
  var a = 1.0 - smoothstep(widthPx * 0.5, widthPx * 0.5 + 1.0, d);
  // lines denser than ~3 px apart turn into mush; nothing on flat valley floors
  a *= (1.0 - smoothstep(0.06, 0.14, fw)) * smoothstep(0.02, 0.08, sl);
  let col = select(ts_srgb(vec3<f32>(0.12, 0.13, 0.2)), vec3<f32>(1.0, 0.98, 0.94), lit >= 0.0);
  return vec4<f32>(col, a * mix(0.55, 1.0, abs(lit)));
}
fn ts_tanaka_lines(elev: f32, dElev: f32, interval: f32, majorEvery: f32, n: vec3<f32>, lightDir: vec3<f32>,
                   worldPos: vec3<f32>, cam: vec3<f32>, range: f32) -> vec4<f32> {
  let minor = ts_tanaka_contour(elev, dElev, interval, n, lightDir);
  var major = ts_tanaka_contour(elev, dElev, interval * majorEvery, n, lightDir);
  major.a = min(major.a * 1.6, 1.0);
  var c = select(vec4<f32>(minor.rgb, minor.a * 0.6), major, major.a > minor.a * 0.6);
  // within ~1° of eye level, and on grazing slopes
  c.a *= smoothstep(0.006, 0.025, abs(worldPos.z - cam.z) / max(range, 1.0));
  c.a *= smoothstep(0.08, 0.3, abs(dot(n, normalize(cam - worldPos))));
  return c;
}
`;

/** LOOK_SLOPE: look/glsl/ramps.ts SLOPE_FNS with fwidth(slope°) passed in. */
const SLOPE_CLASS_WGSL = /* wgsl */ `\
// 30–35°, 35–40°, 40–45°, > 45° (classic: yellow, orange, red, purple); alpha 0 below 30°
fn ts_slope_class(n: vec3<f32>, fwSlope: f32) -> vec4<f32> {
  let s = degrees(acos(clamp(n.z, -1.0, 1.0)));
  let fw = max(fwSlope, 1e-3);
  var c = terrainStyle.slopeC0.rgb;
  c = mix(c, terrainStyle.slopeC1.rgb, smoothstep(35.0 - fw, 35.0 + fw, s));
  c = mix(c, terrainStyle.slopeC2.rgb, smoothstep(40.0 - fw, 40.0 + fw, s));
  c = mix(c, terrainStyle.slopeC3.rgb, smoothstep(45.0 - fw, 45.0 + fw, s));
  return vec4<f32>(c, smoothstep(30.0 - fw, 30.0 + fw, s) * terrainStyle.slopeAlpha);
}
`;

/**
 * LOOK_RELIEF: look/glsl/relief.ts RELIEF_FNS. The field textures carry no mips, so
 * textureSampleLevel(…, 0) is the same sample as GLSL texture() and legal in any control flow.
 */
const RELIEF_WGSL = /* wgsl */ `\
@group(0) @binding(auto) var reliefField: texture_2d<f32>; // R sun visibility, G sky view, B curvature, A coverage
@group(0) @binding(auto) var reliefFieldSampler: sampler;
@group(0) @binding(auto) var reliefGen: texture_2d<f32>;   // RG generalised normal xy (× 0.5 + 0.5), A valid
@group(0) @binding(auto) var reliefGenSampler: sampler;

fn ts_relief_light_dir(azDeg: f32, altDeg: f32) -> vec3<f32> {
  let az = radians(azDeg);
  let al = radians(altDeg);
  return vec3<f32>(cos(al) * sin(az), cos(al) * cos(az), sin(al));
}
// Swiss-style multidirectional oblique hillshade from the NW (315°, 45°), 1 = lit flat ground
fn ts_relief_mdow(n: vec3<f32>) -> f32 {
  let slope = length(n.xy);
  let aspect = atan2(n.x, n.y);
  var acc = 0.0;
  var wsum = 0.0;
  for (var i = 0; i < 4; i++) {
    let az = 225.0 + 45.0 * f32(i);
    let s = sin(aspect - radians(az));
    let w = (0.2 + s * s) * select(1.0, 1.6, i == 2);
    acc += w * max(dot(n, ts_relief_light_dir(az, 45.0)), 0.0);
    wsum += w;
  }
  let single = max(dot(n, ts_relief_light_dir(315.0, 45.0)), 0.0);
  return mix(single, acc / wsum, 0.55 * smoothstep(0.05, 0.4, slope)) / sin(radians(45.0));
}
fn ts_relief_shade(albedo: vec3<f32>, n0: vec3<f32>, worldPos: vec3<f32>, range: f32) -> vec3<f32> {
  let R = terrainRelief;
  var n = n0;
  let uv = (worldPos.xy - R.extent.xy) / (R.extent.zw - R.extent.xy);
  // rounded fade toward the extent's edge, so it never reads as a rectangle
  let e = max(vec2<f32>(R.edge) - min(uv, 1.0 - uv), vec2<f32>(0.0)) / R.edge;
  let edge = 1.0 - smoothstep(0.0, 1.0, length(e));
  let fieldS = textureSampleLevel(reliefField, reliefFieldSampler, uv, 0.0);
  let g = textureSampleLevel(reliefGen, reliefGenSampler, uv, 0.0);
  var fv = vec4<f32>(1.0, 1.0, 0.5, 0.0);
  var wField = 0.0;
  if (edge > 0.0) {
    fv = fieldS;
    wField = edge * fv.a;
    let gxy = g.rg * 2.0 - 1.0;
    let gn = vec3<f32>(gxy, sqrt(max(1.0 - dot(gxy, gxy), 0.0)));
    // keep 30 % of the fine normal (Imhof's generalisation); none on the ground at your feet
    n = normalize(mix(n, normalize(mix(gn, n, 0.3)), R.generalize * edge * g.a * smoothstep(300.0, 2000.0, range)));
  }
  let sunVis = mix(1.0, fv.r, wField);
  let svf = mix(1.0, fv.g, wField);
  let curv = (fv.b - 0.5) * wField;
  let up = 0.5 + 0.5 * n.z;
  let elev = worldPos.z + dot(worldPos.xy, worldPos.xy) * ${f(ATM_CURV)};
  let skyCol = vec3<f32>(0.42, 0.56, 0.86);

  // photographic: real sun, cast shadow, sky dome × SVF, faint bounce
  let s = R.sunDir.xyz;
  let ndl = mix(max(dot(n, s), 0.0), smoothstep(-0.08, 0.35, dot(n, s)) * 0.35, 0.18);
  let sunUp = smoothstep(-0.03, 0.08, s.z);
  let direct = R.sunColor.rgb * ndl * sunVis * sunUp * 1.75;
  let skyL = skyCol * up * svf * mix(svf, 1.0, 0.35) * 0.62;
  let bounce = R.sunColor.rgb * (1.0 - up) * 0.06 * sunUp;
  let photo = albedo * (direct + skyL + bounce);

  // cartographic: MDOW (z-factor 1.6) + Imhof contrast + warm/cool split + ridge emphasis
  var hs = ts_relief_mdow(normalize(vec3<f32>(n.xy * 1.6, n.z)));
  hs = mix(0.78, hs, mix(0.55, 1.0, smoothstep(600.0, 3000.0, elev)));
  hs *= mix(1.0, 0.72 + 0.28 * svf, 0.9);
  hs += curv * R.curvature * 0.45;
  let L = clamp(hs, 0.0, 1.4);
  let tone = mix(vec3<f32>(0.62, 0.72, 0.98), vec3<f32>(1.05, 1.0, 0.88), smoothstep(0.25, 1.0, L)) * (0.1 + 0.9 * pow(L, 1.6));
  let carto = albedo * tone * 1.35;

  var col = mix(carto, photo, R.realism);
  col *= 1.0 + curv * R.curvature * mix(0.25, 0.35, R.realism);
  let mid = albedo * mix(vec3<f32>(0.9), R.sunColor.rgb * 0.9 + skyCol * 0.35, R.realism);
  return mix(col, mid, 0.125 * smoothstep(3000.0, 60000.0, range));
}
// luminance of the relief light alone (the elevation bands' shade term)
fn ts_relief_light(n: vec3<f32>, worldPos: vec3<f32>, range: f32) -> f32 {
  return dot(ts_relief_shade(vec3<f32>(1.0), n, worldPos, range), vec3<f32>(0.2126, 0.7152, 0.0722));
}
`;

/** LOOK_ATMOSPHERE: look/glsl/atmosphere.ts ATMOSPHERE_FNS (terrain half), atm_eye = camera.eye. */
const ATMOSPHERE_WGSL = /* wgsl */ `\
fn ts_atm_altitude(p: vec3<f32>) -> f32 { return p.z + dot(p.xy, p.xy) * ${f(ATM_CURV)}; }
// sea-level-equivalent path length through an exponential layer of scale height H
fn ts_atm_path(h0: f32, h1: f32, L: f32, H: f32) -> f32 {
  let x = (h1 - h0) / H;
  var k = 1.0 - 0.5 * x;
  if (abs(x) >= 1e-3) { k = (1.0 - exp(-x)) / x; }
  return exp(-h0 / H) * L * k;
}
fn ts_atm_transmittance(p: vec3<f32>) -> vec3<f32> {
  let A = terrainAtm;
  let L = length(p - camera.eye);
  let h0 = ts_atm_altitude(camera.eye);
  let h1 = ts_atm_altitude(p);
  let dR = ts_atm_path(h0, h1, L, A.h.x);
  let dM = ts_atm_path(h0, h1, L, A.h.y);
  return exp(-A.strength * (A.betaR.rgb * dR + vec3<f32>(A.betaM * dM)));
}
// phase functions normalised so an isotropic scatterer is 1 (i.e. ×4π)
fn ts_atm_phase_r(c: f32) -> f32 { return 0.75 * (1.0 + c * c); }
fn ts_atm_phase_m(c: f32) -> f32 {
  let g = terrainAtm.mieG;
  let g2 = g * g;
  let p = 1.5 * (1.0 - g2) * (1.0 + c * c) / ((2.0 + g2) * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5));
  return min(p, 40.0);
}
fn ts_atm_phys_airlight(viewDir: vec3<f32>) -> vec3<f32> {
  let A = terrainAtm;
  let c = dot(viewDir, A.sunDir.xyz);
  let h0 = ts_atm_altitude(camera.eye);
  let bR = A.betaR.rgb * exp(-h0 / A.h.x);
  let bM = A.betaM * exp(-h0 / A.h.y);
  let bExt = bR + vec3<f32>(bM);
  // Mie single-scatter albedo ~0.9
  let single = (bR * ts_atm_phase_r(c) + vec3<f32>(0.9 * bM * ts_atm_phase_m(c))) / max(bExt, vec3<f32>(1e-9));
  let day = smoothstep(-0.12, 0.25, A.sunDir.z);
  let skyAmb = vec3<f32>(0.30, 0.40, 0.56) * (0.25 + 0.75 * day);
  let mieFrac = bM / max(bM + bR.g, 1e-9);
  let amb = mix(skyAmb, vec3<f32>(0.62, 0.66, 0.70) * (0.3 + 0.7 * day), mieFrac);
  return 0.42 * A.sunColor.rgb * single * clamp(A.sunDir.z * 2.0 + 0.4, 0.0, 1.0) + amb;
}
fn ts_atm_airlight(viewDir: vec3<f32>) -> vec3<f32> {
  return mix(ts_atm_phys_airlight(viewDir), terrainAtm.airlight.rgb, terrainAtm.airlightMix);
}
fn ts_apply_atmosphere(colLinear: vec3<f32>, worldPos: vec3<f32>) -> vec3<f32> {
  let T = ts_atm_transmittance(worldPos);
  return colLinear * T + ts_atm_airlight(normalize(worldPos - camera.eye)) * (1.0 - T);
}
fn ts_finish(c: vec4<f32>, s: TerrainSample) -> vec4<f32> {
  return vec4<f32>(max(ts_apply_atmosphere(c.rgb, s.enu), vec3<f32>(0.0)), c.a);
}
`;

const HRM_C = BAND_CENTERS_LOG10.map((x) => x.toFixed(6)).join(", ");

/**
 * LOOK_HARMONIZE for the drape port (look/glsl/composite.ts HARMONIZE_FNS + oklab.ts):
 * `ts_harmonize(lin, range) -> vec3<f32>`; needs terrainHarmonizeModule. WebGL skipped it when
 * hrm_amount == 0 (`if (terrainHarmonize.amount > 0.0)` at the call site).
 */
export const TERRAIN_HARMONIZE_WGSL = /* wgsl */ `\
fn ts_linear_to_oklab(c0: vec3<f32>) -> vec3<f32> {
  let c = max(c0, vec3<f32>(0.0));
  let l = pow(0.4122214708 * c.r + 0.5363325363 * c.g + 0.0514459929 * c.b, 1.0 / 3.0);
  let m = pow(0.2119034982 * c.r + 0.6806995451 * c.g + 0.1073969566 * c.b, 1.0 / 3.0);
  let s = pow(0.0883024619 * c.r + 0.2817188376 * c.g + 0.6299787005 * c.b, 1.0 / 3.0);
  return vec3<f32>(
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s);
}
fn ts_oklab_to_linear(c: vec3<f32>) -> vec3<f32> {
  var l = c.x + 0.3963377774 * c.y + 0.2158037573 * c.z;
  var m = c.x - 0.1055613458 * c.y - 0.0638541728 * c.z;
  var s = c.x - 0.0894841775 * c.y - 1.2914855480 * c.z;
  l = l * l * l;
  m = m * m * m;
  s = s * s * s;
  return vec3<f32>(
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s);
}
const TS_HRM_C = vec4<f32>(${HRM_C});
fn ts_hrm_band(m: mat4x4<f32>, lg: f32) -> vec3<f32> {
  if (lg <= TS_HRM_C.x) { return m[0].xyz; }
  if (lg >= TS_HRM_C.w) { return m[3].xyz; }
  if (lg < TS_HRM_C.y) { return mix(m[0].xyz, m[1].xyz, (lg - TS_HRM_C.x) / (TS_HRM_C.y - TS_HRM_C.x)); }
  if (lg < TS_HRM_C.z) { return mix(m[1].xyz, m[2].xyz, (lg - TS_HRM_C.y) / (TS_HRM_C.z - TS_HRM_C.y)); }
  return mix(m[2].xyz, m[3].xyz, (lg - TS_HRM_C.z) / (TS_HRM_C.w - TS_HRM_C.z));
}
// Reinhard transfer in Oklab toward the photo's band statistics at this range (sky = the far band)
fn ts_harmonize(lin: vec3<f32>, range: f32) -> vec3<f32> {
  let H = terrainHarmonize;
  var lg = TS_HRM_C.w;
  if (range > 0.0) { lg = log(range) / log(10.0); }
  let lab = ts_linear_to_oklab(lin);
  let ratio = clamp(ts_hrm_band(H.ps, lg) / ts_hrm_band(H.ls, lg), vec3<f32>(0.5), vec3<f32>(2.0));
  let t = (lab - ts_hrm_band(H.lm, lg)) * ratio + ts_hrm_band(H.pm, lg);
  let k = vec3<f32>(H.amount, H.amount * H.chroma, H.amount * H.chroma);
  return max(ts_oklab_to_linear(mix(lab, t, k)), vec3<f32>(0.0));
}
`;

// ---------------------------------------------------------------------------------------------
// per-style terrain_base

export type TerrainStyleName =
	| "hillshade"
	| "imagery"
	| "contours"
	| "elevation"
	| "slope"
	| "slopeClass";

/** The LOOK_* features a style program compiles in (only those that affect the chosen style). */
export type TerrainStyleFeatures = {
	alpine: boolean;
	relief: boolean;
	tanaka: boolean;
	atmosphere: boolean;
	/** LOOK_WATER on top of the alpine tint */
	water: boolean;
	/** LOOK_WATER_WAVES: animated lake waves (world view only; absent = off) */
	waves?: boolean;
} & TerroirFeatures; // src/lib/terroir/wgsl: absent keys while every terroir switch is off

/** Photo view colour pass only (0 elsewhere, see styleUniforms). After every derivative. */
const DISCARD = `  if (s.range < terrainStyle.nearDiscard) { discard; }`;

/** The contour / band line alphas shared by styles 2 and 4 (deck/terrain-layer.ts). */
const LINES = /* wgsl */ `\
  let I = terrainStyle.contourInterval;
  let e = s.elev / I;
  let fw = s.dElev / I;
  let fade = 1.0 - smoothstep(terrainStyle.fadeNear, terrainStyle.fadeFar, s.range);
  let dist = mix(terrainStyle.fadeFloor, 1.0, fade);
  // lines that get denser than ~3px apart turn into mush: fade them out
  let minorFade = 1.0 - smoothstep(terrainStyle.densityFade.x, terrainStyle.densityFade.y, fw);
  let minorA = ts_contour_line(e, fw, terrainStyle.contourWidth) * minorFade;
  let em = e / terrainStyle.contourMajorEvery;
  let fwm = fw / terrainStyle.contourMajorEvery;
  let majorFade = 1.0 - smoothstep(terrainStyle.densityFade.z, terrainStyle.densityFade.w, fwm);
  let majorA = ts_contour_line(em, fwm, terrainStyle.contourWidth * terrainStyle.contourMajorMul) * majorFade;
  let near = ts_near_fade(s.range);
  let a = max(minorA * terrainStyle.minorAlpha, majorA * terrainStyle.majorAlpha) * dist * near;
`;

function baseWGSL(style: TerrainStyleName, ft: TerrainStyleFeatures) {
	const lit = style === "hillshade" || style === "imagery";
	if (lit) {
		const grad =
			"s.dElev / max(length(abs(s.dEnuDx.xy) + abs(s.dEnuDy.xy)), 1e-3)";
		const alpine = `ts_alpine_albedo(s.elev, n, s.enu.xy, ${grad})`;
		const terAlpine = terroirAlbedoExpr(ft, alpine);
		const albedo = ft.alpine
			? ft.water
				? `ts_water_shade(${terAlpine}, s.elev, s.enu.xy, ${grad}, n, normalize(camera.eye - s.enu), s.range)`
				: terAlpine
			: terroirAlbedoExpr(ft, "hypso(s.elev)");
		const shaded = ft.relief
			? "ts_relief_shade(albedo, n, s.enu, s.range)"
			: "albedo * fog_shade(n)";
		const imagery =
			style === "imagery"
				? /* wgsl */ `\
  if (s.hasImg) {
    base = s.img;
    // orthoimagery smears down true cliffs: only near-vertical faces (> ~70°) soften, at most
    // halfway, towards the imagery's own local average (coarse mip)
    let steep = 1.0 - smoothstep(0.17, 0.34, n.z);
    if (steep > 0.0) { base = mix(base, s.imgAvg * (0.7 + 0.45 * fog_shade(n)), 0.5 * steep); }
    // imagery adjust (identity = skipped)
    if (terrainStyle.imgAdj.w > 0.5) {
      let l = luminance(base);
      base = mix(vec3<f32>(l), base, terrainStyle.imgAdj.x);
      base = max((base - 0.18) * terrainStyle.imgAdj.z + 0.18, vec3<f32>(0.0)) * terrainStyle.imgAdj.y;
      // tint: shift the hue toward the tint colour at constant luminance
      let tl = max(luminance(terrainStyle.imgTint.rgb), 1e-3);
      base = mix(base, terrainStyle.imgTint.rgb * (luminance(base) / tl), terrainStyle.imgTint.a);
    }
${terroirSteepStmt(ft, shaded)}  }
`
				: "";
		return /* wgsl */ `\
fn terrain_base(s: TerrainSample) -> vec4<f32> {
${DISCARD}
  let n = s.normal;
  let albedo = ${albedo};
  var base = ${shaded};
${imagery}  return vec4<f32>(max(base, vec3<f32>(0.0)), 1.0);
}
`;
	}
	if (style === "slope")
		return /* wgsl */ `\
// debug: colour by true (face) slope; magenta ≥ 85° = vertical walls / skirts
fn terrain_base(s: TerrainSample) -> vec4<f32> {
${DISCARD}
  var nf = normalize(cross(s.dEnuDx, s.dEnuDy));
  if (nf.z < 0.0) { nf = -nf; }
  let deg = degrees(acos(clamp(nf.z, 0.0, 1.0)));
  var c = vec3<f32>(1.0, 0.0, 1.0);
  if (deg < 30.0) { c = vec3<f32>(0.35, 0.75, 0.35); }
  else if (deg < 45.0) { c = vec3<f32>(0.95, 0.9, 0.3); }
  else if (deg < 55.0) { c = vec3<f32>(1.0, 0.6, 0.2); }
  else if (deg < 70.0) { c = vec3<f32>(0.9, 0.15, 0.15); }
  else if (deg < 85.0) { c = vec3<f32>(0.45, 0.2, 0.8); }
  return vec4<f32>(max(fog_apply(to_linear(c) * (0.6 + 0.4 * fog_shade(s.normal)), s.range * 0.3), vec3<f32>(0.0)), 1.0);
}
`;
	if (style === "slopeClass")
		return /* wgsl */ `\
fn terrain_base(s: TerrainSample) -> vec4<f32> {
  // the only derivative without a TerrainSample field: taken first, in uniform control flow
  let fwSlope = fwidth(degrees(acos(clamp(s.normal.z, -1.0, 1.0))));
${DISCARD}
  let sc = ts_slope_class(s.normal, fwSlope);
  return ts_premul(sc.rgb, sc.a * ts_near_fade(s.range) * terrainStyle.contourOpacity);
}
`;
	if (style === "elevation")
		return /* wgsl */ `\
fn terrain_base(s: TerrainSample) -> vec4<f32> {
${DISCARD}
${LINES}
  let stepM = I * terrainStyle.contourMajorEvery;
  let bt = ts_elev_t(floor(s.elev / stepM) * stepM);
  let bc = ts_band_ramp(bt) * (terrainStyle.bandShade.x + terrainStyle.bandShade.y * ${ft.relief ? "ts_relief_light(s.normal, s.enu, s.range)" : "fog_shade(s.normal)"});
  // the ground at your feet reads better as photo than as a flat tint
  let rgb = mix(bc, terrainStyle.bandLineCol.rgb, a * terrainStyle.bandLineCol.a);
  return ts_premul(rgb, (terrainStyle.bandParams.x + terrainStyle.bandParams.y * a) * smoothstep(terrainStyle.bandParams.z, terrainStyle.bandParams.w, s.range));
}
`;
	// contours
	const tail = ft.tanaka
		? /* wgsl */ `\
  let tk = ts_tanaka_lines(s.elev, s.dElev, I, terrainStyle.contourMajorEvery, s.normal, fog.sun.xyz, s.enu, camera.eye, s.range);
  return ts_premul(tk.rgb, tk.a * dist * near * terrainStyle.contourOpacity);
`
		: ft.terInk || ft.terAdaptive
			? TERROIR_CONTOUR_TAIL
			: /* wgsl */ `\
  var lc = ts_line_ramp(ts_elev_t(s.elev));
  if (terrainStyle.contourSolid > 0.5) {
    lc = to_linear(select(terrainStyle.contourMinorCol.rgb, terrainStyle.contourMajorCol.rgb,
      majorA * terrainStyle.majorAlpha >= minorA * terrainStyle.minorAlpha));
  }
  if (terrainStyle.casing.x > 0.5) {
    // dark casing just outside the line keeps it legible over snow and bright sky
    let casing = max(ts_contour_line(e, fw, terrainStyle.contourWidth + terrainStyle.casing.y) * minorFade * terrainStyle.casing.z,
      ts_contour_line(em, fwm, terrainStyle.contourWidth * terrainStyle.contourMajorMul + terrainStyle.casing.y) * majorFade) * dist * near;
    let c = mix(terrainStyle.casingCol.rgb, lc, a / max(casing, 1e-3));
    return ts_premul(c, max(a, casing * terrainStyle.casing.w) * terrainStyle.contourOpacity);
  }
  return ts_premul(lc, a * terrainStyle.contourOpacity);
`;
	return /* wgsl */ `\
fn terrain_base(s: TerrainSample) -> vec4<f32> {
${DISCARD}
${LINES}${tail}}
`;
}

/** The generated shading WGSL for one style program (also used by terrain-styles.check.ts). */
export function terrainStyleWGSL(
	style: TerrainStyleName,
	ft: TerrainStyleFeatures,
) {
	const lit = style === "hillshade" || style === "imagery";
	return [
		COMMON_WGSL,
		...(terroirOn(ft)
			? [terroirWGSL(ft, { relief: ft.relief, water: ft.water })]
			: []),
		lit && ft.alpine ? ALPINE_WGSL : "",
		lit && ft.alpine && ft.water ? waterWgsl(!!ft.waves) : "",
		style === "contours" && ft.tanaka ? TANAKA_WGSL : "",
		style === "slopeClass" ? SLOPE_CLASS_WGSL : "",
		ft.relief && (lit || style === "elevation") ? RELIEF_WGSL : "",
		baseWGSL(style, ft),
	].join("\n");
}

/** Which features a style program actually uses (a toggle the style ignores never rebuilds it). */
export function styleFeatures(
	style: TerrainStyleName,
	look: Pick<DeckTerrainStyle, "defines" | "rel" | "atm">,
	terroir?: TerroirShader | null,
): TerrainStyleFeatures {
	const d = new Set<string>(look.defines);
	const lit = style === "hillshade" || style === "imagery";
	return {
		alpine: lit && d.has("LOOK_ALPINE"),
		relief:
			(lit || style === "elevation") && d.has("LOOK_RELIEF") && !!look.rel,
		tanaka: style === "contours" && d.has("LOOK_TANAKA"),
		atmosphere: lit && d.has("LOOK_ATMOSPHERE") && !!look.atm,
		water: lit && d.has("LOOK_ALPINE") && d.has("LOOK_WATER"),
		waves:
			lit &&
			d.has("LOOK_ALPINE") &&
			d.has("LOOK_WATER") &&
			d.has("LOOK_WATER_WAVES"),
		...terroirFeatures(
			style,
			terroir,
			style === "contours" && d.has("LOOK_TANAKA"),
		),
	};
}

// ---------------------------------------------------------------------------------------------
// the part factory

export type TerrainStyleProps = {
	style: TerrainStyleName;
	/**
	 * deckTerrainStyle(style, mode, sun, fit, bands) — pass `bands = true` for the elevation style
	 * when the band style has its own lines (as deck/terrain-layer.ts callers do).
	 */
	look: DeckTerrainStyle;
	/** m (engine.ts Settings.contourInterval). */
	contourInterval: number;
	/** engine.ts uContourOpacity: overlay "none" draws at 0 so trails keep their occlusion. */
	contourOpacity: number;
	/** Contour / band / slope-layer fade over terrain closer than this (m; overlay only). 0 = off. */
	nearFade: number;
	/**
	 * Discard terrain closer than this in the PHOTO view's colour pass (m; nearFadeFor(hAccuracy)
	 * / 2, the same value as TerrainLook.nearDiscard, which drives the geometry pass). 0 = off.
	 */
	nearDiscard: number;
	/** Terroir shading (src/lib/terroir/glsl/values.ts terroirShader): null / absent = off, the classic programs. */
	terroir?: TerroirShader | null;
};

export const DEFAULT_TERRAIN_STYLE_PROPS: TerrainStyleProps = {
	style: "hillshade",
	look: deckTerrainStyle(CLASSIC, "overlay"),
	contourInterval: 50,
	contourOpacity: 1,
	nearFade: 0,
	nearDiscard: 0,
};

type ReliefTextures = { field: Texture; gen: Texture; extent: number[] };

const v4 = (v: readonly number[] | undefined, w = 0) => [
	v?.[0] ?? 0,
	v?.[1] ?? 0,
	v?.[2] ?? 0,
	w,
];

/**
 * The terrain styles as TerrainShaderParts. One instance per terrain (it may be shared by the
 * per-tile and batched cores: parts read the current props at draw time).
 *   shading  terrain_base for props.style (+ the look's features); always set
 *   finish   LOOK_ATMOSPHERE's aerial perspective, to run LAST in the plugin chain (null otherwise)
 *   lit      hillshade / imagery: the photo drape / Truth plugins apply (WebGL returned early for
 *            contours, bands and the slope styles, before the projection)
 */
export class TerrainStyles {
	private p: TerrainStyleProps;
	private relief: ReliefTextures | null = null;
	private zero: Texture | null = null;
	/** terroir cover classes (r8 nearest) and the grid they were uploaded from */
	private cover: { grid: unknown; tex: Texture } | null = null;
	private parts: {
		key: string;
		shading: TerrainShaderPart;
		finish: TerrainShaderPart | null;
	} | null = null;

	constructor(
		readonly device: Device,
		props: Partial<TerrainStyleProps> = {},
	) {
		this.p = { ...DEFAULT_TERRAIN_STYLE_PROPS, ...props };
	}

	get props(): Readonly<TerrainStyleProps> {
		return this.p;
	}

	/** Update props. Returns true when the parts changed (call applyTo / setShaderParts again). */
	set(props: Partial<TerrainStyleProps>): boolean {
		const was = this.key;
		this.p = { ...this.p, ...props };
		return this.key !== was;
	}

	get features(): TerrainStyleFeatures {
		return styleFeatures(this.p.style, this.p.look, this.p.terroir);
	}

	/** Pipeline identity: style + the features it compiles in. */
	get key(): string {
		const ft = this.features;
		const on = (Object.keys(ft) as (keyof TerrainStyleFeatures)[]).filter(
			(k) => ft[k],
		);
		return `terrain-styles|${this.p.style}|${on.join(",")}`;
	}

	get lit(): boolean {
		return this.p.style === "hillshade" || this.p.style === "imagery";
	}

	get shading(): TerrainShaderPart {
		return this.build().shading;
	}

	get finish(): TerrainShaderPart | null {
		return this.build().finish;
	}

	/** The plugin chain for TerrainCore: `plugins` (drape, truth… only when lit) then finish. */
	plugins(plugins: readonly TerrainShaderPart[] = []): TerrainShaderPart[] {
		const fin = this.finish;
		return [...(this.lit ? plugins : []), ...(fin ? [fin] : [])];
	}

	/** core.setShaderParts(shading, plugins(plugins)); TerrainCore rebuilds only on a key change. */
	applyTo(
		core: {
			setShaderParts(
				s: TerrainShaderPart | null,
				p?: TerrainShaderPart[],
			): void;
		},
		plugins: readonly TerrainShaderPart[] = [],
	) {
		core.setShaderParts(this.shading, this.plugins(plugins));
	}

	/**
	 * The TerrainCore look that goes with these props: the relief ramp + elevRange (hypso), the
	 * fog (fog_shade / fog_apply = WebGL shade() / haze()) and the geometry-pass nearDiscard.
	 * `haze`: TerrainUniformProps.haze (null = the look's).
	 */
	terrainLook(
		elevRange: [number, number],
		haze: number | null = null,
	): TerrainLook {
		const L = this.p.look;
		return {
			style: this.p.style === "imagery" ? "imagery" : "hillshade",
			relief: L.relief,
			elevRange,
			fog: fogFromLook(L, haze ?? undefined),
			nearDiscard: this.p.nearDiscard,
		};
	}

	/**
	 * The Swiss relief's field (look/relief/field.ts, LOOK_RELIEF); null until built. CPU bytes are
	 * uploaded; a ResidentReliefField (compute-bridge.ts, built on this device) is sampled as is and
	 * owned from here on (destroyed on replace, like the uploads). A resident field of another device
	 * or already destroyed (device loss) counts as null.
	 */
	setReliefField(r: ReliefField | ResidentReliefField | null) {
		this.relief?.field.destroy();
		this.relief?.gen.destroy();
		this.relief = null;
		if (!r) return;
		if ("textures" in r) {
			const { field, gen } = r.textures;
			if (
				field.device !== this.device ||
				gen.device !== this.device ||
				field.destroyed ||
				gen.destroyed
			)
				return;
			this.relief = { field, gen, extent: [...r.extent] };
			return;
		}
		const tex = (data: Uint8Array, id: string) => {
			const t = this.device.createTexture({
				id,
				format: "rgba8unorm",
				width: r.res,
				height: r.res,
				usage: USAGE.SAMPLE | USAGE.COPY_DST,
				sampler: {
					minFilter: "linear",
					magFilter: "linear",
					addressModeU: "clamp-to-edge",
					addressModeV: "clamp-to-edge",
				},
			});
			// rows as uploaded by the WebGL path (row 0 = uv.y 0 in both APIs)
			t.writeData(data as never, {
				width: r.res,
				height: r.res,
				bytesPerRow: r.res * 4,
			});
			return t;
		};
		this.relief = {
			field: tex(r.field, "relief-field"),
			gen: tex(r.gen, "relief-gen"),
			extent: [...r.extent],
		};
	}

	/** 1×1 zero texture: coverage 0 = the plain normal (WebGL's emptyTexture). */
	private zeroTexture() {
		if (!this.zero) {
			this.zero = this.device.createTexture({
				id: "terrain-styles-zero",
				format: "rgba8unorm",
				width: 1,
				height: 1,
				usage: USAGE.SAMPLE | USAGE.COPY_DST,
			});
			this.zero.writeData(new Uint8Array(4) as never, {
				width: 1,
				height: 1,
				bytesPerRow: 4,
			});
		}
		return this.zero;
	}

	/** terrainStyle uniform values for this colour pass (setTerrainShaderProps). */
	styleUniforms(ctx: Pick<PassContext, "frame">) {
		const p = this.p;
		const L = p.look;
		const sc = L.slopeColors;
		return {
			lineC0: L.line.c0,
			lineC1: L.line.c1,
			lineDE: L.line.de,
			bandC0: L.band.c0,
			bandC1: L.band.c1,
			bandDE: L.band.de,
			densityFade: [...L.densityFade],
			contourMinorCol: v4(L.contourMinorCol, 1),
			contourMajorCol: v4(L.contourMajorCol, 1),
			casing: [...L.casing],
			casingCol: v4(L.casingCol, 1),
			bandLineCol: v4(L.bandLineCol, L.bandLineWhiten),
			bandParams: [
				L.bandAlpha,
				L.bandLineAlpha,
				L.bandGroundFade[0],
				L.bandGroundFade[1],
			],
			imgAdj: v4(L.imgAdj, L.imgOn),
			imgTint: [...L.imgTint],
			slopeC0: v4(sc[0]),
			slopeC1: v4(sc[1]),
			slopeC2: v4(sc[2]),
			slopeC3: v4(sc[3]),
			contourInterval: p.contourInterval,
			contourMajorEvery:
				this.p.terroir?.swissIndex && p.style === "contours"
					? terroirMajorEvery(
							this.p.terroir,
							p.contourInterval,
							L.contourMajorEvery,
						)
					: L.contourMajorEvery,
			contourWidth: L.contourWidth,
			contourOpacity: p.contourOpacity,
			fadeNear: L.fadeNear,
			fadeFar: L.fadeFar,
			fadeFloor: L.fadeFloor,
			contourMajorMul: L.contourMajorMul,
			minorAlpha: L.minorAlpha,
			majorAlpha: L.majorAlpha,
			contourSolid: L.contourSolid,
			nearFade: p.nearFade,
			// the photo-camera colour pass only (WebGL: nearDiscard in the offscreen passes)
			nearDiscard: ctx.frame.view === "photo" ? p.nearDiscard : 0,
			slopeAlpha: L.slopeAlpha,
			lineN: L.line.n,
			bandN: L.band.n,
			bandShade: [...L.bandShade],
			pad0: 0,
			pad1: 0,
		};
	}

	/** The cover class texture (padded to the fit's row width), uploaded once per grid. */
	private coverTexture(): Texture {
		const T = this.p.terroir;
		const grid = T?.fit ? T.grid : null;
		if (this.cover?.grid === grid && grid) return this.cover.tex;
		this.cover?.tex.destroy();
		this.cover = null;
		if (!T || !grid || !T.fit) return this.zeroTexture();
		const tex = this.device.createTexture({
			id: "terroir-cover",
			format: "r8unorm",
			width: T.fit.texWidth,
			height: grid.height,
			usage: USAGE.SAMPLE | USAGE.COPY_DST,
			sampler: {
				minFilter: "nearest",
				magFilter: "nearest",
				addressModeU: "clamp-to-edge",
				addressModeV: "clamp-to-edge",
			},
		});
		tex.writeData(coverTexels(grid, T.fit.texWidth) as never, {
			width: T.fit.texWidth,
			height: grid.height,
			bytesPerRow: T.fit.texWidth,
		});
		this.cover = { grid, tex };
		return tex;
	}

	private reliefUniforms() {
		const R = this.p.look.rel;
		return {
			sunDir: v4(R?.sunDir),
			sunColor: v4(R?.sunColor),
			extent: [...(this.relief?.extent ?? R?.extent ?? [0, 0, 1, 1])],
			realism: R?.realism ?? 0,
			generalize: R?.generalize ?? 0,
			curvature: R?.curvature ?? 0,
			edge: R?.edge ?? 0.08,
		};
	}

	private terroirUniforms() {
		const T = this.p.terroir;
		if (!T) return {};
		return TER_BLOCK.pack(
			terroirBlockValues(
				T,
				this.p.contourInterval,
				this.p.look.contourMajorEvery,
			),
		);
	}

	private atmUniforms() {
		const A = this.p.look.atm;
		return {
			betaR: v4(A?.betaR),
			sunDir: v4(A?.sunDir),
			sunColor: v4(A?.sunColor),
			airlight: v4(A?.airlight),
			h: [A?.h[0] ?? 8000, A?.h[1] ?? 1200],
			betaM: A?.betaM ?? 0,
			strength: A?.strength ?? 0,
			mieG: A?.mieG ?? 0.76,
			airlightMix: A?.airlightMix ?? 0,
			pad0: 0,
			pad1: 0,
		};
	}

	private build() {
		const key = this.key;
		if (this.parts?.key === key) return this.parts;
		const style = this.p.style;
		const ft = this.features;
		const lit = this.lit;
		const shading: TerrainShaderPart = {
			key,
			wgsl: terrainStyleWGSL(style, ft),
			modules: [
				terrainStyleModule as unknown as ShaderModule,
				...(ft.relief ? [terrainReliefModule as unknown as ShaderModule] : []),
				...(terroirOn(ft) ? [terroirUniformModule] : []),
				...(ft.waves ? [terrainWaterModule as unknown as ShaderModule] : []),
			],
			defines: {
				TERRAIN_SHADING: true,
				// the core's fog_apply only for the classic lit styles; everything else hazes
				// itself (slope), never (contours, bands, slope layer) or in `finish` (atmosphere)
				...(!lit || ft.atmosphere ? { TERRAIN_NO_FOG: true } : {}),
			},
			props: (ctx) => ({
				uniforms: {
					terrainStyle: this.styleUniforms(ctx),
					...(ft.relief ? { terrainRelief: this.reliefUniforms() } : {}),
					...(terroirOn(ft) ? { terroir: this.terroirUniforms() } : {}),
					...(ft.waves
						? {
								terrainWater: {
									time: waterWaveSeconds(),
									pad0: 0,
									pad1: 0,
									pad2: 0,
								},
							}
						: {}),
				},
				bindings: {
					...(ft.relief
						? {
								reliefField: this.relief?.field ?? this.zeroTexture(),
								reliefGen: this.relief?.gen ?? this.zeroTexture(),
							}
						: {}),
					...(terroirNeedsCover(ft)
						? { terroirCover: this.coverTexture() }
						: {}),
				},
			}),
		};
		const finish: TerrainShaderPart | null = ft.atmosphere
			? {
					key: "terrain-styles-atmosphere",
					wgsl: ATMOSPHERE_WGSL,
					modules: [terrainAtmModule as unknown as ShaderModule],
					apply: "ts_finish",
					props: () => ({ uniforms: { terrainAtm: this.atmUniforms() } }),
				}
			: null;
		this.parts = { key, shading, finish };
		return this.parts;
	}

	destroy() {
		this.setReliefField(null);
		this.zero?.destroy();
		this.zero = null;
		this.cover?.tex.destroy();
		this.cover = null;
		this.parts = null;
	}
}

/** Factory (the assembler's entry point). */
export function createTerrainStyles(
	device: Device,
	props: Partial<TerrainStyleProps> = {},
) {
	return new TerrainStyles(device, props);
}

/**
 * deck/settings-map.ts terrainLookFor's `style` → TerrainStyleName (identical names; the WebGL
 * TerrainStyle "geometry" pass style no longer exists).
 */
export function terrainStyleName(s: string): TerrainStyleName {
	return (
		[
			"hillshade",
			"imagery",
			"contours",
			"elevation",
			"slope",
			"slopeClass",
		] as const
	).includes(s as TerrainStyleName)
		? (s as TerrainStyleName)
		: "hillshade";
}
