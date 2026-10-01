// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Shared GLSL of the look composite (photo ⊕ render), one source for both engines' composite
// shaders (engine.ts compositeFrag, deck/composite-shader.ts), compiled only under a composite
// LOOK_* define (look-key.ts), so the classic programs are unchanged:
//   LOOK_REFINE     coverage / people masks snapped to the photo's edges (look/composite.ts, CPU
//                   guided filter), layer holes filled next to the terrain edge
//   LOOK_INK        anti-aliased near-side silhouettes (width and opacity fall with distance), a
//                   skyline snapped to the refined coverage, optional normal-buffer creases
//   LOOK_HARMONIZE  Oklab per-distance-band transfer of the layer toward the photo (look/color-stats)
//   LOOK_OUTPUT     PBR Neutral on the replacing layer, exact sRGB encode, photo-matched grain, IGN dither
// Each engine #defines its texture access before the chunk: GEO_RANGE(ivec2) / GEO_SIZE (range
// texel, GL rows), LAYER(uv), MASK(uv) (r coverage, b people), NORMAL(ivec2) / NORMAL_SIZE.
// Ported from the former studio composite, whose defaults the values reproduce.
import { BAND_CENTERS_LOG10 } from "../color-stats";
import { defineBlock } from "./block";
import { GAUSS_GLSL, HASH_GLSL, IGN_GLSL, SRGB_ENCODE_GLSL } from "./common";
import { OKLAB_GLSL } from "./oklab";

/** Band statistics (look/color-stats): mat4 column k = band k (Oklab xyz). Values: harmonizeValues(). */
export const HARM_BLOCK = defineBlock("hrm", "bandStats", {
	pm: "mat4",
	ps: "mat4",
	lm: "mat4",
	ls: "mat4",
	amount: "float",
	chroma: "float",
});

/** Values: look/composite.ts compositeValues(). */
export const COMP_BLOCK = defineBlock("comp", "lookComposite", {
	inkInner: "vec3",
	inkSky: "vec3",
	/** output size, px */
	outSize: "vec2",
	inkWidth: "float",
	inkStrength: "float",
	inkCrease: "float",
	/** e-folding range of the ink opacity, m */
	inkFade: "float",
	/** 1 while the refined masks describe the current pose (and `cut` also the blend's range / brush cut) */
	refine: "float",
	cut: "float",
	maskSoft: "float",
	/** 1 = the layer is premultiplied by MSAA coverage (opaque replace styles) */
	premul: "float",
	grain: "float",
});

const c = BAND_CENTERS_LOG10.map((x) => x.toFixed(6)).join(", ");

/** harmonize(lin, range): needs HARM_BLOCK. Also used by the terrain's world drape. */
export const HARMONIZE_FNS = /* glsl */ `${OKLAB_GLSL}
const vec4 HRM_C = vec4(${c});
vec3 hrmBand(mat4 m, float lg) {
  if (lg <= HRM_C.x) return m[0].xyz;
  if (lg >= HRM_C.w) return m[3].xyz;
  if (lg < HRM_C.y) return mix(m[0].xyz, m[1].xyz, (lg - HRM_C.x) / (HRM_C.y - HRM_C.x));
  if (lg < HRM_C.z) return mix(m[1].xyz, m[2].xyz, (lg - HRM_C.y) / (HRM_C.z - HRM_C.y));
  return mix(m[2].xyz, m[3].xyz, (lg - HRM_C.z) / (HRM_C.w - HRM_C.z));
}
// Reinhard transfer in Oklab toward the photo's band statistics at this range (sky = the far band)
vec3 harmonize(vec3 lin, float range) {
  float lg = range > 0.0 ? log(range) / log(10.0) : HRM_C.w;
  vec3 lab = linearToOklab(lin);
  vec3 ratio = clamp(hrmBand(hrm_ps, lg) / hrmBand(hrm_ls, lg), vec3(0.5), vec3(2.0));
  vec3 t = (lab - hrmBand(hrm_lm, lg)) * ratio + hrmBand(hrm_pm, lg);
  return max(oklabToLinear(mix(lab, t, vec3(hrm_amount, vec2(hrm_amount * hrm_chroma)))), vec3(0.0));
}
`;

