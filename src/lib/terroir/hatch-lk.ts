// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Hatch v2, the Landeskarte look (style.terroir.hatchStyle = "landeskarte"). The maths of lk_hachure /
// lk_scree in examples/deck/landeskarte/terrain/ink.{glsl,wgsl}.ts (same repo, MIT) ported with one
// change: the example spaces its strokes in pixels (fwidth periods), which swims under zoom and seams
// in oblique views. Here every period is a power-of-two multiple of a ground-metre base, so the
// lattice is anchored to the terrain, and two neighbouring octaves are blended by the screen
// footprint (metres per pixel). Lines at the coarse octave are every other line of the fine one
// (nested), so a zoom changes weights, never positions.
//
// Three inks: rock hachure (fall-line strokes in 16 aspect sectors, denser on the shadow side, tapered
// at both ends, thinned by a per-cell hash), scree stipple (jittered dots, talus belt), glacier lines
// (blue, across the fall line, crevasse-like). Mask: slope + elevation; with a cover pack, bare rock
// (3) and scree (4) widen it, glacier (1) draws the blue lines, vegetation and water draw nothing.
// The result is ink colour + coverage, mixed over the albedo before snow, so snow hides it.
// Display only. LKH_* constants are shared by GLSL, WGSL and the CPU reference below.

const RAD = Math.PI / 180;

export const HATCH_LK = {
	// Hachure: stripe period in pixels on shadow / lit faces, stroke width (px), stroke length
	// (periods), the chance a stroke exists, aspect sectors.
	SLOPE_LO: 36 * RAD,
	SLOPE_HI: 44 * RAD,
	PERIOD_SHADE_PX: 3.5,
	PERIOD_LIT_PX: 6,
	WIDTH_PX: 0.9,
	LENGTH_PERIODS: 3.2,
	KEEP: 0.7,
	SECTORS: 16,
	// Ground-metre base of the octave ladder (period of the finest stripes / dots, metres).
	MIN_PERIOD_M: 1.5,
	MIN_CELL_M: 1.5,
	// Rock mask: slope and elevation (design decision D5, first option).
	ROCK_ELEV_LO: 1500,
	ROCK_ELEV_HI: 1900,
	// Scree stipple: cell pitch (px), slope belt (talus rests at about 30 to 38 degrees).
	SCREE_PITCH_PX: 5,
	SCREE_SLOPE_LO: 26 * RAD,
	SCREE_SLOPE_MID_LO: 31 * RAD,
	SCREE_SLOPE_MID_HI: 38 * RAD,
	SCREE_SLOPE_HI: 44 * RAD,
	SCREE_DENSITY: 0.9,
	SCREE_ALPHA: 0.7,
	// Glacier lines (no pack: an elevation and slope belt; pack: class 1).
	ICE_PERIOD_PX: 5,
	ICE_WIDTH_PX: 0.8,
	ICE_KEEP: 0.55,
	ICE_ALPHA: 0.5,
	ICE_ELEV_LO: 2800,
	ICE_ELEV_HI: 3000,
	ICE_SLOPE_LO: 32 * RAD,
	ICE_SLOPE_HI: 42 * RAD,
	// Hachure and stipple give way to the horizon haze: metres per pixel where the fade runs.
	FAR_LO: 30,
	FAR_HI: 80,
	// With a pack, bare rock (class 3) hatches from this lower slope.
	CLASS_ROCK_LO: 30 * RAD,
	CLASS_ROCK_HI: 38 * RAD,
	// Sun term (dot(normal, sun)) range where a face turns from shadow to lit spacing.
	LIT_LO: 0.1,
	LIT_HI: 0.55,
} as const;

/** Brezine ink roles (src/brand/khipu.ts): rock black-grey #2b2724, ice blue #3f7fb3. */
export const HATCH_LK_INK = {
	ROCK: [43, 39, 36],
	ICE: [63, 127, 179],
} as const;

const LK_SEED = 0x4e1d_0907;

const num = (value: number): string => {
	const text = String(Number(value.toPrecision(9)));
	return /[.e]/.test(text) ? text : `${text}.0`;
};
const vec3 = (rgb: readonly number[]) =>
	rgb.map((c) => num(c / 255)).join(", ");

