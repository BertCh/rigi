// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// deck.gl port of ../materials.ts: one uber-shader per terrain tile.
//   style 0 hillshade · 1 imagery · 2 contours (transparent, for over the photo) · 4 elevation bands
//   · 3 geometry (range from the camera, r channel; written by the GPU geometry pass only)
// plus projective photo draping (uProjectPhoto) masked by the photo camera's range map, and a
// logarithmic depth buffer so 5 m → 150 km share one frustum without z-fighting.
// World view only (LOOK_CLEARAIR): the drape sample has the photo's own haze inverted along the photo
// camera ray (look/clear-air) before the view's haze goes on, so far ground is not hazed twice.
import {
	COORDINATE_SYSTEM,
	CompositeLayer,
	type Layer,
	type LayerProps,
	project32,
	type UpdateParameters,
} from "@deck.gl/core";
import type { Device, Texture } from "@luma.gl/core";
import type { Model } from "@luma.gl/engine";
import type { ShaderModule } from "@luma.gl/shadertools";
import type { LiveSource } from "../live/contract";
import type { ClearAirValues } from "../look/clear-air";
import { CLEAR_AIR_OFF } from "../look/clear-air";
import type { harmonizeValues } from "../look/composite";
import { ATM_BLOCK, ATM_LUMA_MODULE } from "../look/glsl/atmosphere";
import { CLEAR_AIR_BLOCK, CLEAR_AIR_LUMA_MODULE } from "../look/glsl/clear-air";
import { HARM_BLOCK, HARMONIZE_FNS } from "../look/glsl/composite";
import {
	ALPINE_FNS,
	SLOPE_BLOCK,
	SLOPE_LUMA_MODULE,
	TANAKA_FNS,
} from "../look/glsl/ramps";
import { REL_BLOCK, REL_LUMA_MODULE } from "../look/glsl/relief";
import { withSlopeLayer } from "../look/look-key";
import type { ReliefField } from "../look/relief/field";
import { WATER_FNS } from "../look/water/water";
import {
	WATER_WAVES_BLOCK,
	WATER_WAVES_FNS,
	waterWaveSeconds,
} from "../look/water/waves";
import { PROVENANCE_COLORS } from "../nearfield/provenance";
import { type DeckTerrainStyle, deckTerrainStyle } from "../style/deck-apply";
import { CLASSIC } from "../style/defaults";
import {
	TER_BLOCK,
	TERROIR_LUMA_MODULE,
	terroirTerrainFs,
} from "../terroir/glsl/terrain";
import {
	coverTexels,
	type TerroirShader,
	terroirBlockValues,
	terroirMajorEvery,
} from "../terroir/glsl/values";
import { BatchedTerrainTileLayer } from "./batched-terrain-layer";
import type { TileMesh } from "./terrain-data";

export const STYLE = {
	hillshade: 0,
	imagery: 1,
	contours: 2,
	elevation: 4,
	/** Debug: colour by true (face) slope; magenta ≥ 85° = vertical walls / skirts. */
	slope: 5,
	/** The slope layer (FATMAP classes), only in a LOOK_SLOPE program. */
	slopeClass: 6,
} as const;

/** The normal pass (ink creases, composite.ts), only in a LOOK_INK program. */
const STYLE_NORMAL = 7;
export type TerrainStyle = keyof typeof STYLE;

/** Far limit for the log depth mapping, in whatever units the view's clip w uses. */
export const LOG_DEPTH_FAR = 1e9;

/**
 * Offscreen terrain passes (geometry-pass.ts / composite.ts). deck renders synchronously, so the
 * pass that is drawing right now is a module-level flag the tile layers read in draw():
 *   'geometry' → style 3 (range to r, no blending, float target)
 *   'color'    → the layer's own style, LINEAR output and straight alpha
 *   'normal'   → style 7 (world normal, LOOK_INK creases)
 * Pass names seen by filterSubLayer are `terrain-<kind>`.
 */
export type TerrainPassKind = "geometry" | "color" | "normal";
let activePass: TerrainPassKind | null = null;
/** The offscreen terrain pass drawing right now (null = the normal canvas pass). */
export function currentTerrainPass() {
	return activePass;
}
export function withTerrainPass<T>(kind: TerrainPassKind, fn: () => T): T {
	const prev = activePass;
	activePass = kind;
	try {
		return fn();
	} finally {
		activePass = prev;
	}
}

const uniformBlock = /* glsl */ `\
layout(std140) uniform terrainUniforms {
  mat4 photoViewProj;
  vec4 photoPos;
  vec4 sunDir;
  vec4 hazeColor;
  vec2 elevRange;
  float style;
  float hasMap;
  float contourInterval;
  float contourMajorEvery;
  float contourWidth;
  float contourOpacity;
  float fadeNear;
  float fadeFar;
  float projectPhoto;
  float photoTint;
  float logDepthFC;
  float nearFade;
  float nearDiscard;
  float linearOut;
  float photoFgOn;
  // ---- view style (src/lib/style/deck-apply.ts deckTerrainStyle); ramps as mat4 (see rampU) ----
  mat4 reliefC0;
  mat4 reliefC1;
  mat4 reliefDE;
  mat4 lineC0;
  mat4 lineC1;
  mat4 lineDE;
  mat4 bandC0;
  mat4 bandC1;
  mat4 bandDE;
  vec4 rampN;
  vec4 shadeHaze;
  vec4 densityFade;
  vec4 contourMinorCol;
  vec4 contourMajorCol;
  vec4 casing;
  vec4 casingCol;
  vec4 bandLineCol;
  vec4 bandParams;
  vec4 imgAdj;
  vec4 imgTint;
  vec4 photoTintCol;
  vec4 truthObs;
  vec4 truthDem;
  vec2 bandShade;
  float contourMajorMul;
  float minorAlpha;
  float majorAlpha;
  float fadeFloor;
  float contourSolid;
  float truth;
} terrain;
`;

