// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Terroir terrain shading (reports/terroir-cartography.md T0.2, T0.3, phase 1 "three-colour contours"
// + "replace alpineAlbedo's constants with a class lookup", T2.1/T2.5/T2.6 in part). One GLSL source
// for both engines (deck terrain-layer.ts, three materials.ts), spliced into the terrain fragment
// shader ONLY while a TERROIR_* define is on: with every style.terroir switch off the programs are
// the classic ones, byte for byte (scripts/terroir/shader-identity-snap.ts).
//
//   TERROIR_COVER             Blend / In map albedo from the pack's land-cover class (natural colours,
//                             canopy / scree texture), the alpine belts (or the relief ramp) as the
//                             fallback where the class is 0; on imagery, steep faces (where the
//                             orthophoto smears) cross-fade to the class rendering (T2.7, lite)
//   TERROIR_SNOW              seasonal snowline from the photo date, aspect offset, slope shedding
//   TERROIR_PATTERN           (with TERROIR_COVER) scree dots, rock hatching, glacier crevasse hatching in
//                             world metres, analytically filtered (../pattern.ts, luma patternFill #3320)
//   TERROIR_CONTOUR_ADAPTIVE  contour interval thinned with range in nested levels (T0.3)
//   TERROIR_CONTOUR_INK       contour ink from the cover class: brown soil, black rock, blue ice;
//                             no lines over water
// Display only: the geometry (style 3) and normal (style 7) passes return before any of it runs.
import { defineBlock } from "#/lib/look/glsl/block";
import { HATCH_GLSL, HATCH_INK } from "../hatch";
import { PATTERN_GLSL, PATTERN_KERNEL_GLSL } from "../pattern";

/** Values: ./values.ts terroirBlockValues(). Accessors `ter_<field>`, three uniforms `uTer<Field>`. */
export const TER_BLOCK = defineBlock("ter", "terroir", {
	/** ENU (x, y) → cover texture u / v: dot(uv?, vec4(1, x, y, x·y)) + dot(uvQ.xy / .zw, (x², y²)) */
	uvU: "vec4",
	uvV: "vec4",
	uvQ: "vec4",
	/** class palette: column i of pal0..pal3 = class 4k+i, rgb linear, a = ink (0 soil, 1 rock, 2 ice) */
	pal0: "mat4",
	pal1: "mat4",
	pal2: "mat4",
	pal3: "mat4",
	/** contour inks (linear) */
	inkSoil: "vec3",
	inkRock: "vec3",
	inkIce: "vec3",
	/** snow albedo (linear rgb), amount */
	snowCol: "vec4",
	/** snowline (m), north/south aspect offset (m), shedding slope start / end (deg) */
	snow: "vec4",
	/** adaptive levels 1–3: minor intervals (m), w unused */
	minorLv: "vec4",
	/** adaptive levels 1–3: major intervals (m), w unused */
	majorLv: "vec4",
	/** level boundaries (m from the camera), w = transition half-width as a fraction of the boundary */
	adapt: "vec4",
	/** cover strength, texture strength, steep-face cross-fade on imagery, u extent of the data */
	cover: "vec4",
});

