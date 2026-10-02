// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Three-ink line work for the Landeskarte sheet, WGSL snippet. A6 splices `INK_WGSL` into the
// terrain fragment shader. Every function is pure: no textures, no uniforms, no derivative calls
// (A6 computes `fwidth` before any branch and passes it in), no loops. Noise is an integer hash.
// `ink.glsl.ts` is the line-for-line GLSL twin and takes its numbers from `INK_PARAMS` below, so
// the two backends cannot drift apart on a constant.

import {LANDESKARTE_SEED} from '../types';

const RAD = Math.PI / 180;

/** Tunables shared by the WGSL and GLSL snippets. Angles are given in degrees here. */
export const INK_PARAMS = {
  // Contour intervals, metres. 500 m takes over when the 100 m lines get too dense to read.
  MINOR_INTERVAL: 20,
  INDEX_INTERVAL: 100,
  SUPER_INTERVAL: 500,
  // Line widths, pixels.
  MINOR_WIDTH: 0.7,
  INDEX_WIDTH: 1.4,
  SUPER_WIDTH: 1.6,
  // Adaptive thinning in metres of elevation per pixel (`fwidthElev`). A line family with spacing
  // `interval` is `interval / fwidthElev` pixels apart, so minor lines fade out between 8 and 13
  // pixels apart and index lines between 8 and 13 pixels apart at their own interval.
  MINOR_FADE_LO: 1.5,
  MINOR_FADE_HI: 2.5,
  INDEX_FADE_LO: 7.5,
  INDEX_FADE_HI: 12.5,
  SUPER_FADE_LO: 37.5,
  SUPER_FADE_HI: 62.5,
  // Below this slope of elevation (m/px) the surface is flat to the screen: no contours (a plateau
  // sitting exactly on a level would otherwise flood with ink).
  FLAT_LO: 0.002,
  FLAT_HI: 0.02,
  // Ink opacity.
  MINOR_ALPHA: 0.6,
  INDEX_ALPHA: 0.95,
  // Ink class belts: rock ink above 2450 m or on slopes steeper than 40 degrees, blue on ice.
  ROCK_ELEV_LO: 2350,
  ROCK_ELEV_HI: 2550,
  ROCK_SLOPE_LO: 38 * RAD,
  ROCK_SLOPE_HI: 44 * RAD,
  ICE_ELEV_LO: 2800,
  ICE_ELEV_HI: 3000,
  ICE_SLOPE_LO: 32 * RAD,
  ICE_SLOPE_HI: 42 * RAD,
  // Hachure: stripe periods (pixels) on shaded and lit faces, stroke width, stroke length and the
  // chance that a stroke exists at all (gaps make it read as drawn, not ruled).
  HACHURE_SLOPE_LO: 36 * RAD,
  HACHURE_SLOPE_HI: 44 * RAD,
  HACHURE_PERIOD_SHADE: 3,
  HACHURE_PERIOD_LIT: 5,
  HACHURE_WIDTH: 0.9,
  HACHURE_LENGTH: 10,
  HACHURE_KEEP: 0.7,
  HACHURE_SECTORS: 16,
  // Scree stipple: grid pitch in pixels and slope belt (talus rests at about 30 to 38 degrees).
  SCREE_PITCH: 5,
  SCREE_SLOPE_LO: 26 * RAD,
  SCREE_SLOPE_MID_LO: 31 * RAD,
  SCREE_SLOPE_MID_HI: 38 * RAD,
  SCREE_SLOPE_HI: 44 * RAD,
  SCREE_ELEV_LO: 1500,
  SCREE_ELEV_HI: 1900,
  SCREE_DENSITY: 0.9,
  SCREE_ALPHA: 0.7
} as const;

/** Brezine ink roles, sRGB 0..1: soil brown #95500c, rock black #2b2724, ice/water blue #3f7fb3. */
export const INK_COLORS = {
  INK_SOIL: [149, 80, 12],
  INK_ROCK: [43, 39, 36],
  INK_ICE: [63, 127, 179]
} as const;

const num = (value: number): string => {
  const text = String(Number(value.toPrecision(9)));
  return /[.e]/.test(text) ? text : `${text}.0`;
};

const vec3 = (rgb: readonly number[]): string => rgb.map(c => num(c / 255)).join(', ');

/** The constant block, in WGSL (`wgsl: true`) or GLSL syntax. Shared by both snippets. */
export function makeInkConstants(wgsl: boolean): string {
  const lines: string[] = [];
  for (const [name, value] of Object.entries(INK_PARAMS)) {
    lines.push(
      wgsl ? `const LK_${name}: f32 = ${num(value)};` : `const float LK_${name} = ${num(value)};`
    );
  }
  for (const [name, rgb] of Object.entries(INK_COLORS)) {
    lines.push(
      wgsl
        ? `const LK_${name}: vec3<f32> = vec3<f32>(${vec3(rgb)});`
        : `const vec3 LK_${name} = vec3(${vec3(rgb)});`
    );
  }
  lines.push(
    wgsl
      ? `const LK_SEED: u32 = ${LANDESKARTE_SEED}u;`
      : `const uint LK_SEED = ${LANDESKARTE_SEED}u;`
  );
  return lines.join('\n');
}