type TerrainModuleProps = {
	photoViewProj: number[];
	photoPos: number[];
	sunDir: number[];
	hazeColor: number[];
	elevRange: number[];
	style: number;
	hasMap: number;
	contourInterval: number;
	contourMajorEvery: number;
	contourWidth: number;
	contourOpacity: number;
	fadeNear: number;
	fadeFar: number;
	projectPhoto: number;
	photoTint: number;
	logDepthFC: number;
	nearFade: number;
	nearDiscard: number;
	linearOut: number;
	photoFgOn: number;
	reliefC0: number[];
	reliefC1: number[];
	reliefDE: number[];
	lineC0: number[];
	lineC1: number[];
	lineDE: number[];
	bandC0: number[];
	bandC1: number[];
	bandDE: number[];
	/** relief n, line n, band n, - */
	rampN: number[];
	/** ambient, direct, haze density, haze max */
	shadeHaze: number[];
	densityFade: number[];
	contourMinorCol: number[];
	contourMajorCol: number[];
	casing: number[];
	casingCol: number[];
	/** rgb, line whiten */
	bandLineCol: number[];
	/** alpha, line alpha, ground fade lo, hi */
	bandParams: number[];
	/** saturation, brightness, contrast, on */
	imgAdj: number[];
	/** linear rgb, amount */
	imgTint: number[];
	photoTintCol: number[];
	/** Truth toggle tints (sRGB rgb, -): observed drape, DEM terrain. */
	truthObs: number[];
	truthDem: number[];
	/** shadeMin, 1 - shadeMin */
	bandShade: number[];
	contourMajorMul: number;
	minorAlpha: number;
	majorAlpha: number;
	fadeFloor: number;
	contourSolid: number;
	/** Truth toggle: 0 = off (classic), else how much of the provenance tint replaces the colour. */
	truth: number;
	terrainMap: Texture;
	photoTexture: Texture;
	photoRange: Texture;
	photoFg: Texture;
};

export const terrainModule = {
	name: "terrain",
	vs: uniformBlock,
	fs: uniformBlock,
	uniformTypes: {
		photoViewProj: "mat4x4<f32>",
		photoPos: "vec4<f32>",
		sunDir: "vec4<f32>",
		hazeColor: "vec4<f32>",
		elevRange: "vec2<f32>",
		style: "f32",
		hasMap: "f32",
		contourInterval: "f32",
		contourMajorEvery: "f32",
		contourWidth: "f32",
		contourOpacity: "f32",
		fadeNear: "f32",
		fadeFar: "f32",
		projectPhoto: "f32",
		photoTint: "f32",
		logDepthFC: "f32",
		nearFade: "f32",
		nearDiscard: "f32",
		linearOut: "f32",
		photoFgOn: "f32",
		reliefC0: "mat4x4<f32>",
		reliefC1: "mat4x4<f32>",
		reliefDE: "mat4x4<f32>",
		lineC0: "mat4x4<f32>",
		lineC1: "mat4x4<f32>",
		lineDE: "mat4x4<f32>",
		bandC0: "mat4x4<f32>",
		bandC1: "mat4x4<f32>",
		bandDE: "mat4x4<f32>",
		rampN: "vec4<f32>",
		shadeHaze: "vec4<f32>",
		densityFade: "vec4<f32>",
		contourMinorCol: "vec4<f32>",
		contourMajorCol: "vec4<f32>",
		casing: "vec4<f32>",
		casingCol: "vec4<f32>",
		bandLineCol: "vec4<f32>",
		bandParams: "vec4<f32>",
		imgAdj: "vec4<f32>",
		imgTint: "vec4<f32>",
		photoTintCol: "vec4<f32>",
		truthObs: "vec4<f32>",
		truthDem: "vec4<f32>",
		bandShade: "vec2<f32>",
		contourMajorMul: "f32",
		minorAlpha: "f32",
		majorAlpha: "f32",
		fadeFloor: "f32",
		contourSolid: "f32",
		truth: "f32",
	},
} as const satisfies ShaderModule;