function constants(wgsl: boolean): string {
	const lines: string[] = [];
	for (const [name, value] of Object.entries(HATCH_LK))
		lines.push(
			wgsl
				? `const LKH_${name}: f32 = ${num(value)};`
				: `const float LKH_${name} = ${num(value)};`,
		);
	for (const [name, rgb] of Object.entries(HATCH_LK_INK))
		lines.push(
			wgsl
				? `const LKH_INK_${name}: vec3<f32> = vec3<f32>(${vec3(rgb)});`
				: `const vec3 LKH_INK_${name} = vec3(${vec3(rgb)});`,
		);
	lines.push(
		wgsl
			? `const LKH_SEED: u32 = ${LK_SEED}u;`
			: `const uint LKH_SEED = ${LK_SEED}u;`,
	);
	return lines.join("\n");
}

/** GLSL terHatchLk(n, xy, elev, fw, lit, class) → vec4(ink rgb, coverage). Self-contained. */
export const HATCH_LK_GLSL = /* glsl */ `
// ---- hatch v2, Landeskarte look (src/lib/terroir/hatch-lk.ts) ----
${constants(false)}
float lkhHash(vec2 cell, uint salt) {
  uint x = uint(int(cell.x));
  uint y = uint(int(cell.y));
  uint h = x * 747796405u + y * 2891336453u + salt * 2654435761u + LKH_SEED;
  h = (h ^ (h >> 16u)) * 2246822519u;
  h = (h ^ (h >> 13u)) * 3266489917u;
  h = h ^ (h >> 16u);
  return float(h >> 8u) * 5.9604645e-8;
}
// octave ladder: x = fine period (m), y = blend weight of the next (double) octave
vec2 lkhOctave(float idealM, float baseM) {
  float o = log2(max(idealM / baseM, 1.0));
  float l = floor(o);
  return vec2(baseM * exp2(l), o - l);
}
float lkhStroke(vec2 pos, vec2 fall, vec2 across, float period, float mpp, float widthPx, float keepP, uint salt) {
  float s = dot(pos, across) / period + 0.5;
  float a = dot(pos, fall) / (period * LKH_LENGTH_PERIODS);
  float distPx = abs(fract(s) - 0.5) * period / mpp;
  float line = 1.0 - smoothstep(0.5 * widthPx, 0.5 * widthPx + 0.8, distPx);
  float taper = smoothstep(0.0, 0.18, fract(a)) * (1.0 - smoothstep(0.82, 1.0, fract(a)));
  float keep = step(lkhHash(vec2(floor(s), floor(a)), salt), keepP);
  return line * keep * taper;
}
float lkhStrokes(vec2 pos, vec2 fall, vec2 across, float periodPx, float mpp, float widthPx, float keepP, uint salt) {
  vec2 o = lkhOctave(periodPx * mpp, LKH_MIN_PERIOD_M);
  return mix(
    lkhStroke(pos, fall, across, o.x, mpp, widthPx, keepP, salt),
    lkhStroke(pos, fall, across, o.x * 2.0, mpp, widthPx, keepP, salt),
    o.y);
}
float lkhDot(vec2 pos, float cellM, float mpp, float density) {
  vec2 g = pos / cellM;
  vec2 cell = floor(g);
  vec2 local = fract(g);
  vec2 at = vec2(0.3 + 0.4 * lkhHash(cell, 21u), 0.3 + 0.4 * lkhHash(cell, 22u));
  float radiusPx = 0.55 + 0.45 * lkhHash(cell, 23u);
  float distPx = length(local - at) * cellM / mpp;
  float cover = 1.0 - smoothstep(radiusPx - 0.35, radiusPx + 0.45, distPx);
  return cover * step(lkhHash(cell, 24u), density);
}
vec4 terHatchLk(vec3 n, vec2 xy, float elev, vec2 fw, float lit, int c) {
  if (c == 2 || c == 12 || (c >= 5 && c <= 11) || c == 13 || c == 14) return vec4(0.0);
  float mpp = max(max(fw.x, fw.y), 0.001);
  float slope = acos(clamp(n.z, -1.0, 1.0));
  float farFade = 1.0 - smoothstep(LKH_FAR_LO, LKH_FAR_HI, mpp);
  float elevGate = smoothstep(LKH_ROCK_ELEV_LO, LKH_ROCK_ELEV_HI, elev);
  float rock = smoothstep(LKH_SLOPE_LO, LKH_SLOPE_HI, slope) * elevGate;
  float belt = smoothstep(LKH_SCREE_SLOPE_LO, LKH_SCREE_SLOPE_MID_LO, slope)
    * (1.0 - smoothstep(LKH_SCREE_SLOPE_MID_HI, LKH_SCREE_SLOPE_HI, slope));
  float scree = belt * elevGate;
  float ice = smoothstep(LKH_ICE_ELEV_LO, LKH_ICE_ELEV_HI, elev)
    * (1.0 - smoothstep(LKH_ICE_SLOPE_LO, LKH_ICE_SLOPE_HI, slope));
  if (c == 3) rock = max(rock, smoothstep(LKH_CLASS_ROCK_LO, LKH_CLASS_ROCK_HI, slope));
  if (c == 4) scree = max(scree, 0.7 * belt * (1.0 - rock));
  if (c == 1) { ice = 1.0; rock = 0.0; scree = 0.0; }
  else if (c != 0) ice = 0.0;
  if (c == 0 || c == 3 || c == 4) ice *= 1.0 - rock;
  vec2 pos = xy + vec2(0.71, -0.71) * elev;
  float q = floor(atan(n.y, n.x) / (6.2831853 / LKH_SECTORS) + 0.5) * (6.2831853 / LKH_SECTORS);
  vec2 fall = vec2(cos(q), sin(q));
  vec2 across = vec2(-fall.y, fall.x);
  float aRock = 0.0;
  if (rock > 0.001) {
    float litW = smoothstep(LKH_LIT_LO, LKH_LIT_HI, lit);
    float shadeLines = lkhStrokes(pos, fall, across, LKH_PERIOD_SHADE_PX, mpp, LKH_WIDTH_PX, LKH_KEEP, 11u);
    float litLines = lkhStrokes(pos, fall, across, LKH_PERIOD_LIT_PX, mpp, LKH_WIDTH_PX, LKH_KEEP, 12u);
    aRock = rock * mix(shadeLines, litLines, litW) * mix(0.85, 0.5, litW);
  }
  float aScree = 0.0;
  if (scree > 0.001) {
    vec2 o = lkhOctave(LKH_SCREE_PITCH_PX * mpp, LKH_MIN_CELL_M);
    float d = scree * LKH_SCREE_DENSITY;
    aScree = mix(lkhDot(pos, o.x, mpp, d), lkhDot(pos, o.x * 2.0, mpp, d), o.y) * LKH_SCREE_ALPHA;
  }
  float aIce = 0.0;
  if (ice > 0.001) aIce = ice * lkhStrokes(pos, across, fall, LKH_ICE_PERIOD_PX, mpp, LKH_ICE_WIDTH_PX, LKH_ICE_KEEP, 31u) * LKH_ICE_ALPHA;
  float dark = (aRock + aScree) * farFade;
  float blue = aIce * farFade;
  float a = clamp(dark + blue, 0.0, 1.0);
  return vec4(mix(LKH_INK_ROCK, LKH_INK_ICE, blue / max(dark + blue, 1e-4)), a);
}
`;

