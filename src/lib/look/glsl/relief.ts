// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Shared GLSL of the Swiss relief (LOOK_RELIEF), one source for both engines through REL_BLOCK's
// accessors. `reliefShade(albedo, n, worldPos, range)` returns linear colour:
//   cartographic  Swiss/Imhof multidirectional oblique hillshade (4 lights around the NW main one,
//                 Mark's aspect weights), warm lit / cool shade, Imhof elevation contrast, sky view
//   photographic  the style's sun × soft cast shadow × sun colour, sky × sky-view factor, bounce
// blended by rel_realism. The field textures (look/relief/field.ts) add the shadow, SVF, curvature
// and the generalised normal; where they have no coverage (or before they are built: a 1×1 zero
// texture) the shading falls back to the plain normal. Sampler names are the same in both engines.
import { ATM_CURV } from "../atmosphere";
import { IMHOF_FIELD_TEXEL, IMHOF_GLSL_MATH, IMHOF_TAP_RADII } from "../imhof";
import { defineBlock } from "./block";

/** Values: look/relief/field.ts reliefValues(). */
export const REL_BLOCK = defineBlock("rel", "relief", {
	sunDir: "vec3",
	sunColor: "vec3",
	extent: "vec4",
	realism: "float",
	generalize: "float",
	curvature: "float",
	/** width of the field's rounded edge fade, as a fraction of its extent */
	edge: "float",
	/** Imhof relief (look/imhof.ts): 1 = on, aspect swing, colour tint, aerial perspective */
	imhof: "float",
	swing: "float",
	tint: "float",
	aerial: "float",
});