/** The terrain fragment shader (batched-terrain-layer.ts supplies the vertex shader). */
export const fs = /* glsl */ `#version 300 es
#define SHADER_NAME terrain-tile-fs
precision highp float;
uniform sampler2D terrainMap;
uniform sampler2D photoTexture;
uniform sampler2D photoRange;
uniform sampler2D photoFg;
in vec3 vWorld;
in vec3 vNormal;
in vec2 vUv;
in float vElev;
in float vLogW;
in vec3 vCamera;
out vec4 fragColor;

// Colour pipeline: ramps are mixed in
// sRGB then pow(2.2)'d, textures are decoded to linear, everything is shaded/hazed/blended in
// linear, and the result is encoded with the sRGB OETF at the very end.
vec3 toLinear(vec3 c) { return pow(c, vec3(2.2)); }
vec3 srgbDecode(vec3 c) {
  return mix(pow(c * 0.9478672986 + vec3(0.0521327014), vec3(2.4)), c * 0.0773993808, vec3(lessThanEqual(c, vec3(0.04045))));
}
vec3 srgbEncode(vec3 c) {
  c = max(c, vec3(0.0));
  return mix(pow(c, vec3(0.41666)) * 1.055 - vec3(0.055), c * 12.92, vec3(lessThanEqual(c, vec3(0.0031308))));
}

// the colour pass (composite.ts) keeps everything linear
vec3 outColor(vec3 c) { return terrain.linearOut > 0.5 ? max(c, vec3(0.0)) : srgbEncode(c); }

// Ramps (materials.ts RAMP_GLSL rampEval): stop i = column i of C0 (0-3) / C1 (4-7), rgb = sRGB
// colour, a = t; DE columns 0-1 = segment divisors, 2-3 = smoothstep flags. Mixed in sRGB, then
// pow(2.2), the order the classic hypso()/coolRamp() used.
vec4 rampStop(mat4 C0, mat4 C1, int i) { return i < 4 ? C0[i] : C1[i - 4]; }
float rampDiv(mat4 DE, int i) { return (i < 4 ? DE[0] : DE[1])[i & 3]; }
float rampEase(mat4 DE, int i) { return (i < 4 ? DE[2] : DE[3])[i & 3]; }
vec3 rampEval(mat4 C0, mat4 C1, mat4 DE, float nf, float t) {
  int n = int(nf + 0.5);
  vec4 prev = rampStop(C0, C1, 0);
  vec3 c = prev.rgb;
  for (int i = 1; i < 8; i++) {
    if (i >= n) break;
    vec4 s = rampStop(C0, C1, i);
    if (t < s.a || i == n - 1) {
      float f = rampEase(DE, i) > 0.5 ? smoothstep(prev.a, s.a, t) : clamp((t - prev.a) / rampDiv(DE, i), 0.0, 1.0);
      c = mix(prev.rgb, s.rgb, f);
      break;
    }
    prev = s;
  }
  return c;
}

float elevT(float h) {
  return clamp((h - terrain.elevRange.x) / (terrain.elevRange.y - terrain.elevRange.x), 0.0, 1.0);
}

vec3 hypso(float h) {
  return toLinear(rampEval(terrain.reliefC0, terrain.reliefC1, terrain.reliefDE, terrain.rampN.x, elevT(h)));
}
#ifdef LOOK_ALPINE
${ALPINE_FNS}
#endif
#ifdef LOOK_WATER
#ifdef LOOK_WATER_WAVES
${WATER_WAVES_FNS}
#endif
${WATER_FNS}
#endif
#ifdef LOOK_TANAKA
${TANAKA_FNS}
#endif
#ifdef LOOK_HARMONIZE
${HARMONIZE_FNS}
#endif

// the hillshade albedo: the relief ramp, or the Alpine tint (LOOK_ALPINE)
#ifdef LOOK_ALPINE
#ifdef LOOK_WATER
#define ALBEDO(n) waterShade(alpineAlbedo(vElev, n, vWorld.xy), vElev, vWorld.xy, n, normalize(vCamera - vWorld), range)
#else
#define ALBEDO(n) alpineAlbedo(vElev, n, vWorld.xy)
#endif
#else
#define ALBEDO(n) hypso(vElev)
#endif

// "topology" ramp for contour lines (classic: cool teal → cyan → violet → magenta → cream)
vec3 lineRamp(float t) {
  return toLinear(rampEval(terrain.lineC0, terrain.lineC1, terrain.lineDE, terrain.rampN.y, clamp(t, 0.0, 1.0)));
}

vec3 bandRamp(float t) {
  return toLinear(rampEval(terrain.bandC0, terrain.bandC1, terrain.bandDE, terrain.rampN.z, clamp(t, 0.0, 1.0)));
}

float shade(vec3 n) {
  float l = max(dot(n, terrain.sunDir.xyz), 0.0);
  float sky = 0.5 + 0.5 * n.z;
  return terrain.shadeHaze.x * sky + terrain.shadeHaze.y * l;
}

// hazeColor arrives linear and is re-linearised on purpose, which gives the darker, bluer haze tone.
vec3 haze(vec3 col, float range) {
  float f = 1.0 - exp(-range * terrain.shadeHaze.z * terrain.hazeColor.a);
  return mix(col, toLinear(terrain.hazeColor.rgb), clamp(f, 0.0, terrain.shadeHaze.w));
}

float contourLine(float e, float widthPx) {
  float fw = fwidth(e);
  float d = abs(fract(e - 0.5) - 0.5) / max(fw, 1e-6);
  return 1.0 - smoothstep(widthPx * 0.5, widthPx * 0.5 + 1.0, d);
}

void main() {
  vec3 n = normalize(vNormal);
  float range = length(vWorld - vCamera);
  // photo-camera passes only: terrain closer than the GPS error is in the wrong place anyway (the
  // radius the near fade reaches zero at); drop it so the view reaches the terrain beyond
  if (range < terrain.nearDiscard) discard;
  int style = int(terrain.style + 0.5);

  if (style == 3) {
    // materials.ts style 3 (geometry): the range feeds ridges, skyline, occlusion and the drape
    fragColor = vec4(range, 0.0, 0.0, 1.0);
    return;
  }
#ifdef LOOK_INK
  // the normal pass for the composite's ink creases
  if (style == 7) {
    fragColor = vec4(n, 1.0);
    return;
  }
#endif

  if (style == 5) {
    vec3 nf = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
    if (nf.z < 0.0) nf = -nf;
    float deg = degrees(acos(clamp(nf.z, 0.0, 1.0)));
    vec3 c = deg < 30.0 ? vec3(0.35, 0.75, 0.35)
      : deg < 45.0 ? vec3(0.95, 0.9, 0.3)
      : deg < 55.0 ? vec3(1.0, 0.6, 0.2)
      : deg < 70.0 ? vec3(0.9, 0.15, 0.15)
      : deg < 85.0 ? vec3(0.45, 0.2, 0.8)
      : vec3(1.0, 0.0, 1.0);
    fragColor = vec4(outColor(haze(toLinear(c) * (0.6 + 0.4 * shade(n)), range * 0.3)), 1.0);
    return;
  }

#ifdef LOOK_SLOPE
  if (style == 6) {
    vec4 sc = slopeClass(n);
    float near = terrain.nearFade > 0.0 ? smoothstep(terrain.nearFade * 0.5, terrain.nearFade, range) : 1.0;
    fragColor = vec4(outColor(sc.rgb), sc.a * near * terrain.contourOpacity);
    return;
  }
#endif

  if (style == 2 || style == 4) {
    // port of materials.ts styles 2 / 4 (colours linear, sRGB-encoded on output)
    float e = vElev / terrain.contourInterval;
    float fade = 1.0 - smoothstep(terrain.fadeNear, terrain.fadeFar, range);
    // lines that get denser than ~3px apart turn into mush: fade them out
    float minorFade = 1.0 - smoothstep(terrain.densityFade.x, terrain.densityFade.y, fwidth(e));
    float minorA = contourLine(e, terrain.contourWidth) * minorFade;
    float em = e / terrain.contourMajorEvery;
    float majorFade = 1.0 - smoothstep(terrain.densityFade.z, terrain.densityFade.w, fwidth(em));
    float majorA = contourLine(em, terrain.contourWidth * terrain.contourMajorMul) * majorFade;
    vec3 lc = terrain.contourSolid > 0.5
      ? toLinear(majorA * terrain.majorAlpha >= minorA * terrain.minorAlpha ? terrain.contourMajorCol.rgb : terrain.contourMinorCol.rgb)
      : lineRamp(elevT(vElev));
    // terrain closer than the GPS error is in the wrong place anyway: fade it
    float near = terrain.nearFade > 0.0 ? smoothstep(terrain.nearFade * 0.5, terrain.nearFade, range) : 1.0;
    float a = max(minorA * terrain.minorAlpha, majorA * terrain.majorAlpha) * mix(terrain.fadeFloor, 1.0, fade) * near;
#ifdef LOOK_TANAKA
    if (style == 2) {
      vec4 tk = tanakaLines(vElev, terrain.contourInterval, terrain.contourMajorEvery, n, terrain.sunDir.xyz, vWorld, vCamera, range);
      fragColor = vec4(outColor(tk.rgb), tk.a * mix(terrain.fadeFloor, 1.0, fade) * near * terrain.contourOpacity);
      return;
    }
#endif
    if (style == 4) {
      float step = terrain.contourInterval * terrain.contourMajorEvery;
      float bt = clamp((floor(vElev / step) * step - terrain.elevRange.x) / (terrain.elevRange.y - terrain.elevRange.x), 0.0, 1.0);
#ifdef LOOK_RELIEF
      vec3 bc = bandRamp(bt) * (terrain.bandShade.x + terrain.bandShade.y * reliefLight(n, vWorld, range));
#else
      vec3 bc = bandRamp(bt) * (terrain.bandShade.x + terrain.bandShade.y * shade(n));
#endif
      // the ground at your feet reads better as photo than as a flat tint
      fragColor = vec4(outColor(mix(bc, terrain.bandLineCol.rgb, a * terrain.bandLineCol.a)),
        (terrain.bandParams.x + terrain.bandParams.y * a) * smoothstep(terrain.bandParams.z, terrain.bandParams.w, range));
    } else if (terrain.casing.x > 0.5) {
      // dark casing just outside the line keeps it legible over snow and bright sky
      float casing = max(contourLine(e, terrain.contourWidth + terrain.casing.y) * minorFade * terrain.casing.z,
        contourLine(em, terrain.contourWidth * terrain.contourMajorMul + terrain.casing.y) * majorFade) * mix(terrain.fadeFloor, 1.0, fade) * near;
      vec3 c = mix(terrain.casingCol.rgb, lc, a / max(casing, 1e-3));
      fragColor = vec4(outColor(c), max(a, casing * terrain.casing.w) * terrain.contourOpacity);
    } else {
      fragColor = vec4(outColor(lc), a * terrain.contourOpacity);
    }
    return;
  }

#ifdef LOOK_RELIEF
  vec3 base = reliefShade(ALBEDO(n), n, vWorld, range);
#else
  vec3 base = ALBEDO(n) * shade(n);
#endif
  if (style == 1 && terrain.hasMap > 0.5) {
    base = srgbDecode(texture(terrainMap, vUv).rgb);
    // Orthoimagery is a top-down projection: on true cliffs a few texels get smeared down the
    // face. z14 normals never fade; deck's z17 normals pass 55° on ordinary forested
    // slopes, where the old grey rock tone read as missing texture. Now only near-vertical faces
    // (> ~70°) soften, at most halfway, towards the imagery's own local average (coarse mip).
    float steep = 1.0 - smoothstep(0.17, 0.34, n.z); // cos 80°, cos 70°
    if (steep > 0.0) {
      vec3 avg = srgbDecode(textureLod(terrainMap, vUv, 3.0).rgb);
      base = mix(base, avg * (0.7 + 0.45 * shade(n)), 0.5 * steep);
    }
    // imagery adjust (materials.ts; identity = skipped)
    if (terrain.imgAdj.w > 0.5) {
      float l = dot(base, vec3(0.2126, 0.7152, 0.0722));
      base = mix(vec3(l), base, terrain.imgAdj.x);
      base = max((base - 0.18) * terrain.imgAdj.z + 0.18, 0.0) * terrain.imgAdj.y;
      // tint: shift the hue toward the tint colour at constant luminance
      float tl = max(dot(terrain.imgTint.rgb, vec3(0.2126, 0.7152, 0.0722)), 1e-3);
      base = mix(base, terrain.imgTint.rgb * (dot(base, vec3(0.2126, 0.7152, 0.0722)) / tl), terrain.imgTint.a);
    }
  }

  if (terrain.projectPhoto > 0.0) {
    vec4 clip = terrain.photoViewProj * vec4(vWorld, 1.0);
    vec2 puv = clip.xy / (abs(clip.w) > 1e-6 ? clip.w : 1e-6) * 0.5 + 0.5;
    puv.y = 1.0 - puv.y; // photo + range map rows run top → bottom
    // The photo is mip-mapped and sampled inside the per-fragment visibility branches below, where
    // implicit derivatives are undefined (the chosen mip level at the occlusion edges changed
    // whenever the shader was recompiled): take the gradients here, in uniform control flow.
    vec2 pdx = dFdx(puv);
    vec2 pdy = dFdy(puv);
    if (clip.w > 0.0) {
      if (all(greaterThan(puv, vec2(0.0))) && all(lessThan(puv, vec2(1.0)))) {
        float r = length(vWorld - terrain.photoPos.xyz);
#ifdef LOOK_HARMONIZE
        // inside the photo's footprint, tone the render toward the photo so the holes the photo
        // can't fill read as intentional; feathered over a quarter of the frame
        vec2 edge = min(puv, 1.0 - puv);
        if (hrm_amount > 0.0) base = mix(base, harmonize(base, r), smoothstep(0.0, 0.25, min(edge.x, edge.y)));
#endif
        float seen = texture(photoRange, puv).r;
        // visible from the photo camera if not occluded (range test with relative bias; the range
        // map is the GPU geometry pass; bias 1.5 % + 15 m)
        bool visible = seen > 0.0 && r < seen * 1.015 + 15.0 && r > terrain.photoPos.w;
        // people in the photo would smear across the ground behind them
        if (terrain.photoFgOn > 0.5 && texture(photoFg, puv).r > 0.5) visible = false;
        if (visible) {
          vec3 pc = srgbDecode(textureGrad(photoTexture, puv, pdx, pdy).rgb);
#ifdef LOOK_CLEARAIR
          // the photo's own haze off (look/clear-air): the view's haze goes on below, once
          if (terrain.projectPhoto < 1.5) pc = clearAirPhoto(pc, vWorld, terrain.photoPos.xyz);
#endif
          vec3 ray = normalize(vWorld - terrain.photoPos.xyz);
          float inc = clamp(-dot(ray, n) * 3.0, 0.0, 1.0);
          // projectPhoto > 1.5: Step Inside (seen from the photo camera the drape is the photo itself)
          base = mix(base, pc, terrain.projectPhoto > 1.5 ? 1.0 : terrain.projectPhoto * mix(0.35, 1.0, inc));
          base = mix(base, base * terrain.photoTintCol.rgb, terrain.photoTint);
        }
      }
    }
  }

  // Step Inside "Truth" (terrain.truth > 0, world / step view only; materials.ts uTruth): the drape's photo
  // pixels (the visibility test above) = observed, every other terrain fragment = dem
  if (terrain.truth > 0.0) {
    bool seenT = false;
    vec4 clipT = terrain.photoViewProj * vec4(vWorld, 1.0);
    if (terrain.projectPhoto > 0.0 && clipT.w > 0.0) {
      vec2 puvT = clipT.xy / clipT.w * 0.5 + 0.5;
      puvT.y = 1.0 - puvT.y;
      if (all(greaterThan(puvT, vec2(0.0))) && all(lessThan(puvT, vec2(1.0)))) {
        float rT = length(vWorld - terrain.photoPos.xyz);
        float seen = textureLod(photoRange, puvT, 0.0).r;
        seenT = seen > 0.0 && rT < seen * 1.015 + 15.0 && rT > terrain.photoPos.w;
        if (terrain.photoFgOn > 0.5 && textureLod(photoFg, puvT, 0.0).r > 0.5) seenT = false;
      }
    }
    base = mix(base, srgbDecode(seenT ? terrain.truthObs.rgb : terrain.truthDem.rgb), terrain.truth);
  }

#ifdef LOOK_ATMOSPHERE
  fragColor = vec4(outColor(applyAtmosphere(base, vWorld)), 1.0);
#else
  fragColor = vec4(outColor(haze(base, range)), 1.0);
#endif
}
`;

