// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) vis.gl contributors
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Terroir pattern fills: filtered hatching and dot stipple in world metres, the Swiss-map symbology
// for scree (dots), rock (hatching, denser in shade) and glacier (sparse crevasse lines).
// Credit: luma.gl patternFill (MIT, Copyright (c) vis.gl contributors; luma master 7289d961, #3320,
//   modules/shadertools/src/modules/geometry/pattern-fill/pattern-fill-shaders.ts). The analytic
//   filtering is kept as is: a stripe is the box-filtered pulse (the difference of the pulse integral
//   over the pixel footprint), so the mean coverage survives at distance, and dots fade to their mean
//   area pi r^2 as the footprint grows. Differences from upstream: no uniform block (the functions take
//   their parameters; the terroir block has no pattern fields), and the footprint is passed in (the
//   caller evaluates fwidth(xy) / the WGSL dEnuDx, dEnuDy sum in uniform control flow, before any class
//   branching) as ground metres and rotated here, instead of fwidth of the rotated phase.
// GLSL (WebGL2 terrain), WGSL (deck-webgpu terrain) and the CPU mirror below share one set of
// constants; src/lib/terroir/pattern.check.ts keeps them honest.

/** Hatch and dot parameters per cover class (metres, fractions of a cell, radians). */
export const TERROIR_PATTERN_PARAMS = {
	scree: { spacing: 6, width: 0.35, strength: 0.55 },
	rock: {
		spacing: 5,
		widthLit: 0.1,
		widthShade: 0.4,
		angle: 0.7854,
		strength: 0.6,
	},
	glacier: { spacing: 40, width: 0.04, angle: 1.047, strength: 0.5 },
} as const;

// ---- CPU mirror ----

const fract = (x: number) => x - Math.floor(x);
const clamp = (x: number, lo: number, hi: number) =>
	Math.min(Math.max(x, lo), hi);
const smoothstep = (a: number, b: number, x: number) => {
	const t = clamp((x - a) / (b - a), 0, 1);
	return t * t * (3 - 2 * t);
};

/** Integral of a unit-period pulse of the given width (0..1) from 0. */
export function patternIntegral(coordinate: number, width: number): number {
	return Math.floor(coordinate) * width + Math.min(fract(coordinate), width);
}

/** Coverage of the stripe pulse (centred on integer phases) box-filtered over `footprint` phase units. */
export function patternStripe(
	coordinate: number,
	footprint: number,
	width: number,
): number {
	const extent = Math.max(footprint, 0.0001);
	const center = fract(coordinate + width * 0.5);
	return clamp(
		(patternIntegral(center + extent * 0.5, width) -
			patternIntegral(center - extent * 0.5, width)) /
			extent,
		0,
		1,
	);
}

export type PatternKind = "hatch" | "dots";

/**
 * Coverage 0..1 at ground (x, y) metres. `footprint` = fwidth(xy) in metres (|d/dx| + |d/dy| per
 * component); the GLSL / WGSL terPatHatch / terPatDots do exactly this.
 */
export function patternCoverage(
	kind: PatternKind,
	xy: readonly [number, number],
	footprint: readonly [number, number],
	spacing: number,
	width: number,
	angle: number,
): number {
	const w = clamp(width, 0, 1);
	if (w <= 0) return 0;
	const c = Math.cos(angle);
	const s = Math.sin(angle);
	const sp = Math.max(spacing, 0.0001);
	const px = (xy[0] * c + xy[1] * s) / sp;
	const py = (-xy[0] * s + xy[1] * c) / sp;
	const ac = Math.abs(c);
	const as = Math.abs(s);
	const fx = (ac * footprint[0] + as * footprint[1]) / sp;
	const fy = (as * footprint[0] + ac * footprint[1]) / sp;
	if (kind === "hatch") return patternStripe(px, fx, w);
	const cx = fract(px + 0.5) - 0.5;
	const cy = fract(py + 0.5) - 0.5;
	const radius = w * 0.5;
	let dots = clamp(
		0.5 + (radius - Math.hypot(cx, cy)) / Math.max(Math.hypot(fx, fy), 0.0001),
		0,
		1,
	);
	const dotMean = Math.PI * radius * radius;
	const t = smoothstep(0.35, 1.0, Math.max(fx, fy));
	dots = dots + (dotMean - dots) * t;
	return dots;
}