export const INK_WGSL = /* wgsl */ `
${makeInkConstants(true)}

// Integer hash of a lattice cell to [0, 1). Float hashes like fract(sin(x)) differ between GPUs;
// u32 arithmetic wraps identically everywhere, so WebGPU and WebGL2 stipple the same dots.
fn lk_hash(cell: vec2<f32>, salt: u32) -> f32 {
  let x = bitcast<u32>(i32(cell.x));
  let y = bitcast<u32>(i32(cell.y));
  var h = x * 747796405u + y * 2891336453u + salt * 2654435761u + LK_SEED;
  h = (h ^ (h >> 16u)) * 2246822519u;
  h = (h ^ (h >> 13u)) * 3266489917u;
  h = h ^ (h >> 16u);
  return f32(h >> 8u) * 5.9604645e-8;
}

// One contour family as an anti-aliased line: 1 on the line, 0 beyond half a pixel past its edge.
// The distance to the nearest level is measured in metres and divided by metres-per-pixel, so the
// line keeps its pixel width at any zoom (the form from the spec, with the level in metres).
fn lk_contourLine(elevM: f32, fwidthElev: f32, interval: f32, widthPx: f32) -> f32 {
  let level = elevM / interval;
  let distanceM = abs(fract(level - 0.5) - 0.5) * interval;
  let distancePx = distanceM / max(fwidthElev, 0.0001);
  return 1.0 - smoothstep(0.5 * widthPx, 0.5 * widthPx + 1.0, distancePx);
}

// Premultiplied contour ink to composite over the base colour.
//  elevM       metres above sea level
//  fwidthElev  metres of elevation per pixel (computed by the caller, outside any branch)
//  slope       radians; aspect is unused here (kept so all three snippets share one calling shape)
//  shade       relief lightness 0 (dark) .. 1 (lit)
//  rangeM      reserved: local relief range for later density control
//  isLake      1 on the flat lake, which carries no contours
fn lk_ink(elevM: f32, fwidthElev: f32, slope: f32, aspect: f32, shade: f32, rangeM: f32,
    isLake: f32) -> vec4<f32> {
  // Thinning weights: each family fades out as its lines approach 8..13 px apart; the 500 m
  // family fades in as the 100 m one fades out so a distant sheet keeps a few quiet lines.
  let minorWeight = 1.0 - smoothstep(LK_MINOR_FADE_LO, LK_MINOR_FADE_HI, fwidthElev);
  let indexFade = smoothstep(LK_INDEX_FADE_LO, LK_INDEX_FADE_HI, fwidthElev);
  let indexWeight = 1.0 - indexFade;
  let superWeight = indexFade * (1.0 - smoothstep(LK_SUPER_FADE_LO, LK_SUPER_FADE_HI, fwidthElev));

  // All three lines are evaluated every pixel (cheap) and blended with the weights: no branches.
  var minorLine = lk_contourLine(elevM, fwidthElev, LK_MINOR_INTERVAL, LK_MINOR_WIDTH);
  let indexLine = lk_contourLine(elevM, fwidthElev, LK_INDEX_INTERVAL, LK_INDEX_WIDTH);
  let superLine = lk_contourLine(elevM, fwidthElev, LK_SUPER_INTERVAL, LK_SUPER_WIDTH);
  // On lit faces the pale ground needs less ink to read, shaded faces keep the full weight.
  minorLine = minorLine * mix(1.0, 0.75, shade);
  let coverage = max(
    max(minorLine * minorWeight * LK_MINOR_ALPHA, indexLine * indexWeight * LK_INDEX_ALPHA),
    superLine * superWeight * LK_INDEX_ALPHA
  );

  // Ink class: brown on soil, black on rock (high or steep), blue on ice, which wins over rock.
  let rock = max(
    smoothstep(LK_ROCK_ELEV_LO, LK_ROCK_ELEV_HI, elevM),
    smoothstep(LK_ROCK_SLOPE_LO, LK_ROCK_SLOPE_HI, slope)
  );
  let ice = smoothstep(LK_ICE_ELEV_LO, LK_ICE_ELEV_HI, elevM)
    * (1.0 - smoothstep(LK_ICE_SLOPE_LO, LK_ICE_SLOPE_HI, slope));
  let color = mix(mix(LK_INK_SOIL, LK_INK_ROCK, rock), LK_INK_ICE, ice);

  let notFlat = smoothstep(LK_FLAT_LO, LK_FLAT_HI, fwidthElev);
  let alpha = coverage * notFlat * (1.0 - clamp(isLake, 0.0, 1.0));
  return vec4<f32>(color * alpha, alpha);
}

// Metres per pixel snapped to half-octave steps. fwidth is constant per 2x2 quad and differs a
// little between quads; dividing a position of thousands of metres by it would move the pattern
// by whole cells at every quad border. The snapped scale is the same for neighbouring pixels, so
// the pattern is stable (stroke and dot sizes vary by at most about 19 % within a level).
fn lk_snapScale(metresPerPixel: f32) -> f32 {
  return exp2(floor(log2(max(metresPerPixel, 0.0001)) * 2.0 + 0.5) * 0.5);
}

// Rock hachure: short strokes running down the fall line, denser on shaded faces (3 px period)
// than on lit ones (5 px), only on steep ground. The fall direction is quantised to 16 sectors,
// because the raw DEM aspect jitters and would shred the stripes into noise; the sector seams
// then read as the facets of a hand-drawn rock face.
//  posEnu      east/north metres; fwidthPos is metres per pixel there
fn lk_hachure(posEnu: vec2<f32>, fwidthPos: f32, aspect: f32, slope: f32, shade: f32)
    -> vec4<f32> {
  let steep = smoothstep(LK_HACHURE_SLOPE_LO, LK_HACHURE_SLOPE_HI, slope);
  let metresPerPixel = lk_snapScale(fwidthPos);
  let sectorAngle = 6.2831853 / LK_HACHURE_SECTORS;
  let angle = floor(aspect / sectorAngle + 0.5) * sectorAngle;
  // Aspect is a compass azimuth: the fall direction in (east, north) is (sin, cos).
  let fall = vec2<f32>(sin(angle), cos(angle));
  let across = vec2<f32>(fall.y, -fall.x);
  let alongPx = dot(posEnu, fall) / (metresPerPixel * LK_HACHURE_LENGTH);
  let alongCell = floor(alongPx);
  let alongT = fract(alongPx);
  // Strokes taper in and out at their ends.
  let taper = smoothstep(0.0, 0.18, alongT) * (1.0 - smoothstep(0.82, 1.0, alongT));

  let tShade = dot(posEnu, across) / (metresPerPixel * LK_HACHURE_PERIOD_SHADE);
  let tLit = dot(posEnu, across) / (metresPerPixel * LK_HACHURE_PERIOD_LIT);
  let distShade = abs(fract(tShade) - 0.5) * LK_HACHURE_PERIOD_SHADE;
  let distLit = abs(fract(tLit) - 0.5) * LK_HACHURE_PERIOD_LIT;
  let lineShade = 1.0 - smoothstep(0.5 * LK_HACHURE_WIDTH, 0.5 * LK_HACHURE_WIDTH + 0.8, distShade);
  let lineLit = 1.0 - smoothstep(0.5 * LK_HACHURE_WIDTH, 0.5 * LK_HACHURE_WIDTH + 0.8, distLit);
  // Each stroke (stripe index x stroke index) survives or not by its own hash.
  let keepShade = step(lk_hash(vec2<f32>(floor(tShade), alongCell), 11u), LK_HACHURE_KEEP);
  let keepLit = step(lk_hash(vec2<f32>(floor(tLit), alongCell), 12u), LK_HACHURE_KEEP);

  let lit = smoothstep(0.35, 0.65, shade);
  let strokes = mix(lineShade * keepShade, lineLit * keepLit, lit);
  let alpha = strokes * taper * steep * mix(0.85, 0.5, lit);
  return vec4<f32>(LK_INK_ROCK * alpha, alpha);
}

// Scree stipple: one jittered dot per grid cell, kept or dropped by a hash against the talus
// belt. Dots stay inside their cell (jitter 0.3..0.7, so a 1.45 px dot is not clipped) so each pixel tests only its own cell.
fn lk_scree(posEnu: vec2<f32>, fwidthPos: f32, slope: f32, elevM: f32) -> vec4<f32> {
  let belt = smoothstep(LK_SCREE_SLOPE_LO, LK_SCREE_SLOPE_MID_LO, slope)
    * (1.0 - smoothstep(LK_SCREE_SLOPE_MID_HI, LK_SCREE_SLOPE_HI, slope))
    * smoothstep(LK_SCREE_ELEV_LO, LK_SCREE_ELEV_HI, elevM);
  let grid = posEnu / (lk_snapScale(fwidthPos) * LK_SCREE_PITCH);
  let cell = floor(grid);
  let local = fract(grid);
  let dotAt = vec2<f32>(0.3 + 0.4 * lk_hash(cell, 21u), 0.3 + 0.4 * lk_hash(cell, 22u));
  let radiusPx = 0.55 + 0.45 * lk_hash(cell, 23u);
  let distancePx = length(local - dotAt) * LK_SCREE_PITCH;
  let dotCover = 1.0 - smoothstep(radiusPx - 0.35, radiusPx + 0.45, distancePx);
  let keep = step(lk_hash(cell, 24u), belt * LK_SCREE_DENSITY) * step(0.0001, belt);
  let alpha = dotCover * keep * LK_SCREE_ALPHA;
  return vec4<f32>(LK_INK_ROCK * alpha, alpha);
}
`;