// ---------- one tile ----------

export type TerrainUniformProps = {
	style: TerrainStyle;
	/**
	 * The view style's terrain uniforms (sun, shading, ramps, haze, contour / casing / band look,
	 * imagery adjust, projection tint): deckTerrainStyle(style, mode) from src/lib/style/deck-apply.ts.
	 * Default: the classic look in overlay mode.
	 */
	look: DeckTerrainStyle;
	contourInterval: number;
	contourOpacity: number;
	elevRange: [number, number];
	/** Haze amount; null = the look's (overlay 1, replace / world from the style). */
	haze: number | null;
	/** 0..1 blend of the projected photo. */
	projectPhoto: number;
	photoViewProj: number[] | null;
	photoPos: [number, number, number];
	photoMinRange: number;
	/** Fade contours/bands over terrain closer than this (m; the GPS error). 0 = off. */
	nearFade: number;
	/**
	 * Near-fade radius (m; scene.ts nearFadeFor(hAccuracy)) for the photo-camera passes (geometry /
	 * colour) only: terrain within half of it, where that fade reaches zero, is discarded. 0 = off.
	 */
	nearDiscard: number;
	/** Keep people (photoFg mask) out of the drape. */
	protectPeople: boolean;
	/** The drape's band stats (world.drapeHarmonize, LOOK_HARMONIZE): look/composite.ts harmonizeValues. */
	harmonize: ReturnType<typeof harmonizeValues> | null;
	/** The photo's haze inversion on the drape (world.clearAir, LOOK_CLEARAIR): look/clear-air.ts clearAirValues. */
	clearAir?: ClearAirValues | null;
	/** Step Inside Truth toggle (world drape only): 0 = off, else the provenance tint's mix. */
	truth: number;
	/** Terroir shading (src/lib/terroir/glsl; TERROIR_* defines): null = off, the classic programs. */
	terroir: TerroirShader | null;
};