/** WGSL twin (ter_hatch_lk). */
export const HATCH_LK_WGSL = /* wgsl */ `\
// ---- hatch v2, Landeskarte look (src/lib/terroir/hatch-lk.ts) ----
${constants(true)}
fn lkh_hash(cell: vec2<f32>, salt: u32) -> f32 {
  let x = bitcast<u32>(i32(cell.x));
  let y = bitcast<u32>(i32(cell.y));
  var h = x * 747796405u + y * 2891336453u + salt * 2654435761u + LKH_SEED;
  h = (h ^ (h >> 16u)) * 2246822519u;
  h = (h ^ (h >> 13u)) * 3266489917u;
  h = h ^ (h >> 16u);
  return f32(h >> 8u) * 5.9604645e-8;
}
fn lkh_octave(idealM: f32, baseM: f32) -> vec2<f32> {
  let o = log2(max(idealM / baseM, 1.0));
  let l = floor(o);
  return vec2<f32>(baseM * exp2(l), o - l);
}
fn lkh_stroke(pos: vec2<f32>, fall: vec2<f32>, across: vec2<f32>, period: f32, mpp: f32, widthPx: f32, keepP: f32, salt: u32) -> f32 {
  let s = dot(pos, across) / period + 0.5;
  let a = dot(pos, fall) / (period * LKH_LENGTH_PERIODS);
  let distPx = abs(fract(s) - 0.5) * period / mpp;
  let line = 1.0 - smoothstep(0.5 * widthPx, 0.5 * widthPx + 0.8, distPx);
  let taper = smoothstep(0.0, 0.18, fract(a)) * (1.0 - smoothstep(0.82, 1.0, fract(a)));
  let keep = step(lkh_hash(vec2<f32>(floor(s), floor(a)), salt), keepP);
  return line * keep * taper;
}
fn lkh_strokes(pos: vec2<f32>, fall: vec2<f32>, across: vec2<f32>, periodPx: f32, mpp: f32, widthPx: f32, keepP: f32, salt: u32) -> f32 {
  let o = lkh_octave(periodPx * mpp, LKH_MIN_PERIOD_M);
  return mix(
    lkh_stroke(pos, fall, across, o.x, mpp, widthPx, keepP, salt),
    lkh_stroke(pos, fall, across, o.x * 2.0, mpp, widthPx, keepP, salt),
    o.y);
}
fn lkh_dot(pos: vec2<f32>, cellM: f32, mpp: f32, density: f32) -> f32 {
  let g = pos / cellM;
  let cell = floor(g);
  let local = fract(g);
  let at = vec2<f32>(0.3 + 0.4 * lkh_hash(cell, 21u), 0.3 + 0.4 * lkh_hash(cell, 22u));
  let radiusPx = 0.55 + 0.45 * lkh_hash(cell, 23u);
  let distPx = length(local - at) * cellM / mpp;
  let cover = 1.0 - smoothstep(radiusPx - 0.35, radiusPx + 0.45, distPx);
  return cover * step(lkh_hash(cell, 24u), density);
}
fn ter_hatch_lk(n: vec3<f32>, xy: vec2<f32>, elev: f32, fw: vec2<f32>, lit: f32, c: i32) -> vec4<f32> {
  if (c == 2 || c == 12 || (c >= 5 && c <= 11) || c == 13 || c == 14) { return vec4<f32>(0.0); }
  let mpp = max(max(fw.x, fw.y), 0.001);
  let slope = acos(clamp(n.z, -1.0, 1.0));
  let farFade = 1.0 - smoothstep(LKH_FAR_LO, LKH_FAR_HI, mpp);
  let elevGate = smoothstep(LKH_ROCK_ELEV_LO, LKH_ROCK_ELEV_HI, elev);
  var rock = smoothstep(LKH_SLOPE_LO, LKH_SLOPE_HI, slope) * elevGate;
  let belt = smoothstep(LKH_SCREE_SLOPE_LO, LKH_SCREE_SLOPE_MID_LO, slope)
    * (1.0 - smoothstep(LKH_SCREE_SLOPE_MID_HI, LKH_SCREE_SLOPE_HI, slope));
  var scree = belt * elevGate;
  var ice = smoothstep(LKH_ICE_ELEV_LO, LKH_ICE_ELEV_HI, elev)
    * (1.0 - smoothstep(LKH_ICE_SLOPE_LO, LKH_ICE_SLOPE_HI, slope));
  if (c == 3) { rock = max(rock, smoothstep(LKH_CLASS_ROCK_LO, LKH_CLASS_ROCK_HI, slope)); }
  if (c == 4) { scree = max(scree, 0.7 * belt * (1.0 - rock)); }
  if (c == 1) { ice = 1.0; rock = 0.0; scree = 0.0; } else if (c != 0) { ice = 0.0; }
  if (c == 0 || c == 3 || c == 4) { ice = ice * (1.0 - rock); }
  let pos = xy + vec2<f32>(0.71, -0.71) * elev;
  let q = floor(atan2(n.y, n.x) / (6.2831853 / LKH_SECTORS) + 0.5) * (6.2831853 / LKH_SECTORS);
  let fall = vec2<f32>(cos(q), sin(q));
  let across = vec2<f32>(-fall.y, fall.x);
  var aRock = 0.0;
  if (rock > 0.001) {
    let litW = smoothstep(LKH_LIT_LO, LKH_LIT_HI, lit);
    let shadeLines = lkh_strokes(pos, fall, across, LKH_PERIOD_SHADE_PX, mpp, LKH_WIDTH_PX, LKH_KEEP, 11u);
    let litLines = lkh_strokes(pos, fall, across, LKH_PERIOD_LIT_PX, mpp, LKH_WIDTH_PX, LKH_KEEP, 12u);
    aRock = rock * mix(shadeLines, litLines, litW) * mix(0.85, 0.5, litW);
  }
  var aScree = 0.0;
  if (scree > 0.001) {
    let o = lkh_octave(LKH_SCREE_PITCH_PX * mpp, LKH_MIN_CELL_M);
    let d = scree * LKH_SCREE_DENSITY;
    aScree = mix(lkh_dot(pos, o.x, mpp, d), lkh_dot(pos, o.x * 2.0, mpp, d), o.y) * LKH_SCREE_ALPHA;
  }
  var aIce = 0.0;
  if (ice > 0.001) { aIce = ice * lkh_strokes(pos, across, fall, LKH_ICE_PERIOD_PX, mpp, LKH_ICE_WIDTH_PX, LKH_ICE_KEEP, 31u) * LKH_ICE_ALPHA; }
  let dark = (aRock + aScree) * farFade;
  let blue = aIce * farFade;
  let a = clamp(dark + blue, 0.0, 1.0);
  return vec4<f32>(mix(LKH_INK_ROCK, LKH_INK_ICE, blue / max(dark + blue, 1e-4)), a);
}
`;

