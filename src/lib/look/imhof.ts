// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Imhof relief (style.terrain.relief.mode "imhof"): the Swiss relief of look/glsl/relief.ts plus
//  1. multi-scale generalisation: four scale levels of the DEM normal (the fine surface normal, the
//     relief field's ~80 m generalised normal, and two coarser Gaussian-like averages of that field
//     at ~310 m and ~940 m), blended by on-screen range so landforms stay legible far away and
//     detail survives near (Imhof's "generalisation by distance"),
//  2. aspect-swung illumination: the light azimuth swings toward each slope's aspect within a limit,
//     so both sides of a N-S ridge read instead of one being flat black,
//  3. Imhof colour: warm yellowish lit slopes, cool blue-grey shade, an elevation tint (lowlands
//     greener-grey, high alpine lighter) and aerial lightening / desaturation with range.
// Display only: no pose, confidence or export reads this.
//
// One set of constants feeds the TS reference below (checks), the GLSL (look/glsl/relief.ts) and the
// WGSL (deck-webgpu/layers/terrain-styles.ts) text, so the engines agree by construction. The two
// shader texts are IMHOF_GLSL_MATH / IMHOF_WGSL_MATH, pure functions with no uniforms or textures
// (scripts/gpu/imhof-dawn.ts runs the WGSL on Dawn against the reference).

/** Scale centres as log10(range in m): ~500 m, 2 km, 7 km, 25 km. */
export const IMHOF_SCALE_CENTERS = [2.7, 3.3, 3.85, 4.4] as const;
/** Tap radii (texels of the 1024² relief field, ~39 m) of the two coarse levels, 8 taps each. */
export const IMHOF_TAP_RADII = [8, 24] as const;
export const IMHOF_FIELD_TEXEL = 1 / 1024;
/** Light: the swiss NW main light, and the largest azimuth swing (degrees) at swing = 1. */
export const IMHOF_LIGHT_AZIMUTH = 315;
export const IMHOF_LIGHT_ALTITUDE = 45;
export const IMHOF_SWING_MAX = 65;
/** How much of the swung single light replaces MDOW at swing = 1. */
export const IMHOF_SWING_BLEND = 0.7;
/** Linear tone multipliers: lit slopes warm yellow-white, shaded slopes cool blue-grey. */
export const IMHOF_LIT = [1.06, 1.0, 0.85] as const;
export const IMHOF_SHADE = [0.64, 0.7, 0.84] as const;
/** Albedo multipliers by elevation: lowland greener-grey (<= 700 m), high alpine lighter (>= 2800 m). */
export const IMHOF_TINT_LOW = [0.93, 1.0, 0.92] as const;
export const IMHOF_TINT_HIGH = [1.06, 1.05, 1.05] as const;
/** Aerial colour (linear) the distant relief moves toward, and the largest share at aerial = 1. */
export const IMHOF_AIR = [0.56, 0.63, 0.76] as const;
export const IMHOF_AIR_MAX = 0.35;
export const IMHOF_AIR_DESATURATE = 0.55;

type V3 = readonly [number, number, number];

const clamp = (x: number, lo: number, hi: number) =>
	Math.min(Math.max(x, lo), hi);
const smoothstep = (a: number, b: number, x: number) => {
	const t = clamp((x - a) / (b - a), 0, 1);
	return t * t * (3 - 2 * t);
};
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const mix3 = (a: V3, b: V3, t: number): [number, number, number] => [
	mix(a[0], b[0], t),
	mix(a[1], b[1], t),
	mix(a[2], b[2], t),
];

/**
 * Hat weights of the four scale levels at `range` metres (sum 1): all fine nearer than the first
 * centre, all coarsest beyond the last, a linear cross-fade in log10(range) between.
 */
export function imhofScaleWeights(
	range: number,
): [number, number, number, number] {
	const c = IMHOF_SCALE_CENTERS;
	const lg = Math.log10(Math.max(range, 1));
	const w: [number, number, number, number] = [0, 0, 0, 0];
	if (lg <= c[0]) w[0] = 1;
	else if (lg >= c[3]) w[3] = 1;
	else
		for (let i = 0; i < 3; i++)
			if (lg < c[i + 1]) {
				const t = (lg - c[i]) / (c[i + 1] - c[i]);
				w[i] = 1 - t;
				w[i + 1] = t;
				break;
			}
	return w;
}

/** The blended normal xy of the four levels (each a normal's xy), weights from imhofScaleWeights. */
export function imhofBlendNormalXy(
	xy: readonly (readonly [number, number])[],
	weights: readonly number[],
): [number, number] {
	let x = 0;
	let y = 0;
	for (let i = 0; i < 4; i++) {
		x += weights[i] * xy[i][0];
		y += weights[i] * xy[i][1];
	}
	return [x, y];
}