/** Everything the terrain shaders read that isn't geometry (BatchedTerrainTileLayer). */
export type TerrainDrawProps = TerrainUniformProps & {
	photoTexture: Texture | null;
	photoRange: Texture | null;
	photoFg: Texture | null;
	emptyTexture: Texture;
	/** The relief field's textures (LOOK_RELIEF), null until built. */
	reliefTex: { field: Texture; gen: Texture; extent: number[] } | null;
	/** The terroir cover classes (r8, nearest; TERROIR_COVER / _INK), null until uploaded. */
	terroirTex?: Texture | null;
};

/**
 * The terrain writes its logarithmic depth (log2(1 + w) · logDepthFC, LOG_DEPTH_FAR) per vertex, in
 * gl_Position.z (terrainLogDepthModule): the convention trails, splats, 3D tiles, the world gizmo
 * and the roll drape test against. No fragment depth write, so early depth testing stays on.
 * The hardware's screen-linear interpolation of a per-vertex log is never nearer than the exact
 * value (log is concave) and at most (ln ρ)²/8 farther for a triangle whose far / near distance
 * ratio is ρ (multi-drape-layer.ts derives the same bound): millimetres on far tiles, a few cm
 * next to the camera. Layers writing the exact per-fragment value therefore still pass on the
 * terrain surface, and shared vertices keep seams crack-free.
 * The near plane moves to w = 0 (z = -w there): terrain between the camera and the view's near
 * distance is no longer clipped.
 */
/** Terrain log depth per vertex: z_ndc = 2 · log depth - 1. */
const terrainLogDepthModule = {
	name: "terrainLogDepth",
	inject: {
		"vs:#main-end": /* glsl */ `\
  gl_Position.z = (2.0 * log2(1.0 + max(gl_Position.w, 1e-6)) * terrain.logDepthFC - 1.0) * gl_Position.w;`,
	},
} as const satisfies ShaderModule;

/**
 * The terrain program's shaders for `p`'s look: the caller's `vs` + the shared fragment shader, the terrain
 * uniform module and the look's LOOK_* defines (none for classic: the classic program is unchanged).
 */
export function terrainShaders(
	p: Pick<TerrainUniformProps, "look" | "style"> & {
		terroir?: TerroirShader | null;
	},
	vs: string,
	extraModules: ShaderModule[] = [],
) {
	const d: string[] = [...tileDefines(p)];
	const base = [project32, terrainModule, ...extraModules];
	base.push(terrainLogDepthModule);
	if (!d.length) return { vs, fs, modules: base };
	const look = [
		d.includes("LOOK_ATMOSPHERE") && ATM_LUMA_MODULE,
		d.includes("LOOK_RELIEF") && REL_LUMA_MODULE,
		d.includes("LOOK_SLOPE") && SLOPE_LUMA_MODULE,
		d.includes("LOOK_HARMONIZE") && HARM_BLOCK.lumaModule,
		d.includes("LOOK_CLEARAIR") && CLEAR_AIR_LUMA_MODULE,
		d.includes("LOOK_WATER_WAVES") && WATER_WAVES_BLOCK.lumaModule,
		!!p.terroir?.defines.length && TERROIR_LUMA_MODULE,
	].filter((m) => !!m);
	return {
		vs,
		fs: terroirFs(p, fs),
		modules: [...base, ...look],
		defines: Object.fromEntries(d.map((k) => [k, true])),
	};
}

/**
 * `src` (the terrain fragment shader, or a variant of it: batched-terrain-layer.ts fsBatched) with
 * the terroir code spliced in for `p`'s TERROIR_* defines; `src` itself when terroir is off.
 */
export function terroirFs(
	p: Pick<TerrainUniformProps, "look" | "style"> & {
		terroir?: TerroirShader | null;
	},
	src: string,
) {
	return p.terroir?.defines.length
		? terroirTerrainFs(src, tileDefines(p))
		: src;
}

/**
 * Sets the terrain uniforms (and the look modules') on `model` for the pass drawing right now
 * (withTerrainPass). `viewport`: the pass's own (the atmosphere's eye).
 */