/** Shared functions; need vWorld / vElev and the TER_SUN macro, `terroirCover` and the block. */
const FNS = /* glsl */ `
// ---- terroir (src/lib/terroir/glsl/terrain.ts) ----
float terHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float terNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(terHash(i), terHash(i + vec2(1.0, 0.0)), f.x), mix(terHash(i + vec2(0.0, 1.0)), terHash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float terFbm(vec2 p) {
  return 0.55 * terNoise(p) + 0.3 * terNoise(p * 2.13 + 7.1) + 0.15 * terNoise(p * 4.37 - 3.3);
}

// cover class at ENU (x, y): nearest texel (classes never interpolate), 0 outside the pack. The
// lookup is domain-warped (two octaves, up to ~±30 m) so the 25 m cells read as organic edges,
// not stair-stepped pixels.
int terClass(vec2 xy) {
  vec2 w = (vec2(terNoise(xy / 70.0), terNoise(xy / 70.0 + 17.3)) - 0.5) * 44.0
    + (vec2(terNoise(xy / 19.0 + 5.1), terNoise(xy / 19.0 - 9.7)) - 0.5) * 16.0;
  vec2 q = xy + w;
  vec4 b = vec4(1.0, q, q.x * q.y);
  vec2 q2 = q * q;
  vec2 uv = vec2(dot(ter_uvU, b) + dot(ter_uvQ.xy, q2), dot(ter_uvV, b) + dot(ter_uvQ.zw, q2));
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > ter_cover.w || uv.y > 1.0) return 0;
  return int(textureLod(terroirCover, uv, 0.0).r * 255.0 + 0.5);
}

vec4 terPal(int c) {
  int j = c - (c / 4) * 4;
  return c < 4 ? ter_pal0[j] : c < 8 ? ter_pal1[j] : c < 12 ? ter_pal2[j] : ter_pal3[j];
}

vec3 terInk(int c) {
  float k = terPal(c).a;
  return k > 1.5 ? ter_inkIce : k > 0.5 ? ter_inkRock : ter_inkSoil;
}

// ---- contours: nested levels thinned with range, ink by cover ----
float terLine(float e, float fw, float widthPx) {
  float d = abs(fract(e - 0.5) - 0.5) / max(fw, 1e-6);
  return 1.0 - smoothstep(widthPx * 0.5, widthPx * 0.5 + 1.0, d);
}
// (line, casing) of interval iv (m); fwE = metres of elevation per pixel (continuous across levels)
vec2 terLines(float elev, float fwE, float iv, float widthPx, float casingPx, vec2 dens) {
  float e = elev / iv;
  float fw = fwE / iv;
  float f = 1.0 - smoothstep(dens.x, dens.y, fw);
  return vec2(terLine(e, fw, widthPx), terLine(e, fw, widthPx + casingPx)) * f;
}
// vec4(minor, major, minor casing, major casing)
vec4 terContourA(float elev, float range, float minorIv, float majorIv, float w, float wMajor, float casingPx, vec4 dens) {
  float fwE = fwidth(elev);
  float m0 = minorIv;
  float m1 = minorIv;
  float j0 = majorIv;
  float j1 = majorIv;
  float t = 0.0;
#ifdef TERROIR_CONTOUR_ADAPTIVE
  // level k up to boundary k (± the band), then k + 1: the lines that k + 1 drops fade out over the
  // band while its own (a subset: the levels nest) stay, so nothing pops
  int k = 0;
  for (int i = 0; i < 3; i++) {
    float b = ter_adapt[i];
    if (b <= 0.0) break;
    float hi = b * (1.0 + ter_adapt.w);
    if (range >= hi) {
      k = i + 1;
    } else {
      t = smoothstep(b * (1.0 - ter_adapt.w), hi, range);
      break;
    }
  }
  vec4 mi = vec4(minorIv, ter_minorLv.xyz);
  vec4 ma = vec4(majorIv, ter_majorLv.xyz);
  m0 = mi[k];
  j0 = ma[k];
  m1 = mi[min(k + 1, 3)];
  j1 = ma[min(k + 1, 3)];
  // and a stricter screen density for the minor lines: none closer than ~10 px
  dens.xy *= 0.65;
#endif
  vec2 a0 = terLines(elev, fwE, m0, w, casingPx, dens.xy);
  vec2 a1 = terLines(elev, fwE, m1, w, casingPx, dens.xy);
  vec2 b0 = terLines(elev, fwE, j0, wMajor, casingPx, dens.zw);
  vec2 b1 = terLines(elev, fwE, j1, wMajor, casingPx, dens.zw);
  vec2 mn = max(a0 * (1.0 - t), a1);
  vec2 mj = max(b0 * (1.0 - t), b1);
  return vec4(mn.x, mj.x, mn.y, mj.y);
}
// the classic style-2 contour (materials.ts / terrain-layer.ts) with the terroir options; linear
// rgb + alpha before the layer's contourOpacity. fadeMix = mix(fadeFloor, 1, fade) * near.
vec4 terContour(float elev, float range, vec2 xy, float interval, float majorEvery, float width, float majorMul,
    vec4 dens, float minorAlpha, float majorAlpha, float fadeMix, bool solid, vec3 minorCol, vec3 majorCol,
    vec3 rampCol, vec4 casing, vec3 casingCol) {
  vec4 A = terContourA(elev, range, interval, interval * majorEvery, width, width * majorMul, casing.y, dens);
  vec3 lc = solid ? (A.y * majorAlpha >= A.x * minorAlpha ? majorCol : minorCol) : rampCol;
  float a = max(A.x * minorAlpha, A.y * majorAlpha) * fadeMix;
#ifdef TERROIR_CONTOUR_INK
  int c = terClass(xy);
  // lakes keep their own symbology
  if (c == 12) return vec4(0.0);
  if (c > 0) lc = terInk(c);
#endif
  if (casing.x > 0.5) {
    float cs = max(A.z * casing.z, A.w) * fadeMix;
    return vec4(mix(casingCol, lc, a / max(cs, 1e-3)), max(a, cs * casing.w));
  }
  return vec4(lc, a);
}

// ---- cover albedo, snow, warm light / cool shade ----
// px = ground metres per pixel: detail fades before it aliases. The noise domain leans with the
// height, so cliffs (where xy barely moves) get texture across the face instead of vertical streaks.
vec3 terCoverAlbedo(int c, vec2 p, float px) {
  vec3 base = terPal(c).rgb;
  vec2 xy = p + vec2(0.71, -0.71) * vElev;
  float fine = 1.0 - smoothstep(3.0, 14.0, px);
  float mid = 1.0 - smoothstep(40.0, 160.0, px);
  float v = 0.0;
  if (c >= 5 && c <= 7) {
    // canopy: crowns ~5 m, clumps and gaps ~80 m
    v = (terNoise(xy / 5.0) - 0.5) * 0.55 * fine + (terFbm(xy / 80.0) - 0.5) * 0.45 * mid;
  } else if (c == 4) {
    // scree: speckle at ~3 m, coarse fans
    v = (terHash(floor(xy / 3.0)) - 0.5) * 0.5 * fine + (terFbm(xy / 60.0) - 0.5) * 0.25 * mid;
  } else if (c == 3) {
    v = (terNoise(xy / 8.0) - 0.5) * 0.25 * fine + (terFbm(xy / 40.0) - 0.5) * 0.35 * mid;
  } else if (c >= 8 && c != 12 && c != 13) {
    // fields and pastures: parcel-scale patchiness
    v = (terFbm(xy / 220.0) - 0.5) * 0.2;
  } else if (c <= 2) {
    v = (terFbm(xy / 150.0) - 0.5) * 0.06;
  }
  return base * max(1.0 + v * ter_cover.y, 0.0);
}

float terSnow(float elev, vec3 n, float slopeDeg, vec2 xy) {
  float sl = length(n.xy);
  // + on north-facing slopes (the normal leans north): the snowline sits lower there
  float north = sl > 1e-4 ? n.y / sl : 0.0;
  float line = ter_snow.x - ter_snow.y * north * smoothstep(0.03, 0.25, sl) + (terFbm(xy / 700.0) - 0.5) * 260.0;
  float above = smoothstep(line - 120.0, line + 160.0, elev);
  float shed = 1.0 - smoothstep(ter_snow.z, ter_snow.w, slopeDeg + (terNoise(xy / 50.0) - 0.5) * 10.0);
  return above * shed * ter_snowCol.a;
}

// fb = the look's albedo (alpine belts or the relief ramp) where there is no class
vec3 terroirAlbedo(vec3 fb, vec3 n) {
  vec2 xy = vWorld.xy;
  float px = max(length(fwidth(xy)), 1e-3);
  float slopeDeg = degrees(acos(clamp(n.z, -1.0, 1.0)));
  vec3 col = fb;
  int c = 0;
#ifdef TERROIR_COVER
  c = terClass(xy);
#ifdef LOOK_WATER
  // LOOK_WATER shades water itself (it wraps ALBEDO, around this): no class tint under it
  if (c > 0 && c != 12) col = mix(fb, terCoverAlbedo(c, xy, px), ter_cover.x);
#else
  if (c > 0) col = mix(fb, terCoverAlbedo(c, xy, px), ter_cover.x);
#endif
#endif
#ifdef TERROIR_SNOW
  if (c != 12) col = mix(col, ter_snowCol.rgb, terSnow(vElev, n, slopeDeg, xy));
#endif
#ifdef LOOK_RELIEF
  // the Swiss relief already splits warm light / cool shade
  return col;
#else
  // Imhof: warm light, cool shade, from the look's sun
  float lit = dot(n, TER_SUN);
  return col * mix(vec3(0.9, 0.95, 1.07), vec3(1.04, 1.0, 0.94), smoothstep(-0.05, 0.45, lit));
#endif
}

// imagery: how much of the class rendering replaces the orthophoto (steep faces, where it smears)
float terSteep(vec3 n, vec2 xy) {
  int c = terClass(xy);
  return c > 0 && c != 12 ? (1.0 - smoothstep(0.3, 0.55, n.z)) * ter_cover.z : 0.0;
}
`;

