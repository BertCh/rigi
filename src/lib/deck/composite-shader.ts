// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// GLSL for the deck photo-view composite: a 1:1 port of engine.ts `compositeFrag` (three.js).
// All inputs are mixed in LINEAR light and encoded with the sRGB OETF at the end, like three's
// `#include <colorspace_fragment>`:
//   photoTex  sRGB photo (decoded here), rows top → bottom (sampled at uvT)
//   layerTex  terrain colour pass: linear rgb, straight alpha (GL rows, sampled at vUv)
//   geoTex    geometry pass: r = range (m), 0 = sky (GL rows, vUv)
//   brushTex  brush mask canvas (top → bottom, uvT); fgTex people mask (top → bottom, uvT)
import type { Texture } from "@luma.gl/core";
import type { ShaderModule } from "@luma.gl/shadertools";
import { TURBO_GLSL } from "../look/glsl/common";
import { COMP_BLOCK, compositeChunk, HARM_BLOCK } from "../look/glsl/composite";
import { REVEAL_GLSL } from "../reveal/glsl";

const uniformBlock = /* glsl */ `\
layout(std140) uniform compositeUniforms {
  vec2 geoTexel;
  vec2 lens;
  float mode;
  float layerOpacity;
  float ridges;
  float depthTint;
  float method;
  float swipe;
  float lensR;
  float rangeM;
  float keepSky;
  float feather;
  float aspect;
  float nearFade;
  float fgOn;
  float hasPhoto;
  // view style (src/lib/style/deck-apply.ts deckCompositeStyle); defaults = the classic literals
  mat4 depthC0;
  mat4 depthC1;
  mat4 depthDE;
  vec4 ridgeInner;
  vec4 ridgeSky;
  vec4 ridgeInnerR;
  vec4 hair;
  vec2 ridgeThr;
  vec2 depthLog;
  vec2 depthLuma;
  float ridgeGainO;
  float ridgeGainR;
  float depthGain;
  float depthRampKind;
  float depthN;
  // overlay reveal (src/lib/reveal): read only while reveal.w > 0
  vec4 reveal;
  vec4 revealWin;
  vec4 revealQD;
  vec4 revealQE;
  vec4 revealShape;
  vec4 revealFocus;
  vec4 revealGlow;
  vec4 revealF;
  vec4 revealR;
  vec4 revealU;
  // concord DSM occluder (?concord=occl): occlOn 0 ⇒ occlTex is never read
  float occlOn;
} composite;
`;

export type CompositeModuleProps = {
	geoTexel: [number, number];
	lens: [number, number];
	mode: number;
	layerOpacity: number;
	ridges: number;
	depthTint: number;
	method: number;
	swipe: number;
	lensR: number;
	rangeM: number;
	keepSky: number;
	feather: number;
	aspect: number;
	nearFade: number;
	fgOn: number;
	hasPhoto: number;
	depthC0: number[];
	depthC1: number[];
	depthDE: number[];
	ridgeInner: number[];
	ridgeSky: number[];
	ridgeInnerR: number[];
	/** rgb + alpha */
	hair: number[];
	ridgeThr: number[];
	depthLog: number[];
	depthLuma: number[];
	ridgeGainO: number;
	ridgeGainR: number;
	depthGain: number;
	/** 0 = turbo, 1 = the depthC/DE stops */
	depthRampKind: number;
	depthN: number;
	reveal: number[];
	revealWin: number[];
	revealQD: number[];
	revealQE: number[];
	revealShape: number[];
	revealFocus: number[];
	revealGlow: number[];
	revealF: number[];
	revealR: number[];
	revealU: number[];
	occlOn: number;
	photoTex: Texture;
	layerTex: Texture;
	geoTex: Texture;
	brushTex: Texture;
	fgTex: Texture;
	/** concord DSM occluder dim mask (R, top → bottom, uvT); the 1×1 empty when off. */
	occlTex: Texture;
};

export const compositeModule = {
	name: "composite",
	vs: uniformBlock,
	fs: uniformBlock,
	uniformTypes: {
		geoTexel: "vec2<f32>",
		lens: "vec2<f32>",
		mode: "f32",
		layerOpacity: "f32",
		ridges: "f32",
		depthTint: "f32",
		method: "f32",
		swipe: "f32",
		lensR: "f32",
		rangeM: "f32",
		keepSky: "f32",
		feather: "f32",
		aspect: "f32",
		nearFade: "f32",
		fgOn: "f32",
		hasPhoto: "f32",
		depthC0: "mat4x4<f32>",
		depthC1: "mat4x4<f32>",
		depthDE: "mat4x4<f32>",
		ridgeInner: "vec4<f32>",
		ridgeSky: "vec4<f32>",
		ridgeInnerR: "vec4<f32>",
		hair: "vec4<f32>",
		ridgeThr: "vec2<f32>",
		depthLog: "vec2<f32>",
		depthLuma: "vec2<f32>",
		ridgeGainO: "f32",
		ridgeGainR: "f32",
		depthGain: "f32",
		depthRampKind: "f32",
		depthN: "f32",
		reveal: "vec4<f32>",
		revealWin: "vec4<f32>",
		revealQD: "vec4<f32>",
		revealQE: "vec4<f32>",
		revealShape: "vec4<f32>",
		revealFocus: "vec4<f32>",
		revealGlow: "vec4<f32>",
		revealF: "vec4<f32>",
		revealR: "vec4<f32>",
		revealU: "vec4<f32>",
		occlOn: "f32",
	},
} as const satisfies ShaderModule;