export function setTerrainShaderProps(
	model: Model,
	p: TerrainDrawProps,
	map: Texture | undefined,
	viewport: { cameraPosition: number[] },
) {
	const empty = p.emptyTexture;
	const pass = activePass;
	const geometry = pass === "geometry";
	const L = p.look;
	model.shaderInputs.setProps({
		terrain: {
			photoViewProj: p.photoViewProj ?? IDENTITY,
			photoPos: [...p.photoPos, p.photoMinRange],
			sunDir: [...L.sunDir, 0],
			hazeColor: [...L.hazeColor, p.haze ?? L.haze],
			elevRange: p.elevRange,
			style: geometry ? 3 : pass === "normal" ? STYLE_NORMAL : STYLE[p.style],
			hasMap: map ? 1 : 0,
			contourInterval: p.contourInterval,
			contourMajorEvery: L.contourMajorEvery,
			contourWidth: L.contourWidth,
			contourOpacity: p.contourOpacity,
			fadeNear: L.fadeNear,
			fadeFar: L.fadeFar,
			projectPhoto:
				!pass && p.photoTexture && p.photoRange && p.photoViewProj
					? p.projectPhoto
					: 0,
			photoTint: L.photoTint,
			logDepthFC: 1 / Math.log2(LOG_DEPTH_FAR + 1),
			nearFade: p.nearFade,
			nearDiscard: pass ? p.nearDiscard * 0.5 : 0,
			linearOut: pass === "color" ? 1 : 0,
			photoFgOn: p.protectPeople && p.photoFg ? 1 : 0,
			reliefC0: L.relief.c0,
			reliefC1: L.relief.c1,
			reliefDE: L.relief.de,
			lineC0: L.line.c0,
			lineC1: L.line.c1,
			lineDE: L.line.de,
			bandC0: L.band.c0,
			bandC1: L.band.c1,
			bandDE: L.band.de,
			rampN: [L.relief.n, L.line.n, L.band.n, 0],
			shadeHaze: [...L.shade, ...L.hazeParams],
			densityFade: L.densityFade,
			contourMinorCol: [...L.contourMinorCol, 1],
			contourMajorCol: [...L.contourMajorCol, 1],
			casing: L.casing,
			casingCol: [...L.casingCol, 1],
			bandLineCol: [...L.bandLineCol, L.bandLineWhiten],
			bandParams: [
				L.bandAlpha,
				L.bandLineAlpha,
				L.bandGroundFade[0],
				L.bandGroundFade[1],
			],
			imgAdj: [...L.imgAdj, L.imgOn],
			imgTint: L.imgTint,
			photoTintCol: [...L.photoTintCol, 1],
			truthObs: TRUTH_OBS,
			truthDem: TRUTH_DEM,
			bandShade: L.bandShade,
			contourMajorMul: L.contourMajorMul,
			minorAlpha: L.minorAlpha,
			majorAlpha: L.majorAlpha,
			fadeFloor: L.fadeFloor,
			contourSolid: L.contourSolid,
			// the world drape only (the photo view's offscreen passes stay classic)
			truth: pass ? 0 : p.truth,
			terrainMap: map ?? empty,
			photoTexture: p.photoTexture ?? empty,
			photoRange: p.photoRange ?? empty,
			photoFg: p.photoFg ?? empty,
		} satisfies TerrainModuleProps,
	});
	if (L.atm && L.defines.includes("LOOK_ATMOSPHERE"))
		model.shaderInputs.setProps({
			atmosphere: ATM_BLOCK.pack({
				...L.atm,
				// the pass's own viewport: outside Deck's frame (the band stats' layer, the export)
				// context.viewport is whichever view Deck activated last
				eye: viewport.cameraPosition,
			}),
		});
	// the world drape only (the offscreen passes never project the photo)
	if (L.defines.includes("LOOK_HARMONIZE") && p.harmonize && !pass)
		model.shaderInputs.setProps({
			[HARM_BLOCK.name]: HARM_BLOCK.pack(p.harmonize),
		});
	// animated lakes (world view only): the wave clock, still under webdriver
	if (L.defines.includes("LOOK_WATER_WAVES") && !pass)
		model.shaderInputs.setProps({
			[WATER_WAVES_BLOCK.name]: WATER_WAVES_BLOCK.pack({
				time: waterWaveSeconds(),
			}),
		});
	if (L.defines.includes("LOOK_CLEARAIR") && !pass)
		model.shaderInputs.setProps({
			[CLEAR_AIR_BLOCK.name]: CLEAR_AIR_BLOCK.pack(p.clearAir ?? CLEAR_AIR_OFF),
		});
	if (p.style === "slopeClass")
		model.shaderInputs.setProps({
			slope: SLOPE_BLOCK.pack({
				alpha: L.slopeAlpha,
				c0: L.slopeColors[0],
				c1: L.slopeColors[1],
				c2: L.slopeColors[2],
				c3: L.slopeColors[3],
			}),
		});
	if (L.rel && L.defines.includes("LOOK_RELIEF")) {
		const r = p.reliefTex;
		model.shaderInputs.setProps({
			relief: {
				...REL_BLOCK.pack({ ...L.rel, extent: r?.extent ?? L.rel.extent }),
				reliefField: r?.field ?? empty,
				reliefGen: r?.gen ?? empty,
			},
		});
	}
	// terroir (src/lib/terroir/glsl): the Swiss index on the contour pass, the TER_BLOCK values
	const T = p.terroir;
	if (T) {
		if (T.swissIndex && p.style === "contours")
			model.shaderInputs.setProps({
				terrain: {
					contourMajorEvery: terroirMajorEvery(
						T,
						p.contourInterval,
						L.contourMajorEvery,
					),
				},
			});
		if (T.defines.length)
			model.shaderInputs.setProps({
				terroir: {
					...TER_BLOCK.pack(
						terroirBlockValues(T, p.contourInterval, L.contourMajorEvery),
					),
					terroirCover: p.terroirTex ?? empty,
				},
			});
	}
}

