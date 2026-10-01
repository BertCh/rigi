// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Shared GLSL of the cartographic ramps and overlays, one source for both engines. All colours are
// LINEAR. Only the slope layer has a parameter (SLOPE_BLOCK); the rest take theirs as arguments.
//   alpineAlbedo(elev, n, xy)   LOOK_ALPINE: Patterson-style natural tint keyed to absolute Alpine
//                               elevations, slope-dependent rock, gentle-slope snow, flat lakes
//   tanakaLines(...)            LOOK_TANAKA: illuminated contours, vec4(rgb, alpha)
//   slopeClass(n)               LOOK_SLOPE: FATMAP 30/35/40/45° avalanche-slope classes, vec4(rgb, alpha)
import { defineBlock } from "./block";

export const SLOPE_BLOCK = defineBlock("slope", "slope", {
	alpha: "float",
	// the four class colours, linear (style overlay.slope.colors)
	c0: "vec3",
	c1: "vec3",
	c2: "vec3",
	c3: "vec3",
});

// guarded: a program may splice in several of the chunks below
const SRGB = /* glsl */ `#ifndef RAMP_SRGB
#define RAMP_SRGB
vec3 rampSrgb(vec3 c) { return pow(c, vec3(2.2)); }
#endif
`;

export const ALPINE_FNS = /* glsl */ `${SRGB}
float rampHash(vec2 p) {
  p = fract(p * vec2(0.1031, 0.1030));
  p += dot(p, p.yx + 33.33);
  return fract((p.x + p.y) * p.x);
}
float rampNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(rampHash(i), rampHash(i + vec2(1.0, 0.0)), f.x), mix(rampHash(i + vec2(0.0, 1.0)), rampHash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float rampFbm(vec2 p) {
  return 0.55 * rampNoise(p) + 0.3 * rampNoise(p * 2.13 + 7.1) + 0.15 * rampNoise(p * 4.37 - 3.3);
}

// valley greens ~400 m, forest belt, alpine meadow above the treeline (1900 m), rock from the
// rockline (2450 m); stops sRGB, mixed in linear
vec3 alpineBase(float h) {
  vec3 c0 = rampSrgb(vec3(0.56, 0.66, 0.45)); //  400 valley floor, pale green
  vec3 c1 = rampSrgb(vec3(0.40, 0.53, 0.34)); //  900 mixed forest
  vec3 c2 = rampSrgb(vec3(0.35, 0.47, 0.31)); // 1500 conifer belt
  vec3 c3 = rampSrgb(vec3(0.60, 0.65, 0.42)); // treeline+ alpine meadow, yellow-green
  vec3 c4 = rampSrgb(vec3(0.64, 0.62, 0.52)); // rockline, tan scree
  vec3 c5 = rampSrgb(vec3(0.64, 0.64, 0.63)); // high rock, cool grey
  if (h < 900.0) return mix(c0, c1, smoothstep(400.0, 900.0, h));
  if (h < 1500.0) return mix(c1, c2, smoothstep(900.0, 1500.0, h));
  if (h < 2050.0) return mix(c2, c3, smoothstep(1650.0, 2050.0, h));
  if (h < 2450.0) return mix(c3, c4, smoothstep(2050.0, 2450.0, h));
  return mix(c4, c5, smoothstep(2450.0, 2950.0, h));
}

vec3 alpineAlbedo(float elev, vec3 n, vec2 xy) {
  float slopeDeg = degrees(acos(clamp(n.z, -1.0, 1.0)));
  // ~400 m patchiness so the belts don't read as contour stripes
  float nz = rampFbm(xy / 700.0) - 0.5;
  float fine = rampNoise(xy / 90.0) - 0.5;
  float h = elev + nz * 260.0;
  vec3 col = alpineBase(h);
  // rock on steep slopes; below the treeline steep ground is mostly forest, so rock needs more slope
  float rockStart = mix(50.0, 30.0, smoothstep(1400.0, 2650.0, h));
  float rock = smoothstep(rockStart - 4.0, rockStart + 14.0, slopeDeg + fine * 5.0);
  col = mix(col, rampSrgb(mix(vec3(0.54, 0.52, 0.48), vec3(0.6), smoothstep(1500.0, 3000.0, h))), rock);
  // snow above the snowline (2900 m), only where it can lie, more on high ground
  float sl = 2900.0 + nz * 220.0;
  float snowH = smoothstep(sl - 120.0, sl + 180.0, elev);
  float snowS = 1.0 - smoothstep(32.0, 48.0, slopeDeg + fine * 10.0 - smoothstep(sl, sl + 900.0, elev) * 8.0);
  col = mix(col, rampSrgb(vec3(0.95, 0.97, 1.0)), snowH * snowS);
  // lakes: a DEM lake is one constant elevation, so its gradient is exactly 0 (below 2600 m)
  float grad = fwidth(elev) / max(length(fwidth(xy)), 1e-3);
  float water = (1.0 - smoothstep(0.0004, 0.0015, grad)) * (1.0 - smoothstep(2500.0, 2600.0, elev));
  return mix(col, rampSrgb(vec3(0.33, 0.50, 0.60)), water * 0.9);
}
`;