// The cover / snow albedo composes INSIDE the look's ALBEDO macro, never replacing it: the albedo
// function ALBEDO calls (alpineAlbedo under LOOK_ALPINE, else hypso) is renamed where it is defined
// (#define before the definition) and re-defined after the ALBEDO block as terroirAlbedo(original).
// Whatever ALBEDO wraps around it (e.g. LOOK_WATER's waterShade) then applies on top, so on water
// LOOK_WATER wins (and terroirAlbedo leaves class 12 alone under LOOK_WATER).
const RENAME_ALPINE = "#define alpineAlbedo terAlpineAlbedo\n";
const RENAME_HYPSO = "#ifndef LOOK_ALPINE\n#define hypso terHypso\n#endif\n";
const WRAP_ALBEDO = /* glsl */ `#ifdef LOOK_ALPINE
#undef alpineAlbedo
vec3 alpineAlbedo(float elev, vec3 n, vec2 xy) { return terroirAlbedo(terAlpineAlbedo(elev, n, xy), n); }
#else
#undef hypso
vec3 hypso(float h) { return terroirAlbedo(terHypso(h), normalize(vNormal)); }
#endif
`;

/**
 * FNS with the pattern fills (TERROIR_PATTERN): the footprint and sun term are taken at the top of
 * terroirAlbedo (uniform control flow, before the class branching), the pattern is composed over the
 * class albedo, and the scree hash speckle (which aliases) gives way to the dots. FNS unchanged when off.
 */