/** The style's LOOK_* defines, plus LOOK_SLOPE while the tile draws the slope layer (+ TERROIR_*). */
function tileDefines(
	p: Pick<TerrainUniformProps, "look" | "style"> & {
		terroir?: TerroirShader | null;
	},
): string[] {
	const d: string[] = withSlopeLayer(p.look.defines, p.style === "slopeClass");
	return p.terroir?.defines.length ? [...d, ...p.terroir.defines] : d;
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export function makeTexture(
	device: Device,
	image: ImageBitmap | HTMLImageElement,
	mipmaps: boolean,
) {
	const { width, height } = image;
	const tex = device.createTexture({
		data: image,
		width,
		height,
		mipLevels: mipmaps ? device.getMipLevelCount(width, height) : 1,
		sampler: {
			minFilter: "linear",
			magFilter: "linear",
			mipmapFilter: mipmaps ? "linear" : undefined,
			addressModeU: "clamp-to-edge",
			addressModeV: "clamp-to-edge",
			maxAnisotropy: mipmaps ? 8 : 1,
		},
	});
	if (mipmaps && device.type === "webgl") tex.generateMipmapsWebGL();
	return tex;
}

/**
 * One mipmapped GPU copy of the photo, shared by the compositor (photo view) and the TerrainLayer
 * (drape): a 2048 px upload with mips is ~90 ms of main thread and ~17 MB of GPU (more at 12 MP),
 * so it is made once. Owner = whoever created the holder (DeckEngine; a bare PhotoCompositor owns
 * its own): the owner calls release() when done. Users only get(); they never destroy the texture.
 * Replacing the source or asking for another device drops the old texture first.
 */
export class SharedPhotoTexture {
	private src: HTMLImageElement | ImageBitmap | null = null;
	private tex?: Texture;
	private device?: Device;
	/** Live video source (setLiveSource): wins over `src`, one persistent texture without mips. */
	private live: LiveSource | null = null;
	private liveTex?: Texture;
	private liveDevice?: Device;

	/** Use a live video source (null = back to the still photo); the live texture is made on refreshLive. */
	setLive(source: LiveSource | null) {
		if (source === this.live) return;
		this.live = source;
		if (!source) {
			this.liveTex?.destroy();
			this.liveTex = undefined;
		}
	}

	/**
	 * Copy the live source into its texture (texSubImage2D through luma copyExternalImage): allocated
	 * once at the source's size, no mips, reallocated only when the size changes. False = no frame yet.
	 */
	refreshLive(device: Device): boolean {
		const source = this.live;
		if (!source) return false;
		const width =
			"videoWidth" in source ? source.videoWidth : source.displayWidth;
		const height =
			"videoHeight" in source ? source.videoHeight : source.displayHeight;
		if (!width || !height) return false;
		if (
			this.liveTex &&
			(this.liveTex.width !== width ||
				this.liveTex.height !== height ||
				this.liveDevice !== device)
		) {
			this.liveTex.destroy();
			this.liveTex = undefined;
		}
		this.liveDevice = device;
		this.liveTex ??= device.createTexture({
			width,
			height,
			mipLevels: 1,
			sampler: {
				minFilter: "linear",
				magFilter: "linear",
				addressModeU: "clamp-to-edge",
				addressModeV: "clamp-to-edge",
			},
		});
		this.liveTex.copyExternalImage({ image: source as never, width, height });
		return true;
	}

	/** Point at a new photo (null = none); a changed source frees the texture. */
	setSource(src: HTMLImageElement | ImageBitmap | null) {
		if (src === this.src) return;
		this.src = src;
		this.release();
	}

	/** The texture on `device`, uploaded on first use; undefined without a source. */
	get(device: Device): Texture | undefined {
		if (this.live) return this.liveTex;
		if (!this.src) return undefined;
		if (this.tex && this.device !== device) this.release();
		if (!this.tex) {
			this.tex = makeTexture(device, this.src, true); // mipmaps: minified in the 3D view
			this.device = device;
		}
		return this.tex;
	}

	/** Free the texture (the source stays: the next get() uploads again). */
	release() {
		this.liveTex?.destroy();
		this.liveTex = undefined;
		this.tex?.destroy();
		this.tex = undefined;
		this.device = undefined;
	}
}

// ---------- all tiles ----------

/**
 * Range from the photo camera, row 0 = top, 0 = sky: CPU data (rangeMapFrom; the layer uploads its
 * own r32float texture) or a texture the caller owns and keeps alive while it is a prop (engine.ts
 * drapeRange: GpuGeometrySource.copyRangeTo, no CPU round trip), sampled nearest either way.
 */
export type PhotoRangeMap =
	| PhotoRangeData
	| { width: number; height: number; texture: Texture; data?: undefined };

/** A PhotoRangeMap's CPU form (rangeMapFrom). */
export type PhotoRangeData = {
	width: number;
	height: number;
	data: Float32Array;
	texture?: undefined;
};

export type TerrainLayerProps = LayerProps &
	Partial<TerrainUniformProps> & {
		tiles: TileMesh[];
		/** Draped imagery per tile id. */
		imagery?: Map<string, ImageBitmap>;
		photo?: HTMLImageElement | ImageBitmap | null;
		/**
		 * The photo as an already uploaded texture the caller owns (SharedPhotoTexture) and keeps
		 * alive while it is a prop; wins over `photo`, never destroyed by the layer.
		 */
		photoTexture?: Texture | null;
		/** Range from the photo camera, row 0 = top, 0 = sky (GPU geometry pass; PhotoRangeMap). */
		photoRange?: PhotoRangeMap | null;
		/** People mask (segmentForeground, row 0 = top): kept out of the drape. */
		photoFg?: { width: number; height: number; data: Uint8Array } | null;
		/** The Swiss relief's field (look/relief/field.ts; LOOK_RELIEF only). */
		relief?: ReliefField | null;
		/**
		 * Draw only in the offscreen terrain passes (geometry / colour), not to the canvas: the photo
		 * view's composite layer (composite.ts) puts the terrain on screen instead.
		 */
		offscreen?: boolean;
	};

/** Truth toggle tints (sRGB 0..1): the single palette in nearfield/provenance.ts. */
const TRUTH_OBS = [...PROVENANCE_COLORS.observed.map((c) => c / 255), 1];
const TRUTH_DEM = [...PROVENANCE_COLORS.dem.map((c) => c / 255), 1];

const DEFAULTS: TerrainUniformProps = {
	style: "hillshade",
	look: deckTerrainStyle(CLASSIC, "overlay"),
	contourInterval: 50, // engine.ts defaultSettings
	contourOpacity: 1,
	elevRange: [400, 4200],
	haze: null,
	projectPhoto: 0,
	photoViewProj: null,
	photoPos: [0, 0, 0],
	photoMinRange: 80, // engine.ts defaultSettings.minProjectRange
	nearFade: 0,
	nearDiscard: 0,
	protectPeople: true,
	harmonize: null,
	clearAir: null,
	truth: 0,
	terroir: null,
};

/**
 * Draw state of every terrain pass (canvas, geometry, colour, normal: the offscreen passes spread
 * the layer's parameters, geometry-pass.ts getLayerParameters).
 *
 * Back faces are culled, (front faces only). Both mesh paths
 * share buildMesh's triangulation (terrain-data.ts tileIndex / batched-terrain-grid.ts gridMesh):
 * grid row 0 = north, so (a, a + n, a + 1) runs south then east, counter-clockwise seen from +z
 * (ENU up) → front-facing under the right-handed photo / world projections. Skirt quads are
 * emitted in both windings, so they stay visible from either side. From the photo camera (above
 * the surface) a back face is only reached through it; DPR 1 diffs on IMG_6958 / 7086 / 7155 (photo
 * and world views) change ≤ 0.33 % of pixels by > 8/255: crest pixels where a back face used to win
 * the less-equal depth tie, and labels nudged by the geometry pass. Underground views see through
 * the terrain. Apple TBDR, DPR 2: MSAA colour pass 75–100 → 34–46 ms per redraw.
 */
export const TERRAIN_PARAMETERS = {
	cullMode: "back",
	// no frontFace: CCW is GL's default, and deck also hands layer parameters to the legacy GL
	// setter, where the string "ccw" reached glFrontFace as GL_INVALID_ENUM (257 errors per /photo visit)
	depthWriteEnabled: true,
	depthCompare: "less-equal",
} as const;

export class TerrainLayer extends CompositeLayer<TerrainLayerProps> {
	static layerName = "TerrainLayer";
	declare state: {
		empty?: Texture;
		photo?: Texture;
		/** `photo` is the caller's `photoTexture` prop (not ours to destroy). */
		photoShared?: boolean;
		range?: Texture;
		/** `range` was uploaded here from CPU data (not a caller-owned PhotoRangeMap.texture). */
		rangeOwned?: boolean;
		fg?: Texture;
		relief?: { field: Texture; gen: Texture; extent: number[] };
		/** the terroir cover classes (r8 nearest) and the grid they were uploaded from */
		terroirTex?: Texture;
		terroirGrid?: unknown;
	};

	initializeState() {
		const empty = this.context.device.createTexture({
			data: new Uint8Array(4),
			width: 1,
			height: 1,
		});
		this.setState({ empty });
	}

	updateState({ props, oldProps }: UpdateParameters<this>) {
		const device = this.context.device;
		if (
			props.photo !== oldProps.photo ||
			props.photoTexture !== oldProps.photoTexture
		) {
			if (!this.state.photoShared) this.state.photo?.destroy();
			const shared = props.photoTexture ?? undefined;
			this.setState({
				photo:
					shared ??
					(props.photo
						? makeTexture(device, props.photo, true) // mipmaps: minified in the 3D view
						: undefined),
				photoShared: !!shared,
			});
		}
		if (props.photoFg !== oldProps.photoFg) {
			this.state.fg?.destroy();
			this.setState({
				fg: props.photoFg ? maskTexture(device, props.photoFg) : undefined,
			});
		}
		if (props.relief !== oldProps.relief) {
			this.destroyRelief();
			const r = props.relief;
			const tex = (data: Uint8Array, res: number) =>
				device.createTexture({
					data,
					width: res,
					height: res,
					sampler: {
						minFilter: "linear",
						magFilter: "linear",
						addressModeU: "clamp-to-edge",
						addressModeV: "clamp-to-edge",
					},
				});
			this.setState({
				relief: r
					? {
							field: tex(r.field, r.res),
							gen: tex(r.gen, r.res),
							extent: r.extent,
						}
					: undefined,
			});
		}
		// terroir cover classes: uploaded once per grid (texels padded to the fit's row width)
		const tg = props.terroir?.fit ? props.terroir.grid : null;
		if (tg !== (this.state.terroirGrid ?? null)) {
			this.state.terroirTex?.destroy();
			const fit = props.terroir?.fit;
			this.setState({
				terroirGrid: tg,
				terroirTex:
					tg && fit
						? device.createTexture({
								data: coverTexels(tg, fit.texWidth),
								width: fit.texWidth,
								height: tg.height,
								format: "r8unorm",
								sampler: {
									minFilter: "nearest",
									magFilter: "nearest",
									addressModeU: "clamp-to-edge",
									addressModeV: "clamp-to-edge",
								},
							})
						: undefined,
			});
		}
		if (props.photoRange !== oldProps.photoRange) {
			if (this.state.rangeOwned) this.state.range?.destroy();
			const r = props.photoRange;
			this.setState({
				range: r ? (r.texture ?? rangeTexture(device, r)) : undefined,
				rangeOwned: !!r?.data,
			});
		}
	}

	finalizeState(context: Parameters<Layer["finalizeState"]>[0]) {
		super.finalizeState(context);
		this.state.empty?.destroy();
		if (!this.state.photoShared) this.state.photo?.destroy();
		if (this.state.rangeOwned) this.state.range?.destroy();
		this.state.fg?.destroy();
		this.destroyRelief();
		this.state.terroirTex?.destroy();
	}

	private destroyRelief() {
		this.state.relief?.field.destroy();
		this.state.relief?.gen.destroy();
	}

	/** Offscreen terrain is drawn by the `terrain-*` passes only (see TerrainLayerProps.offscreen). */
	filterSubLayer({ renderPass }: { renderPass: string }) {
		return !this.props.offscreen || renderPass.startsWith("terrain-");
	}

	renderLayers() {
		const { empty, photo, range, fg, relief, terroirTex } = this.state;
		if (!empty) return [];
		const u: TerrainUniformProps = { ...DEFAULTS };
		for (const k of Object.keys(DEFAULTS) as (keyof TerrainUniformProps)[]) {
			const v = this.props[k];
			if (v !== undefined) (u as Record<string, unknown>)[k] = v;
		}
		// every tile in one instanced draw per mesh resolution
		return [
			new BatchedTerrainTileLayer({
				...u,
				...this.getSubLayerProps({ id: "batched" }),
				coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
				pickable: false,
				parameters: TERRAIN_PARAMETERS,
				tiles: this.props.tiles,
				// the compositor's geometry cache key reads `mesh` (composite.ts geoKey)
				mesh: this.props.tiles,
				imagery: this.props.imagery ?? null,
				offscreen: !!this.props.offscreen,
				photoTexture: photo ?? null,
				photoRange: range ?? null,
				photoFg: fg ?? null,
				emptyTexture: empty,
				reliefTex: relief ?? null,
				terroirTex: terroirTex ?? null,
			}),
		];
	}
}

/** The drape range sampler: float32 is not filterable (no OES_texture_float_linear needed). */
export const RANGE_SAMPLER = {
	minFilter: "nearest",
	magFilter: "nearest",
	addressModeU: "clamp-to-edge",
	addressModeV: "clamp-to-edge",
} as const;

/** A PhotoRangeMap's CPU data as an r32float texture (RANGE_SAMPLER). */
export function rangeTexture(device: Device, r: PhotoRangeData) {
	return device.createTexture({
		data: r.data,
		width: r.width,
		height: r.height,
		format: "r32float",
		sampler: RANGE_SAMPLER,
	});
}

/** A 0..255 single-channel mask (row 0 = top) as a linear-filtered texture; r = mask. */
export function maskTexture(
	device: Device,
	mask: { width: number; height: number; data: Uint8Array },
) {
	const rgba = new Uint8Array(mask.width * mask.height * 4);
	for (let i = 0; i < mask.data.length; i++) {
		rgba[i * 4] = mask.data[i];
		rgba[i * 4 + 3] = 255;
	}
	return device.createTexture({
		data: rgba,
		width: mask.width,
		height: mask.height,
		sampler: {
			minFilter: "linear",
			magFilter: "linear",
			addressModeU: "clamp-to-edge",
			addressModeV: "clamp-to-edge",
		},
	});
}

/** True for the terrain primitive layers, (what the offscreen passes draw). */
export function isTerrainTile(layer: unknown) {
	return layer instanceof BatchedTerrainTileLayer;
}