function lightDir(azDeg: number, altDeg: number): V3 {
	const az = (azDeg * Math.PI) / 180;
	const al = (altDeg * Math.PI) / 180;
	return [
		Math.cos(al) * Math.sin(az),
		Math.cos(al) * Math.cos(az),
		Math.sin(al),
	];
}

/**
 * Aspect-swung hillshade, 1 = lit flat ground. `n` is the (z-exaggerated, unit) normal, `mdow` the
 * swiss multidirectional shade of the same normal, `swing` 0..1 (0 returns `mdow`). The light azimuth
 * moves by IMHOF_SWING_MAX·swing·sin(aspect − main azimuth): zero for slopes facing the light and for
 * slopes facing straight away (still shaded, continuously), full toward the sides, which lights the
 * east and south faces of a ridge that the fixed NW light leaves black.
 */
export function imhofSwungLight(n: V3, mdow: number, swing: number): number {
	const slope = Math.hypot(n[0], n[1]);
	const aspect = Math.atan2(n[0], n[1]);
	const diff = aspect - (IMHOF_LIGHT_AZIMUTH * Math.PI) / 180;
	const az =
		IMHOF_LIGHT_AZIMUTH +
		IMHOF_SWING_MAX * swing * Math.sin(diff) * smoothstep(0.05, 0.4, slope);
	const l = lightDir(az, IMHOF_LIGHT_ALTITUDE);
	const s =
		Math.max(n[0] * l[0] + n[1] * l[1] + n[2] * l[2], 0) /
		Math.sin((IMHOF_LIGHT_ALTITUDE * Math.PI) / 180);
	return mix(mdow, s, swing * IMHOF_SWING_BLEND);
}

/** The cartographic colour (linear) of an albedo at shade `L` (the swiss `carto`, Imhof-toned). */
export function imhofColour(
	albedo: V3,
	L: number,
	elev: number,
	tint: number,
): [number, number, number] {
	const tone = mix3(IMHOF_SHADE, IMHOF_LIT, smoothstep(0.25, 1.0, L));
	const gain = (0.1 + 0.9 * Math.max(L, 0) ** 1.6) * 1.35;
	const elevTint = mix3(
		IMHOF_TINT_LOW,
		IMHOF_TINT_HIGH,
		smoothstep(700, 2800, elev),
	);
	return [
		albedo[0] * mix(1, elevTint[0], tint) * tone[0] * gain,
		albedo[1] * mix(1, elevTint[1], tint) * tone[1] * gain,
		albedo[2] * mix(1, elevTint[2], tint) * tone[2] * gain,
	];
}

/** Aerial perspective: lighten and desaturate toward IMHOF_AIR with range (valleys hazier). */
export function imhofAerial(
	col: V3,
	range: number,
	elev: number,
	aerial: number,
): [number, number, number] {
	const k =
		aerial *
		IMHOF_AIR_MAX *
		smoothstep(3000, 45000, range) *
		(0.6 + 0.4 * (1 - smoothstep(500, 3000, elev)));
	const lum = col[0] * 0.2126 + col[1] * 0.7152 + col[2] * 0.0722;
	const desat = mix3(col, [lum, lum, lum], IMHOF_AIR_DESATURATE);
	return mix3(col, mix3(desat, IMHOF_AIR, 0.5), k);
}

const fl = (x: number) => x.toExponential(9);
const list = (v: readonly number[]) => v.map(fl).join(", ");
const [W0, W1, W2, W3] = IMHOF_SCALE_CENTERS;

