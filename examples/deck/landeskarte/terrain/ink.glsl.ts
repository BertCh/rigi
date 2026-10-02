// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// GLSL ES 3.00 twin of ink.wgsl.ts (same function names, same maths, same constants via
// `makeInkConstants`). Keep the two bodies in step: a change to one is a change to both.

import {makeInkConstants} from './ink.wgsl';

export const INK_GLSL = /* glsl */ `
${makeInkConstants(false)}

// Integer hash of a lattice cell to [0, 1); see the WGSL twin for why it is not fract(sin(x)).
float lk_hash(vec2 cell, uint salt) {
  uint x = uint(int(cell.x));
  uint y = uint(int(cell.y));
  uint h = x * 747796405u + y * 2891336453u + salt * 2654435761u + LK_SEED;
  h = (h ^ (h >> 16u)) * 2246822519u;
  h = (h ^ (h >> 13u)) * 3266489917u;
  h = h ^ (h >> 16u);
  return float(h >> 8u) * 5.9604645e-8;
}

// One contour family as an anti-aliased line (distance in metres over metres-per-pixel).
float lk_contourLine(float elevM, float fwidthElev, float interval, float widthPx) {
  float level = elevM / interval;
  float distanceM = abs(fract(level - 0.5) - 0.5) * interval;
  float distancePx = distanceM / max(fwidthElev, 0.0001);
  return 1.0 - smoothstep(0.5 * widthPx, 0.5 * widthPx + 1.0, distancePx);
}

// Premultiplied contour ink; see the WGSL twin for the parameter notes.
vec4 lk_ink(float elevM, float fwidthElev, float slope, float aspect, float shade, float rangeM,
    float isLake) {
  float minorWeight = 1.0 - smoothstep(LK_MINOR_FADE_LO, LK_MINOR_FADE_HI, fwidthElev);
  float indexFade = smoothstep(LK_INDEX_FADE_LO, LK_INDEX_FADE_HI, fwidthElev);
  float indexWeight = 1.0 - indexFade;
  float superWeight = indexFade * (1.0 - smoothstep(LK_SUPER_FADE_LO, LK_SUPER_FADE_HI, fwidthElev));

  float minorLine = lk_contourLine(elevM, fwidthElev, LK_MINOR_INTERVAL, LK_MINOR_WIDTH);
  float indexLine = lk_contourLine(elevM, fwidthElev, LK_INDEX_INTERVAL, LK_INDEX_WIDTH);
  float superLine = lk_contourLine(elevM, fwidthElev, LK_SUPER_INTERVAL, LK_SUPER_WIDTH);
  minorLine = minorLine * mix(1.0, 0.75, shade);
  float coverage = max(
    max(minorLine * minorWeight * LK_MINOR_ALPHA, indexLine * indexWeight * LK_INDEX_ALPHA),
    superLine * superWeight * LK_INDEX_ALPHA
  );

  float rock = max(
    smoothstep(LK_ROCK_ELEV_LO, LK_ROCK_ELEV_HI, elevM),
    smoothstep(LK_ROCK_SLOPE_LO, LK_ROCK_SLOPE_HI, slope)
  );
  float ice = smoothstep(LK_ICE_ELEV_LO, LK_ICE_ELEV_HI, elevM)
    * (1.0 - smoothstep(LK_ICE_SLOPE_LO, LK_ICE_SLOPE_HI, slope));
  vec3 color = mix(mix(LK_INK_SOIL, LK_INK_ROCK, rock), LK_INK_ICE, ice);

  float notFlat = smoothstep(LK_FLAT_LO, LK_FLAT_HI, fwidthElev);
  float alpha = coverage * notFlat * (1.0 - clamp(isLake, 0.0, 1.0));
  return vec4(color * alpha, alpha);
}

// Metres per pixel snapped to half-octave steps. fwidth is constant per 2x2 quad and differs a
// little between quads; dividing a position of thousands of metres by it would move the pattern
// by whole cells at every quad border. The snapped scale is the same for neighbouring pixels, so
// the pattern is stable (stroke and dot sizes vary by at most about 19 % within a level).
float lk_snapScale(float metresPerPixel) {
  return exp2(floor(log2(max(metresPerPixel, 0.0001)) * 2.0 + 0.5) * 0.5);
}

// Rock hachure: fall-line strokes, 16 aspect sectors, denser on shaded faces.
vec4 lk_hachure(vec2 posEnu, float fwidthPos, float aspect, float slope, float shade) {
  float steep = smoothstep(LK_HACHURE_SLOPE_LO, LK_HACHURE_SLOPE_HI, slope);
  float metresPerPixel = lk_snapScale(fwidthPos);
  float sectorAngle = 6.2831853 / LK_HACHURE_SECTORS;
  float angle = floor(aspect / sectorAngle + 0.5) * sectorAngle;
  vec2 fall = vec2(sin(angle), cos(angle));
  vec2 across = vec2(fall.y, -fall.x);
  float alongPx = dot(posEnu, fall) / (metresPerPixel * LK_HACHURE_LENGTH);
  float alongCell = floor(alongPx);
  float alongT = fract(alongPx);
  float taper = smoothstep(0.0, 0.18, alongT) * (1.0 - smoothstep(0.82, 1.0, alongT));

  float tShade = dot(posEnu, across) / (metresPerPixel * LK_HACHURE_PERIOD_SHADE);
  float tLit = dot(posEnu, across) / (metresPerPixel * LK_HACHURE_PERIOD_LIT);
  float distShade = abs(fract(tShade) - 0.5) * LK_HACHURE_PERIOD_SHADE;
  float distLit = abs(fract(tLit) - 0.5) * LK_HACHURE_PERIOD_LIT;
  float lineShade = 1.0 - smoothstep(0.5 * LK_HACHURE_WIDTH, 0.5 * LK_HACHURE_WIDTH + 0.8, distShade);
  float lineLit = 1.0 - smoothstep(0.5 * LK_HACHURE_WIDTH, 0.5 * LK_HACHURE_WIDTH + 0.8, distLit);
  float keepShade = step(lk_hash(vec2(floor(tShade), alongCell), 11u), LK_HACHURE_KEEP);
  float keepLit = step(lk_hash(vec2(floor(tLit), alongCell), 12u), LK_HACHURE_KEEP);

  float lit = smoothstep(0.35, 0.65, shade);
  float strokes = mix(lineShade * keepShade, lineLit * keepLit, lit);
  float alpha = strokes * taper * steep * mix(0.85, 0.5, lit);
  return vec4(LK_INK_ROCK * alpha, alpha);
}

// Scree stipple: one jittered dot per grid cell, kept by a hash against the talus belt.
vec4 lk_scree(vec2 posEnu, float fwidthPos, float slope, float elevM) {
  float belt = smoothstep(LK_SCREE_SLOPE_LO, LK_SCREE_SLOPE_MID_LO, slope)
    * (1.0 - smoothstep(LK_SCREE_SLOPE_MID_HI, LK_SCREE_SLOPE_HI, slope))
    * smoothstep(LK_SCREE_ELEV_LO, LK_SCREE_ELEV_HI, elevM);
  vec2 grid = posEnu / (lk_snapScale(fwidthPos) * LK_SCREE_PITCH);
  vec2 cell = floor(grid);
  vec2 local = fract(grid);
  vec2 dotAt = vec2(0.3 + 0.4 * lk_hash(cell, 21u), 0.3 + 0.4 * lk_hash(cell, 22u));
  float radiusPx = 0.55 + 0.45 * lk_hash(cell, 23u);
  float distancePx = length(local - dotAt) * LK_SCREE_PITCH;
  float dotCover = 1.0 - smoothstep(radiusPx - 0.35, radiusPx + 0.45, distancePx);
  float keep = step(lk_hash(cell, 24u), belt * LK_SCREE_DENSITY) * step(0.0001, belt);
  float alpha = dotCover * keep * LK_SCREE_ALPHA;
  return vec4(LK_INK_ROCK * alpha, alpha);
}
`;