export const RELIEF_FNS = /* glsl */ `
uniform sampler2D reliefField; // R sun visibility, G sky view, B curvature (0.5 = planar), A coverage
uniform sampler2D reliefGen;   // RG generalised normal xy (× 0.5 + 0.5), A valid

vec3 reliefLightDir(float azDeg, float altDeg) {
  float az = radians(azDeg);
  float al = radians(altDeg);
  return vec3(cos(al) * sin(az), cos(al) * cos(az), sin(al));
}

// Swiss-style multidirectional oblique hillshade from the NW (315°, 45°), 1 = lit flat ground
float reliefMdow(vec3 n) {
  float slope = length(n.xy);
  float aspect = atan(n.x, n.y); // downslope-facing azimuth (rad, clockwise from N)
  float acc = 0.0;
  float wsum = 0.0;
  for (int i = 0; i < 4; i++) {
    float az = 225.0 + 45.0 * float(i);
    // Mark (1992): weight by sin²(aspect − az) so each slope is lit across its fall line, biased
    // toward the main light to keep the classic upper-left reading
    float s = sin(aspect - radians(az));
    float w = (0.2 + s * s) * (i == 2 ? 1.6 : 1.0);
    acc += w * max(dot(n, reliefLightDir(az, 45.0)), 0.0);
    wsum += w;
  }
  float single = max(dot(n, reliefLightDir(315.0, 45.0)), 0.0);
  return mix(single, acc / wsum, 0.55 * smoothstep(0.05, 0.4, slope)) / sin(radians(45.0));
}

${IMHOF_GLSL_MATH}
// mean generalised-normal xy of the 8 taps on a ring (radius in field texels) around the sample
vec2 imhofRingXy(vec2 uv, float radius, vec4 g0) {
  vec2 c = g0.rg * 2.0 - 1.0;
  vec2 acc = c * g0.a;
  float wsum = g0.a;
  for (int i = 0; i < 8; i++) {
    float a = 0.785398163 * float(i);
    vec4 g = texture(reliefGen, uv + vec2(cos(a), sin(a)) * radius * ${IMHOF_FIELD_TEXEL.toExponential(9)});
    acc += (g.rg * 2.0 - 1.0) * g.a;
    wsum += g.a;
  }
  return wsum > 0.0 ? acc / max(wsum, 1e-4) : c;
}

vec3 reliefShade(vec3 albedo, vec3 n, vec3 worldPos, float range) {
  vec2 uv = (worldPos.xy - rel_extent.xy) / (rel_extent.zw - rel_extent.xy);
  // rounded fade toward the extent's edge, so it never reads as a rectangle
  vec2 e = max(rel_edge - min(uv, 1.0 - uv), 0.0) / rel_edge;
  float edge = 1.0 - smoothstep(0.0, 1.0, length(e));
  vec4 f = vec4(1.0, 1.0, 0.5, 0.0);
  float wField = 0.0;
  if (edge > 0.0) {
    f = texture(reliefField, uv);
    wField = edge * f.a;
    vec4 g = texture(reliefGen, uv);
    vec2 gxy = g.rg * 2.0 - 1.0;
    vec3 gn = vec3(gxy, sqrt(max(1.0 - dot(gxy, gxy), 0.0)));
    // keep 30 % of the fine normal (Imhof's generalisation); none on the ground at your feet
    if (rel_imhof > 0.5) {
      // Imhof: four scale levels (fine normal, field normal, two coarser ring averages) by range
      vec4 w = imhofScaleWeights(range);
      vec2 xy = w.x * n.xy + w.y * gxy;
      if (w.z > 0.0) xy += w.z * imhofRingXy(uv, ${IMHOF_TAP_RADII[0].toExponential(9)}, g);
      if (w.w > 0.0) xy += w.w * imhofRingXy(uv, ${IMHOF_TAP_RADII[1].toExponential(9)}, g);
      xy *= min(1.0, 0.98 / max(length(xy), 1e-4));
      vec3 ng = vec3(xy, sqrt(max(1.0 - dot(xy, xy), 0.0)));
      n = normalize(mix(n, ng, rel_generalize * edge * g.a));
    } else {
      n = normalize(mix(n, normalize(mix(gn, n, 0.3)), rel_generalize * edge * g.a * smoothstep(300.0, 2000.0, range)));
    }
  }
  float sunVis = mix(1.0, f.r, wField);
  float svf = mix(1.0, f.g, wField);
  float curv = (f.b - 0.5) * wField;
  float up = 0.5 + 0.5 * n.z;
  float elev = worldPos.z + dot(worldPos.xy, worldPos.xy) * ${ATM_CURV.toExponential(9)};
  const vec3 skyCol = vec3(0.42, 0.56, 0.86);

  // photographic: real sun, cast shadow, sky dome × SVF, faint bounce
  vec3 s = rel_sunDir;
  // soften the terminator a little (DEM normals are low-pass; real slopes are rough)
  float ndl = mix(max(dot(n, s), 0.0), smoothstep(-0.08, 0.35, dot(n, s)) * 0.35, 0.18);
  float sunUp = smoothstep(-0.03, 0.08, s.z);
  vec3 direct = rel_sunColor * ndl * sunVis * sunUp * 1.75;
  vec3 sky = skyCol * up * svf * mix(svf, 1.0, 0.35) * 0.62;
  vec3 bounce = rel_sunColor * (1.0 - up) * 0.06 * sunUp;
  vec3 photo = albedo * (direct + sky + bounce);

  // cartographic: MDOW (z-factor 1.6) + Imhof contrast + warm/cool split + ridge emphasis
  vec3 zn = normalize(vec3(n.xy * 1.6, n.z));
  float hs = reliefMdow(zn);
  if (rel_imhof > 0.5) hs = imhofSwungLight(zn, hs, rel_swing);
  hs = mix(0.78, hs, mix(0.55, 1.0, smoothstep(600.0, 3000.0, elev)));
  hs *= mix(1.0, 0.72 + 0.28 * svf, 0.9);
  hs += curv * rel_curvature * 0.45;
  // linear-space contrast curve: the sRGB encode lifts shadows, so push them down here
  float L = clamp(hs, 0.0, 1.4);
  vec3 tone = mix(vec3(0.62, 0.72, 0.98), vec3(1.05, 1.0, 0.88), smoothstep(0.25, 1.0, L)) * (0.1 + 0.9 * pow(L, 1.6));
  vec3 carto = albedo * tone * 1.35;
  if (rel_imhof > 0.5) carto = imhofColour(albedo, L, elev, rel_tint);

  vec3 col = mix(carto, photo, rel_realism);
  // valley ink from curvature in both modes (subtle)
  col *= 1.0 + curv * rel_curvature * mix(0.25, 0.35, rel_realism);
  if (rel_imhof > 0.5) col = imhofAerial(col, range, elev, rel_aerial);
  // mild contrast reduction with distance (the haze / atmosphere adds the real veil on top)
  vec3 mid = albedo * mix(vec3(0.9), rel_sunColor * 0.9 + skyCol * 0.35, rel_realism);
  return mix(col, mid, 0.125 * smoothstep(3000.0, 60000.0, range));
}

// luminance of the relief light alone (the elevation bands' shade term)
float reliefLight(vec3 n, vec3 worldPos, float range) {
  return dot(reliefShade(vec3(1.0), n, worldPos, range), vec3(0.2126, 0.7152, 0.0722));
}
`;

/** The deck (luma) binding: the std140 block plus the functions. Only in a LOOK_RELIEF program. */
export const REL_LUMA_MODULE = {
	...REL_BLOCK.lumaModule,
	fs: `${REL_BLOCK.lumaModule.fs}${RELIEF_FNS}`,
};