/** WGSL of the pure Imhof maths (names ts_imhof_*); needs ts_relief_light_dir. */
export const IMHOF_WGSL_MATH = /* wgsl */ `\
fn ts_imhof_scale_weights(range: f32) -> vec4<f32> {
  let lg = log(max(range, 1.0)) / log(10.0);
  var w = vec4<f32>(0.0);
  if (lg <= ${fl(W0)}) { w.x = 1.0; }
  else if (lg >= ${fl(W3)}) { w.w = 1.0; }
  else if (lg < ${fl(W1)}) { let t = (lg - ${fl(W0)}) / ${fl(W1 - W0)}; w.x = 1.0 - t; w.y = t; }
  else if (lg < ${fl(W2)}) { let t = (lg - ${fl(W1)}) / ${fl(W2 - W1)}; w.y = 1.0 - t; w.z = t; }
  else { let t = (lg - ${fl(W2)}) / ${fl(W3 - W2)}; w.z = 1.0 - t; w.w = t; }
  return w;
}
fn ts_imhof_swung_light(n: vec3<f32>, mdow: f32, swing: f32) -> f32 {
  let slope = length(n.xy);
  let aspect = atan2(n.x, n.y);
  let diff = aspect - radians(${fl(IMHOF_LIGHT_AZIMUTH)});
  let az = ${fl(IMHOF_LIGHT_AZIMUTH)} + ${fl(IMHOF_SWING_MAX)} * swing * sin(diff) * smoothstep(0.05, 0.4, slope);
  let l = ts_relief_light_dir(az, ${fl(IMHOF_LIGHT_ALTITUDE)});
  let s = max(dot(n, l), 0.0) / sin(radians(${fl(IMHOF_LIGHT_ALTITUDE)}));
  return mix(mdow, s, swing * ${fl(IMHOF_SWING_BLEND)});
}
fn ts_imhof_colour(albedo: vec3<f32>, L: f32, elev: f32, tint: f32) -> vec3<f32> {
  let tone = mix(vec3<f32>(${list(IMHOF_SHADE)}), vec3<f32>(${list(IMHOF_LIT)}), smoothstep(0.25, 1.0, L));
  let gain = (0.1 + 0.9 * pow(max(L, 0.0), 1.6)) * 1.35;
  let elevTint = mix(vec3<f32>(${list(IMHOF_TINT_LOW)}), vec3<f32>(${list(IMHOF_TINT_HIGH)}), smoothstep(700.0, 2800.0, elev));
  return albedo * mix(vec3<f32>(1.0), elevTint, tint) * tone * gain;
}
fn ts_imhof_aerial(col: vec3<f32>, range: f32, elev: f32, aerial: f32) -> vec3<f32> {
  let k = aerial * ${fl(IMHOF_AIR_MAX)} * smoothstep(3000.0, 45000.0, range) * (0.6 + 0.4 * (1.0 - smoothstep(500.0, 3000.0, elev)));
  let lum = dot(col, vec3<f32>(0.2126, 0.7152, 0.0722));
  let desat = mix(col, vec3<f32>(lum), ${fl(IMHOF_AIR_DESATURATE)});
  return mix(col, mix(desat, vec3<f32>(${list(IMHOF_AIR)}), 0.5), k);
}
`;

/** GLSL twin of IMHOF_WGSL_MATH (names imhof*); needs reliefLightDir. */
export const IMHOF_GLSL_MATH = /* glsl */ `
vec4 imhofScaleWeights(float range) {
  float lg = log(max(range, 1.0)) / log(10.0);
  vec4 w = vec4(0.0);
  if (lg <= ${fl(W0)}) { w.x = 1.0; }
  else if (lg >= ${fl(W3)}) { w.w = 1.0; }
  else if (lg < ${fl(W1)}) { float t = (lg - ${fl(W0)}) / ${fl(W1 - W0)}; w.x = 1.0 - t; w.y = t; }
  else if (lg < ${fl(W2)}) { float t = (lg - ${fl(W1)}) / ${fl(W2 - W1)}; w.y = 1.0 - t; w.z = t; }
  else { float t = (lg - ${fl(W2)}) / ${fl(W3 - W2)}; w.z = 1.0 - t; w.w = t; }
  return w;
}
float imhofSwungLight(vec3 n, float mdow, float swing) {
  float slope = length(n.xy);
  float aspect = atan(n.x, n.y);
  float diff = aspect - radians(${fl(IMHOF_LIGHT_AZIMUTH)});
  float az = ${fl(IMHOF_LIGHT_AZIMUTH)} + ${fl(IMHOF_SWING_MAX)} * swing * sin(diff) * smoothstep(0.05, 0.4, slope);
  vec3 l = reliefLightDir(az, ${fl(IMHOF_LIGHT_ALTITUDE)});
  float s = max(dot(n, l), 0.0) / sin(radians(${fl(IMHOF_LIGHT_ALTITUDE)}));
  return mix(mdow, s, swing * ${fl(IMHOF_SWING_BLEND)});
}
vec3 imhofColour(vec3 albedo, float L, float elev, float tint) {
  vec3 tone = mix(vec3(${list(IMHOF_SHADE)}), vec3(${list(IMHOF_LIT)}), smoothstep(0.25, 1.0, L));
  float gain = (0.1 + 0.9 * pow(max(L, 0.0), 1.6)) * 1.35;
  vec3 elevTint = mix(vec3(${list(IMHOF_TINT_LOW)}), vec3(${list(IMHOF_TINT_HIGH)}), smoothstep(700.0, 2800.0, elev));
  return albedo * mix(vec3(1.0), elevTint, tint) * tone * gain;
}
vec3 imhofAerial(vec3 col, float range, float elev, float aerial) {
  float k = aerial * ${fl(IMHOF_AIR_MAX)} * smoothstep(3000.0, 45000.0, range) * (0.6 + 0.4 * (1.0 - smoothstep(500.0, 3000.0, elev)));
  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  vec3 desat = mix(col, vec3(lum), ${fl(IMHOF_AIR_DESATURATE)});
  return mix(col, mix(desat, vec3(${list(IMHOF_AIR)}), 0.5), k);
}
`;