function fnsFor(pattern: boolean, hatch = false): string {
	if (!pattern && !hatch) return FNS;
	let out = FNS;
	const swap = (from: string, to: string, all = false) => {
		if (!out.includes(from))
			throw new Error(`terroir: pattern anchor missing: ${from.slice(0, 50)}`);
		out = all ? out.replaceAll(from, to) : out.replace(from, to);
	};
	swap(
		"// fb = the look's albedo",
		`${pattern ? PATTERN_GLSL : PATTERN_KERNEL_GLSL}${hatch ? HATCH_GLSL : ""}\n// fb = the look's albedo`,
	);
	swap(
		"  float px = max(length(fwidth(xy)), 1e-3);\n",
		"  float px = max(length(fwidth(xy)), 1e-3);\n  vec2 terFw = fwidth(xy);\n",
	);
	if (pattern) {
		swap(
			"  vec2 terFw = fwidth(xy);\n",
			"  vec2 terFw = fwidth(xy);\n  float terLit = dot(n, TER_SUN);\n",
		);
		swap(
			"    v = (terHash(floor(xy / 3.0)) - 0.5) * 0.5 * fine + (terFbm(xy / 60.0) - 0.5) * 0.25 * mid;",
			"    v = (terFbm(xy / 60.0) - 0.5) * 0.25 * mid;",
		);
		swap(
			"terCoverAlbedo(c, xy, px)",
			"terPatternCover(c, xy, terCoverAlbedo(c, xy, px), terFw, terLit)",
			true,
		);
	}
	// slope hatch: before the snow, so snow hides it; c is the cover class (0 without a pack)
	if (hatch)
		swap(
			"#ifdef TERROIR_SNOW\n  if (c != 12) col = mix(",
			`  col = mix(col, col * vec3(${HATCH_INK}), terHatch(n, xy, vElev, terFw, fwidth(vElev), c));\n#ifdef TERROIR_SNOW\n  if (c != 12) col = mix(`,
		);
	return out;
}

/** Anchors both terrain fragment shaders share (deck terrain-layer.ts, three materials.ts). */
const ANCHOR_ALPINE_DEF = "vec3 alpineAlbedo(float elev, vec3 n, vec2 xy) {";
const ANCHOR_HYPSO_DEF = "vec3 hypso(float h) {";
/** the contour line ramp, right after the ALBEDO block: the terroir functions go before it */
const ANCHOR_LINE_RAMP = '// "topology" ramp for contour lines';

type Engine = "deck" | "three";