// ---- CPU reference (hatch.check.ts) -------------------------------------------------------------

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const smoothstep = (a: number, b: number, x: number) => {
	const t = clamp01((x - a) / (b - a));
	return t * t * (3 - 2 * t);
};
const fract = (x: number) => x - Math.floor(x);

/** The integer cell hash of the shaders, [0, 1). */
export function lkhHash(cx: number, cy: number, salt: number): number {
	let h =
		(Math.imul(cx | 0, 747796405) +
			Math.imul(cy | 0, 2891336453 | 0) +
			Math.imul(salt, 2654435761 | 0) +
			LK_SEED) >>>
		0;
	h = Math.imul(h ^ (h >>> 16), 2246822519 | 0) >>> 0;
	h = Math.imul(h ^ (h >>> 13), 3266489917 | 0) >>> 0;
	h = (h ^ (h >>> 16)) >>> 0;
	return (h >>> 8) * 5.9604645e-8;
}

/** [fine period (m), weight of the double octave] for an ideal period. */
export function lkhOctave(idealM: number, baseM: number): [number, number] {
	const o = Math.log2(Math.max(idealM / baseM, 1));
	const l = Math.floor(o);
	return [baseM * 2 ** l, o - l];
}

/** One octave of the stroke field at ground position (x, y); `fallAngle` is the fall line (radians). */
export function lkhStroke(
	x: number,
	y: number,
	fallAngle: number,
	period: number,
	mpp: number,
	widthPx: number,
	keepP: number,
	salt: number,
): number {
	const fx = Math.cos(fallAngle);
	const fy = Math.sin(fallAngle);
	const s = (x * -fy + y * fx) / period + 0.5;
	const a = (x * fx + y * fy) / (period * HATCH_LK.LENGTH_PERIODS);
	const distPx = (Math.abs(fract(s) - 0.5) * period) / mpp;
	const line = 1 - smoothstep(0.5 * widthPx, 0.5 * widthPx + 0.8, distPx);
	const taper =
		smoothstep(0, 0.18, fract(a)) * (1 - smoothstep(0.82, 1, fract(a)));
	const keep = lkhHash(Math.floor(s), Math.floor(a), salt) <= keepP ? 1 : 0;
	return line * keep * taper;
}