export const TANAKA_FNS = /* glsl */ `${SRGB}
// Kennelly & Kimerling (2001): lines white on slopes facing the light, dark on slopes facing away,
// width ∝ |cos(aspect − light azimuth)| and slope
vec4 tanakaContour(float elev, float interval, vec3 n, vec3 lightDir) {
  float e = elev / interval;
  float fw = max(fwidth(e), 1e-6);
  float sl = length(n.xy);
  float lit = sl > 1e-4 && length(lightDir.xy) > 1e-4 ? dot(n.xy / sl, normalize(lightDir.xy)) : 0.0;
  float widthPx = (0.4 + 0.8 * abs(lit)) * mix(1.0, 1.4, clamp(sl * 1.6, 0.0, 1.0));
  float d = abs(fract(e - 0.5) - 0.5) / fw;
  float a = 1.0 - smoothstep(widthPx * 0.5, widthPx * 0.5 + 1.0, d);
  // lines denser than ~3 px apart turn into mush; nothing on flat valley floors
  a *= (1.0 - smoothstep(0.06, 0.14, fw)) * smoothstep(0.02, 0.08, sl);
  return vec4(lit >= 0.0 ? vec3(1.0, 0.98, 0.94) : rampSrgb(vec3(0.12, 0.13, 0.2)), a * mix(0.55, 1.0, abs(lit)));
}

// minor every interval, bolder major every majorEvery; faded where contours project to flat dashes
vec4 tanakaLines(float elev, float interval, float majorEvery, vec3 n, vec3 lightDir, vec3 worldPos, vec3 cam, float range) {
  vec4 minor = tanakaContour(elev, interval, n, lightDir);
  vec4 major = tanakaContour(elev, interval * majorEvery, n, lightDir);
  major.a = min(major.a * 1.6, 1.0);
  vec4 c = major.a > minor.a * 0.6 ? major : vec4(minor.rgb, minor.a * 0.6);
  // within ~1° of eye level, and on grazing slopes
  c.a *= smoothstep(0.006, 0.025, abs(worldPos.z - cam.z) / max(range, 1.0));
  c.a *= smoothstep(0.08, 0.3, abs(dot(n, normalize(cam - worldPos))));
  return c;
}
`;

export const SLOPE_FNS = /* glsl */ `${SRGB}
// 30–35°, 35–40°, 40–45°, > 45° (classic: yellow, orange, red, purple); alpha 0 below 30°
vec4 slopeClass(vec3 n) {
  float s = degrees(acos(clamp(n.z, -1.0, 1.0)));
  float fw = max(fwidth(s), 1e-3);
  vec3 c = slope_c0;
  c = mix(c, slope_c1, smoothstep(35.0 - fw, 35.0 + fw, s));
  c = mix(c, slope_c2, smoothstep(40.0 - fw, 40.0 + fw, s));
  c = mix(c, slope_c3, smoothstep(45.0 - fw, 45.0 + fw, s));
  return vec4(c, smoothstep(30.0 - fw, 30.0 + fw, s) * slope_alpha);
}
`;

/** The deck (luma) binding of the slope layer. */
export const SLOPE_LUMA_MODULE = {
	...SLOPE_BLOCK.lumaModule,
	fs: `${SLOPE_BLOCK.lumaModule.fs}${SLOPE_FNS}`,
};