/** The look composite's uniform blocks (look/glsl/composite.ts), in programs with a composite LOOK_* define. */
export const LOOK_COMPOSITE_MODULES = [
	COMP_BLOCK.lumaModule,
	HARM_BLOCK.lumaModule,
];

export const compositeVs = /* glsl */ `#version 300 es
#define SHADER_NAME photo-composite-vs
in vec2 positions;
out vec2 vUv;
void main() {
  vUv = positions * 0.5 + 0.5;
  gl_Position = vec4(positions, 0.0, 1.0);
}
`;

export const compositeFs = /* glsl */ `#version 300 es
#define SHADER_NAME photo-composite-fs
precision highp float;
uniform sampler2D photoTex;
uniform sampler2D layerTex;
uniform sampler2D geoTex;
uniform sampler2D brushTex;
uniform sampler2D fgTex;
uniform sampler2D occlTex;
in vec2 vUv;
out vec4 fragColor;

vec3 srgbDecode(vec3 c) {
  return mix(pow(c * 0.9478672986 + vec3(0.0521327014), vec3(2.4)), c * 0.0773993808, vec3(lessThanEqual(c, vec3(0.04045))));
}
vec3 srgbEncode(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(pow(c, vec3(0.41666)) * 1.055 - vec3(0.055), c * 12.92, vec3(lessThanEqual(c, vec3(0.0031308))));
}

${TURBO_GLSL}
${REVEAL_GLSL}
${compositeChunk(`uniform sampler2D maskTex;
uniform sampler2D normalTex;
#define GEO_RANGE(p) texelFetch(geoTex, p, 0).r
#define GEO_SIZE textureSize(geoTex, 0)
#define LAYER(uv) texture(layerTex, uv)
#define MASK(uv) texture(maskTex, vec2((uv).x, 1.0 - (uv).y))
#define NORMAL(p) texelFetch(normalTex, p, 0)
#define NORMAL_SIZE textureSize(normalTex, 0)`)}

// ramp stops as in terrain-layer.ts rampEval (mat4 columns: rgb = sRGB colour, a = t)
vec4 rampStop(int i) { return i < 4 ? composite.depthC0[i] : composite.depthC1[i - 4]; }
vec3 depthRamp(float t) {
  int n = int(composite.depthN + 0.5);
  vec4 prev = rampStop(0);
  vec3 c = prev.rgb;
  for (int i = 1; i < 8; i++) {
    if (i >= n) break;
    vec4 s = rampStop(i);
    if (t < s.a || i == n - 1) {
      float d = (i < 4 ? composite.depthDE[0] : composite.depthDE[1])[i & 3];
      float e = (i < 4 ? composite.depthDE[2] : composite.depthDE[3])[i & 3];
      float f = e > 0.5 ? smoothstep(prev.a, s.a, t) : clamp((t - prev.a) / d, 0.0, 1.0);
      c = mix(prev.rgb, s.rgb, f);
      break;
    }
    prev = s;
  }
  return pow(c, vec3(2.2));
}

float lr(vec2 uv) {
  float r = texture(geoTex, uv).r;
  return r > 0.0 ? log(r) : 13.5; // sky ≈ 700 km
}