// ---- GLSL ----

/** The class-free kernel (terPatHatch / terPatDots): what style.terroir.hatch reuses. */
export const PATTERN_KERNEL_GLSL = /* glsl */ `
// luma.gl patternFill (#3320) analytic filtering, in world metres. fw = fwidth(xy), evaluated by the
// caller in uniform control flow (before any class branching).
float terPatIntegral(float coordinate, float width) {
  return floor(coordinate) * width + min(fract(coordinate), width);
}
float terPatStripe(float coordinate, float footprint, float width) {
  float extent = max(footprint, 0.0001);
  float center = fract(coordinate + width * 0.5);
  return clamp((terPatIntegral(center + extent * 0.5, width) -
    terPatIntegral(center - extent * 0.5, width)) / extent, 0.0, 1.0);
}
float terPatHatch(vec2 xy, vec2 fw, float spacing, float width, float angle) {
  float w = clamp(width, 0.0, 1.0);
  if (w <= 0.0) return 0.0;
  float c = cos(angle);
  float s = sin(angle);
  float sp = max(spacing, 0.0001);
  float px = dot(xy, vec2(c, s)) / sp;
  float fx = (abs(c) * fw.x + abs(s) * fw.y) / sp;
  return terPatStripe(px, fx, w);
}
float terPatDots(vec2 xy, vec2 fw, float spacing, float width, float angle) {
  float w = clamp(width, 0.0, 1.0);
  if (w <= 0.0) return 0.0;
  float c = cos(angle);
  float s = sin(angle);
  float sp = max(spacing, 0.0001);
  vec2 phase = vec2(dot(xy, vec2(c, s)), dot(xy, vec2(-s, c))) / sp;
  vec2 footprint = vec2(abs(c) * fw.x + abs(s) * fw.y, abs(s) * fw.x + abs(c) * fw.y) / sp;
  vec2 cell = fract(phase + 0.5) - 0.5;
  float radius = w * 0.5;
  float dots = clamp(0.5 + (radius - length(cell)) / max(length(footprint), 0.0001), 0.0, 1.0);
  float dotMean = 3.141592653589793 * radius * radius;
  return mix(dots, dotMean, smoothstep(0.35, 1.0, max(footprint.x, footprint.y)));
}
`;

/** Uniform-free pattern functions (include once, before terPatternCover). */
export const PATTERN_GLSL = /* glsl */ `${PATTERN_KERNEL_GLSL}// scree = dots, rock = hatching (more lines in shade), glacier = sparse crevasse hatching, in the class ink
vec3 terPatternCover(int c, vec2 p, vec3 col, vec2 fw, float lit) {
  float shade = 1.0 - smoothstep(-0.05, 0.45, lit);
  float cov = 0.0;
  if (c == 4) {
    cov = terPatDots(p, fw, ${TERROIR_PATTERN_PARAMS.scree.spacing.toFixed(1)}, ${TERROIR_PATTERN_PARAMS.scree.width}, 0.0) * ${TERROIR_PATTERN_PARAMS.scree.strength};
  } else if (c == 3) {
    cov = terPatHatch(p, fw, ${TERROIR_PATTERN_PARAMS.rock.spacing.toFixed(1)}, mix(${TERROIR_PATTERN_PARAMS.rock.widthLit}, ${TERROIR_PATTERN_PARAMS.rock.widthShade}, shade), ${TERROIR_PATTERN_PARAMS.rock.angle}) * ${TERROIR_PATTERN_PARAMS.rock.strength};
  } else if (c == 1) {
    cov = terPatHatch(p, fw, ${TERROIR_PATTERN_PARAMS.glacier.spacing.toFixed(1)}, ${TERROIR_PATTERN_PARAMS.glacier.width}, ${TERROIR_PATTERN_PARAMS.glacier.angle}) * ${TERROIR_PATTERN_PARAMS.glacier.strength};
  }
  return cov > 0.0 ? mix(col, terInk(c), cov) : col;
}
`;

// ---- WGSL ----

