// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Slope-driven Swiss-map rock hatching and scree dots (style.terroir.hatch; roadmap LF2). Needs no
// pack: where cover.pattern draws by cover class, this draws by terrain shape. The stroke kernel is
// ./pattern.ts (luma.gl patternFill port, vis.gl contributors, MIT), reused as is.
//
// Slope >= HATCH_ROCK_DEG hatches along the fall line (aspect quantised to 16 directions, spacing in
// ground metres so the strokes stay anchored to the terrain), wider on steeper faces; the band
// HATCH_SCREE_DEG..HATCH_ROCK_DEG gets a dot screen. With a cover grid, bare rock (3) hatches from a
// lower slope, scree (4) always dots, and vegetation, glacier, firn, water, built-up get none. The
// strokes darken the albedo before snow, so snow hides them. Display only.

/** Slope (deg) where rock hatching starts / is full after HATCH_RAMP_DEG more. */
export const HATCH_ROCK_DEG = 38;
export const HATCH_RAMP_DEG = 8;
/** Slope (deg) where the scree dots start. */
export const HATCH_SCREE_DEG = 24;
/** Ground metres between fall-line strokes / between scree dots. */
export const HATCH_SPACING_M = 14;
export const HATCH_DOT_SPACING_M = 6;
/** Stroke width as a fraction of the spacing: at the rock threshold, on a vertical face. */
export const HATCH_WIDTH: [number, number] = [0.14, 0.3];
export const HATCH_DOT_WIDTH = 0.45;
/** Ink: the albedo multiplied by this where the strokes land (a warm near-black). */
export const HATCH_INK = "0.26, 0.23, 0.21";

const f = (x: number) => (Number.isInteger(x) ? `${x}.0` : String(x));
const C = {
	rock: f(HATCH_ROCK_DEG),
	rockEnd: f(HATCH_ROCK_DEG + HATCH_RAMP_DEG),
	rockLow: f(HATCH_ROCK_DEG - 10),
	rockWide: f(HATCH_ROCK_DEG + 30),
	screeA: f(HATCH_SCREE_DEG),
	screeB: f(HATCH_SCREE_DEG + 5),
	screeOutA: f(HATCH_ROCK_DEG - 2),
	screeOutB: f(HATCH_ROCK_DEG + 4),
	sp: f(HATCH_SPACING_M),
	dsp: f(HATCH_DOT_SPACING_M),
	w0: f(HATCH_WIDTH[0]),
	w1: f(HATCH_WIDTH[1]),
	dw: f(HATCH_DOT_WIDTH),
};

/** GLSL terHatch(n, xy, elev, fw, fwElev, class) → ink coverage; needs PATTERN_KERNEL_GLSL before it. */
export const HATCH_GLSL = /* glsl */ `
// ---- slope hatch (src/lib/terroir/hatch.ts) ----
float terHatch(vec3 n, vec2 xy, float elev, vec2 fw, float fwElev, int c) {
  if (c == 1 || c == 2 || (c >= 5 && c <= 14)) return 0.0;
  float slope = degrees(acos(clamp(n.z, -1.0, 1.0)));
  float rock = smoothstep(${C.rock}, ${C.rockEnd}, slope);
  float scree = smoothstep(${C.screeA}, ${C.screeB}, slope) * (1.0 - smoothstep(${C.screeOutA}, ${C.screeOutB}, slope));
  if (c == 3) rock = max(rock, smoothstep(${C.rockLow}, ${C.rock}, slope));
  if (c == 4) scree = max(scree, 0.7 * (1.0 - rock));
  float q = floor(atan(n.y, n.x) / 0.39269908 + 0.5) * 0.39269908;
  float w = mix(${C.w0}, ${C.w1}, smoothstep(${C.rock}, ${C.rockWide}, slope));
  float strokes = terPatHatch(xy, fw, ${C.sp}, w, q + 1.5707963);
  float dots = terPatDots(xy + vec2(0.71, -0.71) * elev, fw + vec2(0.71 * fwElev), ${C.dsp}, ${C.dw}, 0.0);
  return clamp(rock * strokes + scree * dots, 0.0, 1.0) * 0.8;
}
`;

/** WGSL twin (ter_hatch; needs PATTERN_KERNEL_WGSL before it). */
export const HATCH_WGSL = /* wgsl */ `\
// ---- slope hatch (src/lib/terroir/hatch.ts) ----
fn ter_hatch(n: vec3<f32>, xy: vec2<f32>, elev: f32, fw: vec2<f32>, fwElev: f32, c: i32) -> f32 {
  if (c == 1 || c == 2 || (c >= 5 && c <= 14)) { return 0.0; }
  let slope = degrees(acos(clamp(n.z, -1.0, 1.0)));
  var rock = smoothstep(${C.rock}, ${C.rockEnd}, slope);
  var scree = smoothstep(${C.screeA}, ${C.screeB}, slope) * (1.0 - smoothstep(${C.screeOutA}, ${C.screeOutB}, slope));
  if (c == 3) { rock = max(rock, smoothstep(${C.rockLow}, ${C.rock}, slope)); }
  if (c == 4) { scree = max(scree, 0.7 * (1.0 - rock)); }
  let q = floor(atan2(n.y, n.x) / 0.39269908 + 0.5) * 0.39269908;
  let w = mix(${C.w0}, ${C.w1}, smoothstep(${C.rock}, ${C.rockWide}, slope));
  let strokes = ter_pat_hatch(xy, fw, ${C.sp}, w, q + 1.5707963);
  let dots = ter_pat_dots(xy + vec2<f32>(0.71, -0.71) * elev, fw + vec2<f32>(0.71 * fwElev), ${C.dsp}, ${C.dw}, 0.0);
  return clamp(rock * strokes + scree * dots, 0.0, 1.0) * 0.8;
}
`;