/** Octave-blended stroke coverage at a footprint of `mpp` metres per pixel. */
export function lkhStrokes(
	x: number,
	y: number,
	fallAngle: number,
	periodPx: number,
	mpp: number,
	widthPx: number,
	keepP: number,
	salt: number,
): number {
	const [fine, w] = lkhOctave(periodPx * mpp, HATCH_LK.MIN_PERIOD_M);
	const a = lkhStroke(x, y, fallAngle, fine, mpp, widthPx, keepP, salt);
	const b = lkhStroke(x, y, fallAngle, fine * 2, mpp, widthPx, keepP, salt);
	return a + (b - a) * w;
}

/** Shade-dependent rock hachure coverage: tighter period and stronger ink on the shadow side. */
export function lkhHachure(
	x: number,
	y: number,
	fallAngle: number,
	mpp: number,
	lit: number,
): number {
	const H = HATCH_LK;
	const litW = smoothstep(H.LIT_LO, H.LIT_HI, lit);
	const shade = lkhStrokes(
		x,
		y,
		fallAngle,
		H.PERIOD_SHADE_PX,
		mpp,
		H.WIDTH_PX,
		H.KEEP,
		11,
	);
	const light = lkhStrokes(
		x,
		y,
		fallAngle,
		H.PERIOD_LIT_PX,
		mpp,
		H.WIDTH_PX,
		H.KEEP,
		12,
	);
	return (shade + (light - shade) * litW) * (0.85 + (0.5 - 0.85) * litW);
}