/** WGSL twin of PATTERN_KERNEL_GLSL (ter_pat_hatch / ter_pat_dots). */
export const PATTERN_KERNEL_WGSL = /* wgsl */ `
fn ter_pat_integral(coordinate: f32, width: f32) -> f32 {
  return floor(coordinate) * width + min(fract(coordinate), width);
}
fn ter_pat_stripe(coordinate: f32, footprint: f32, width: f32) -> f32 {
  let extent = max(footprint, 0.0001);
  let center = fract(coordinate + width * 0.5);
  return clamp((ter_pat_integral(center + extent * 0.5, width) -
    ter_pat_integral(center - extent * 0.5, width)) / extent, 0.0, 1.0);
}
// fw = |dEnuDx.xy| + |dEnuDy.xy| (fwidth of xy), taken from the sample, so this is legal anywhere
fn ter_pat_hatch(xy: vec2<f32>, fw: vec2<f32>, spacing: f32, width: f32, angle: f32) -> f32 {
  let w = clamp(width, 0.0, 1.0);
  if (w <= 0.0) { return 0.0; }
  let c = cos(angle);
  let s = sin(angle);
  let sp = max(spacing, 0.0001);
  let px = dot(xy, vec2<f32>(c, s)) / sp;
  let fx = (abs(c) * fw.x + abs(s) * fw.y) / sp;
  return ter_pat_stripe(px, fx, w);
}
fn ter_pat_dots(xy: vec2<f32>, fw: vec2<f32>, spacing: f32, width: f32, angle: f32) -> f32 {
  let w = clamp(width, 0.0, 1.0);
  if (w <= 0.0) { return 0.0; }
  let c = cos(angle);
  let s = sin(angle);
  let sp = max(spacing, 0.0001);
  let phase = vec2<f32>(dot(xy, vec2<f32>(c, s)), dot(xy, vec2<f32>(-s, c))) / sp;
  let footprint = vec2<f32>(abs(c) * fw.x + abs(s) * fw.y, abs(s) * fw.x + abs(c) * fw.y) / sp;
  let cell = fract(phase + 0.5) - 0.5;
  let radius = w * 0.5;
  let dots = clamp(0.5 + (radius - length(cell)) / max(length(footprint), 0.0001), 0.0, 1.0);
  let dotMean = 3.141592653589793 * radius * radius;
  return mix(dots, dotMean, smoothstep(0.35, 1.0, max(footprint.x, footprint.y)));
}
`;

/** WGSL twin of PATTERN_GLSL (ter_ink must be defined before; include once). */
export const PATTERN_WGSL = /* wgsl */ `${PATTERN_KERNEL_WGSL}fn ter_pattern_cover(c: i32, p: vec2<f32>, col: vec3<f32>, fw: vec2<f32>, lit: f32) -> vec3<f32> {
  let shade = 1.0 - smoothstep(-0.05, 0.45, lit);
  var cov = 0.0;
  if (c == 4) {
    cov = ter_pat_dots(p, fw, ${TERROIR_PATTERN_PARAMS.scree.spacing.toFixed(1)}, ${TERROIR_PATTERN_PARAMS.scree.width}, 0.0) * ${TERROIR_PATTERN_PARAMS.scree.strength};
  } else if (c == 3) {
    cov = ter_pat_hatch(p, fw, ${TERROIR_PATTERN_PARAMS.rock.spacing.toFixed(1)}, mix(${TERROIR_PATTERN_PARAMS.rock.widthLit}, ${TERROIR_PATTERN_PARAMS.rock.widthShade}, shade), ${TERROIR_PATTERN_PARAMS.rock.angle}) * ${TERROIR_PATTERN_PARAMS.rock.strength};
  } else if (c == 1) {
    cov = ter_pat_hatch(p, fw, ${TERROIR_PATTERN_PARAMS.glacier.spacing.toFixed(1)}, ${TERROIR_PATTERN_PARAMS.glacier.width}, ${TERROIR_PATTERN_PARAMS.glacier.angle}) * ${TERROIR_PATTERN_PARAMS.glacier.strength};
  }
  if (cov > 0.0) { return mix(col, ter_ink(c), cov); }
  return col;
}
`;