void main() {
  vec2 uvT = vec2(vUv.x, 1.0 - vUv.y);
  vec3 col = composite.hasPhoto > 0.5 ? srgbDecode(texture(photoTex, uvT).rgb) : vec3(0.0);
  // render-space reads (layerTex, geoTex) at uvG; photo-space reads (photo, fg, brush, masks) unchanged
  vec2 uvG = vUv;
#ifdef LOOK_REFINE
  vec4 layer = layerAt(uvG);
#else
  vec4 layer = texture(layerTex, uvG);
#endif
  float range = texture(geoTex, uvG).r;
  // people & other foreground: keep the photo untouched there
  float fg = composite.fgOn * texture(fgTex, uvT).r;
  // terrain coverage (look composite: snapped to the photo's edges while the refined masks are fresh)
  float cov = layer.a;
#ifdef LOOK_REFINE
  if (comp_refine > 0.5) {
    vec4 ref = MASK(vUv);
    cov = softMask(ref.r);
    fg = composite.fgOn * softMask(ref.b);
  }
#endif
  // concord DSM occluder: a tree / hut in front of the terrain this pixel shows dims it (dim, don't hide)
  if (composite.occlOn > 0.5) fg = max(fg, 0.8 * texture(occlTex, uvT).r);

  // silhouettes: discontinuities in log-range
  float c = lr(uvG);
  vec2 o = composite.geoTexel * 1.25;
  float e = max(max(abs(c - lr(uvG + vec2(o.x, 0.0))), abs(c - lr(uvG - vec2(o.x, 0.0)))),
                max(abs(c - lr(uvG + vec2(0.0, o.y))), abs(c - lr(uvG - vec2(0.0, o.y)))));
  float isSkyline = (range > 0.0 && texture(geoTex, uvG + vec2(0.0, o.y)).r == 0.0) ? 1.0 : 0.0;
  float ridge = smoothstep(composite.ridgeThr.x, composite.ridgeThr.y, e);
  if (composite.nearFade > 0.0) ridge *= range > 0.0 ? smoothstep(composite.nearFade * 0.5, composite.nearFade, range) : 1.0;
#ifdef LOOK_INK
  vec2 ink = inkLines(uvG, range, composite.nearFade, cov);
#endif
#ifdef LOOK_OUTPUT
  float grainA = 0.0;
#endif
  // reveal: x = overlay alpha, y = light band, z = ridge alpha (1, 0, 1 when off)
  vec3 rv = vec3(1.0, 0.0, 1.0);
  if (composite.reveal.w > 0.0) rv = revealAt(uvG, range, composite.reveal, composite.revealWin, composite.revealQD, composite.revealQE, composite.revealShape, composite.revealFocus, composite.revealF.xyz, composite.revealR.xyz, composite.revealU.xyz, composite.aspect);

  if (composite.mode < 0.5) {
    if (composite.depthTint > 0.0 && range > 0.0 && fg < 0.5) {
      float t = clamp((log(range) - composite.depthLog.x) * composite.depthLog.y, 0.0, 1.0);
      vec3 dc = composite.depthRampKind < 0.5 ? turbo(t) : depthRamp(t);
      col = mix(col, dc * (composite.depthLuma.x + composite.depthLuma.y * dot(col, vec3(0.333)) * 1.4), composite.depthTint * composite.depthGain * rv.x);
    }
    col = mix(col, layer.rgb, layer.a * composite.layerOpacity * (1.0 - fg) * rv.x);
#ifdef LOOK_INK
    col = applyInk(col, ink, composite.ridges * (1.0 - fg) * rv.z);
#else
    vec3 ridgeCol = mix(composite.ridgeInner.rgb, composite.ridgeSky.rgb, isSkyline);
    col = mix(col, ridgeCol, ridge * composite.ridges * composite.ridgeGainO * (1.0 - fg) * rv.z);
#endif
    if (composite.reveal.w > 0.0) col = revealLight(col, rv, range, layer.a * composite.layerOpacity, ridge * composite.ridges, composite.revealGlow, composite.revealShape.w, 1.0 - fg);
  } else {
    int method = int(composite.method + 0.5);
    float m = 0.0;
    float f = max(composite.feather, 0.001);
    if (method == 0) m = smoothstep(composite.swipe - f * 0.5, composite.swipe + f * 0.5, vUv.x);
    else if (method == 1) {
      float d = length((uvT - composite.lens) * vec2(composite.aspect, 1.0));
      m = 1.0 - smoothstep(composite.lensR - f, composite.lensR + f, d);
    } else if (method == 2) {
      float rr = range > 0.0 ? range : 1e9;
      m = smoothstep(composite.rangeM * (1.0 - f * 4.0), composite.rangeM * (1.0 + f * 4.0), rr);
    } else m = texture(brushTex, uvT).r;
#ifdef LOOK_REFINE
    // the range / brush cut snapped to the photo's edges
    if (comp_cut > 0.5 && method >= 2) m = softMask(MASK(vUv).g);
#endif
    // hairline where the user's mask edge crosses (not around sky or people)
    float edgeLine = (1.0 - abs(m - 0.5) * 2.0) * cov * (1.0 - fg);
    if (composite.keepSky > 0.5) m *= cov;
    m *= 1.0 - fg;
    float m0 = m;
    m *= rv.x;
#if defined(LOOK_REFINE) || defined(LOOK_HARMONIZE) || defined(LOOK_OUTPUT)
    float a = m * (LAYER_PREMUL ? 1.0 : max(layer.a, 1.0 - composite.keepSky));
    col = mix(col, lookLayer(layer.rgb, range), a);
#else
    col = mix(col, layer.rgb, m * max(layer.a, 1.0 - composite.keepSky));
#endif
#ifdef LOOK_OUTPUT
    grainA = a;
#endif
    if (method != 3) col = mix(col, composite.hair.rgb, smoothstep(0.7, 1.0, edgeLine) * composite.hair.a);
#ifdef LOOK_INK
    col = applyInk(col, ink, composite.ridges * m);
#else
    col = mix(col, composite.ridgeInnerR.rgb, ridge * composite.ridges * composite.ridgeGainR * m);
#endif
    if (composite.reveal.w > 0.0) col = revealLight(col, rv, range, m0, ridge * composite.ridges * m0, composite.revealGlow, composite.revealShape.w * m0, 1.0 - fg);
  }
#ifdef LOOK_OUTPUT
  fragColor = vec4(lookOutput(col, grainA, gl_FragCoord.xy), 1.0);
#else
  fragColor = vec4(srgbEncode(col), 1.0);
#endif
}
`;