/** Per engine: [anchor, code, inserted before / after the anchor]. */
function injections(engine: Engine, defines: readonly string[]) {
	const has = (d: string) => defines.includes(d);
	const contours =
		has("TERROIR_CONTOUR_ADAPTIVE") || has("TERROIR_CONTOUR_INK");
	const cover = has("TERROIR_COVER");
	const albedo = cover || has("TERROIR_SNOW") || has("TERROIR_HATCH");
	const out: [string, string, "before" | "after"][] = [];
	const deck = engine === "deck";
	if (albedo)
		out.push(
			[ANCHOR_ALPINE_DEF, RENAME_ALPINE, "before"],
			[ANCHOR_HYPSO_DEF, RENAME_HYPSO, "before"],
		);
	out.push([
		ANCHOR_LINE_RAMP,
		(deck
			? "#define TER_SUN terrain.sunDir.xyz\n"
			: `#define TER_SUN uSunDir\nuniform sampler2D terroirCover;\n${TER_BLOCK.threeDecl}`) +
			fnsFor(has("TERROIR_PATTERN"), has("TERROIR_HATCH")) +
			(albedo ? WRAP_ALBEDO : "") +
			"\n",
		"before",
	]);
	if (contours)
		out.push(
			deck
				? [
						"    float a = max(minorA * terrain.minorAlpha, majorA * terrain.majorAlpha) * mix(terrain.fadeFloor, 1.0, fade) * near;\n",
						`#ifndef LOOK_TANAKA
    if (style == 2) {
      vec4 terC = terContour(vElev, range, vWorld.xy, terrain.contourInterval, terrain.contourMajorEvery, terrain.contourWidth, terrain.contourMajorMul, terrain.densityFade, terrain.minorAlpha, terrain.majorAlpha, mix(terrain.fadeFloor, 1.0, fade) * near, terrain.contourSolid > 0.5, toLinear(terrain.contourMinorCol.rgb), toLinear(terrain.contourMajorCol.rgb), lineRamp(elevT(vElev)), terrain.casing, terrain.casingCol.rgb);
      fragColor = vec4(outColor(terC.rgb), terC.a * terrain.contourOpacity);
      return;
    }
#endif
`,
						"after",
					]
				: [
						"    float a = max(minorA * uMinorAlpha, majorA * uMajorAlpha) * mix(uFadeFloor, 1.0, fade) * near;\n",
						`#ifndef LOOK_TANAKA
    if (uStyle == 2) {
      vec4 terC = terContour(vElev, range, vWorld.xy, uContourInterval, uContourMajorEvery, uContourWidth, uContourMajorMul, uDensityFade, uMinorAlpha, uMajorAlpha, mix(uFadeFloor, 1.0, fade) * near, uContourSolid > 0.5, toLinear(uContourMinorCol), toLinear(uContourMajorCol), lineRamp(t), uCasing, uCasingCol);
      gl_FragColor = vec4(terC.rgb, terC.a * uContourOpacity);
      return;
    }
#endif
`,
						"after",
					],
		);
	if (cover) {
		const shaded = (
			styleExpr: string,
			mapExpr: string,
		) => `  if (${styleExpr} == 1 && ${mapExpr} > 0.5) {
#ifdef LOOK_RELIEF
    vec3 terCv = reliefShade(ALBEDO(n), n, vWorld, range);
#else
    vec3 terCv = ALBEDO(n) * shade(n);
#endif
    base = mix(base, terCv, terSteep(n, vWorld.xy));
  }
`;
		out.push(
			deck
				? [
						"      base = mix(base, terrain.imgTint.rgb * (dot(base, vec3(0.2126, 0.7152, 0.0722)) / tl), terrain.imgTint.a);\n    }\n  }\n",
						shaded("style", "terrain.hasMap"),
						"after",
					]
				: [
						"    base = ALBEDO(n) * shade(n);\n#endif\n  }\n",
						shaded("uStyle", "hasMap"),
						"after",
					],
		);
	}
	return out;
}

export const isTerroirDefine = (d: string) => d.startsWith("TERROIR_");

/**
 * The terrain fragment shader with the terroir code spliced in for `defines` (its TERROIR_* subset);
 * `src` itself when there is none. Throws if an anchor is missing (the terrain shader changed).
 */
export function terroirTerrainFs(
	engine: Engine,
	src: string,
	defines: readonly string[],
): string {
	const d = defines.filter(isTerroirDefine);
	if (!d.length) return src;
	let out = src;
	for (const [anchor, code, where] of injections(engine, d)) {
		const i = out.indexOf(anchor);
		if (i < 0 || out.indexOf(anchor, i + 1) >= 0)
			throw new Error(
				`terroir: ${engine} terrain shader anchor missing or ambiguous: ${JSON.stringify(anchor.slice(0, 60))}`,
			);
		const at = where === "before" ? i : i + anchor.length;
		out = out.slice(0, at) + code + out.slice(at);
	}
	return out;
}

/** The deck (luma) binding: the std140 block + the cover sampler, fragment stage only. */
export const TERROIR_LUMA_MODULE = {
	...TER_BLOCK.lumaModule,
	vs: "",
	fs: `${TER_BLOCK.lumaModule.fs}uniform sampler2D terroirCover;\n`,
};