const COMPOSITE_FNS = /* glsl */ `${HARMONIZE_FNS}
${SRGB_ENCODE_GLSL.replace("srgbEncode", "lookEncode")}
${IGN_GLSL}
${HASH_GLSL}
${GAUSS_GLSL}

float lrOf(float r) { return r > 0.0 ? log(r) : 13.5; } // sky ≈ 700 km
float rangeAt(ivec2 p) { return GEO_RANGE(clamp(p, ivec2(0), GEO_SIZE - 1)); }
float softMask(float q) { return smoothstep(0.5 - comp_maskSoft, 0.5 + comp_maskSoft, q); }

// layer colour, un-premultiplied, with holes next to the terrain edge filled from neighbours, so a
// refined coverage reaching past the DEM silhouette never pulls in the clear colour
vec4 layerAt(vec2 uv) {
  vec4 l = LAYER(uv);
  if (comp_premul < 0.5) return l;
  if (l.a > 0.995) return vec4(l.rgb / l.a, l.a);
  vec3 acc = l.rgb * 4.0;
  float wa = l.a * 4.0;
  vec2 px = 1.0 / comp_outSize;
  for (int ring = 1; ring <= 3; ring++) {
    float rad = float(ring * ring) * 1.5 + 0.5;
    for (int k = 0; k < 8; k++) {
      float ang = float(k) * 0.7853982 + float(ring) * 0.39;
      vec4 s = LAYER(uv + vec2(cos(ang), sin(ang)) * rad * px);
      float w = 1.0 / float(ring);
      acc += s.rgb * w;
      wa += s.a * w;
    }
  }
  return vec4(wa > 1e-4 ? acc / wa : vec3(0.0), l.a);
}

float innerWidth(float r) { return clamp(1.4 - 0.4 * log(max(r, 1.0) / 1000.0) / log(10.0), 0.6, 1.4) * comp_inkWidth; }

// Near-side depth silhouettes from log-range jumps. In a 7×7 texel window the nearest surface N
// (log-range within 0.08 of the minimum) and the farther texels F (> 0.1 behind it) each get a
// soft-min distance from the pixel centre; the silhouette sits midway, so s = (d_F − d_N)/2 is a
// smooth signed distance (px) and the line the box-filtered band s ∈ [0, w]: anti-aliased, no
// texel stairs. Returns (inner coverage, skyline coverage, range of the near surface).
vec3 silhouettes(vec2 uv) {
  ivec2 gs = GEO_SIZE;
  vec2 pos = uv * vec2(gs);
  ivec2 c = ivec2(floor(pos));
  float lc = lrOf(rangeAt(c));
  // cheap reject: no depth jump within 3 texels
  float jmax = 0.0;
  for (int k = 0; k < 8; k++) {
    vec2 dir = vec2(cos(float(k) * 0.7853982), sin(float(k) * 0.7853982));
    jmax = max(jmax, abs(lrOf(rangeAt(c + ivec2(round(dir * 3.0)))) - lc));
    jmax = max(jmax, abs(lrOf(rangeAt(c + ivec2(round(dir * 1.5)))) - lc));
  }
  if (jmax < 0.1) return vec3(0.0, 0.0, lc < 13.0 ? exp(lc) : 0.0);
  float L[49];
  float lmin = 20.0;
  for (int i = 0; i < 49; i++) {
    L[i] = lrOf(rangeAt(c + ivec2(i % 7 - 3, i / 7 - 3)));
    lmin = min(lmin, L[i]);
  }
  if (lmin > 13.0) return vec3(0.0);
  float pxPerTexel = comp_outSize.x / float(gs.x);
  float k = 0.5 * max(pxPerTexel, 1.0);
  float sN = 0.0, sF = 0.0, sS = 0.0;
  // grazing slopes change log-range steadily; only a jump well above that trend is an occlusion
  float slopeAllow = 0.045 * 1024.0 / float(gs.x);
  vec2 cMin = vec2(0.0);
  for (int i = 0; i < 49; i++) if (L[i] == lmin) cMin = vec2(i % 7 - 3, i / 7 - 3);
  for (int i = 0; i < 49; i++) {
    vec2 o = vec2(i % 7 - 3, i / 7 - 3);
    float jump = L[i] - lmin - slopeAllow * length(o - cMin);
    float e = exp(-length(pos - (vec2(c) + o + 0.5)) * pxPerTexel / k);
    if (L[i] - lmin < 0.08) sN += e;
    else if (L[i] > 13.0) sS += e;
    else if (jump > 0.12) sF += smoothstep(0.12, 0.4, jump) * e;
  }
  float dN = -k * log(max(sN, 1e-30));
  float sIn = sF > 0.0 ? 0.5 * (-k * log(sF) - dN) : 1e3;
  float sSk = sS > 0.0 ? 0.5 * (-k * log(sS) - dN) : 1e3;
  // inner silhouettes are hairlines (1.4 px near → 0.6 px far); the skyline is a crisp 1.5 px
  float rNear = exp(lmin);
  float wIn = innerWidth(rNear);
  float wSky = 1.5 * comp_inkWidth;
  return vec3(clamp(min(sIn + 0.5, wIn) - max(sIn - 0.5, 0.0), 0.0, 1.0), clamp(min(sSk + 0.5, wSky) - max(sSk - 0.5, 0.0), 0.0, 1.0), rNear);
}

// skyline on the refined coverage: the band [0, w] px on the terrain side of its 0.5 isoline, from
// the signed distance (q − 0.5)/|∇q|, box-filtered over the pixel; flat plateaus draw nothing
float refinedSkyline(vec2 uv, float w) {
  vec2 px = 1.0 / comp_outSize;
  float q = MASK(uv).r;
  float gx = MASK(uv + vec2(px.x, 0.0)).r - MASK(uv - vec2(px.x, 0.0)).r;
  float gy = MASK(uv + vec2(0.0, px.y)).r - MASK(uv - vec2(0.0, px.y)).r;
  float g = 0.5 * length(vec2(gx, gy));
  if (g < 1e-3) return 0.0;
  float d = (q - 0.5) / g;
  return clamp(min(d + 0.5, w) - max(d - 0.5, 0.0), 0.0, 1.0) * smoothstep(0.008, 0.03, g);
}

// creases from the normal buffer (the terrain's normal pass, style 7)
float creases(vec2 uv) {
  ivec2 gs = NORMAL_SIZE;
  ivec2 c = ivec2(floor(uv * vec2(gs)));
  vec3 n = NORMAL(c).rgb;
  float e = 0.0;
  for (int k = 0; k < 4; k++) {
    ivec2 o = k == 0 ? ivec2(1, 0) : k == 1 ? ivec2(-1, 0) : k == 2 ? ivec2(0, 1) : ivec2(0, -1);
    vec4 nq = NORMAL(clamp(c + o, ivec2(0), gs - 1));
    if (nq.a > 0.0) e = max(e, 1.0 - dot(n, nq.rgb));
  }
  return smoothstep(0.08, 0.25, e);
}

// ink alphas (inner silhouettes / creases, skyline) at uv; cov = terrain coverage
vec2 inkLines(vec2 uv, float range, float nearFade, float cov) {
  vec3 sil = silhouettes(uv);
  float lineRange = sil.z > 0.0 ? sil.z : 50000.0;
  float fade = sqrt(exp(-lineRange / max(comp_inkFade, 1.0)));
  float near = nearFade > 0.0 ? smoothstep(nearFade * 0.5, nearFade, lineRange) : 1.0;
  float sky = comp_refine > 0.5 ? refinedSkyline(uv, 1.5 * comp_inkWidth) : sil.y;
  float inner = sil.x * (1.0 - sky);
  float crease = comp_inkCrease > 0.0 && range > 0.0 ? creases(uv) * (1.0 - inner) * (1.0 - sky) * cov : 0.0;
  // inner silhouettes stay light: they annotate relief, the skyline carries the drawing
  return vec2(max(inner * 0.5, crease * comp_inkCrease * 0.4) * fade * near, sky * mix(0.55, 1.0, fade));
}
vec3 applyInk(vec3 col, vec2 ink, float k) {
  k *= comp_inkStrength;
  return mix(mix(col, comp_inkInner, ink.x * k), comp_inkSky, ink.y * k);
}

// Khronos PBR Neutral; toe scales the black-level offset (harmonised layers are display-referred
// already and keep only the highlight shoulder)
vec3 pbrNeutral(vec3 color, float toe) {
  const float startCompression = 0.8 - 0.04;
  const float desaturation = 0.15;
  float x = min(color.r, min(color.g, color.b));
  float offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
  color -= offset * toe;
  float peak = max(color.r, max(color.g, color.b));
  if (peak < startCompression) return color;
  const float d = 1.0 - startCompression;
  float newPeak = 1.0 - d * d / (peak + d - startCompression);
  color *= newPeak / peak;
  float g = 1.0 - 1.0 / (desaturation * (peak - newPeak) + 1.0);
  return mix(color, vec3(newPeak), g);
}

// the replacing layer: harmonised toward the photo, then tone mapped
vec3 lookLayer(vec3 c, float range) {
#ifdef LOOK_HARMONIZE
  c = harmonize(c, range);
#endif
#ifdef LOOK_OUTPUT
  c = pbrNeutral(c, 1.0 - hrm_amount);
#endif
  return c;
}
// layerAt() un-premultiplied the layer (LOOK_REFINE on an MSAA-premultiplied style)
#ifdef LOOK_REFINE
#define LAYER_PREMUL (comp_premul > 0.5)
#else
#define LAYER_PREMUL false
#endif

// linear → display: exact sRGB, grain on the replaced pixels, triangular ±1 LSB dither everywhere
vec3 lookOutput(vec3 col, float grainA, vec2 frag) {
  col = lookEncode(col) + grainA * comp_grain * gauss(frag);
  return col + (ign(frag) + ign(frag + vec2(47.0, 17.0)) - 1.0) / 255.0;
}
`;

/** True when a define list sets any composite feature (the composite program is then rebuilt). */
export const COMPOSITE_DEFINES = [
	"LOOK_HARMONIZE",
	"LOOK_INK",
	"LOOK_OUTPUT",
	"LOOK_REFINE",
] as const;

/** The chunk for one engine: its texture macros + block declarations + the functions, all under the composite defines. */
export const compositeChunk = (bindings: string) => /* glsl */ `
#if defined(LOOK_INK) || defined(LOOK_REFINE) || defined(LOOK_HARMONIZE) || defined(LOOK_OUTPUT)
${bindings}
${COMPOSITE_FNS}
#endif
`;
