// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) vis.gl contributors
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Precipitation (rain / snow) for the deck world view and the landing scenes, never the photo overlay.
// A standalone port of luma.gl #3325's `precipitation` shadertools module (MIT, vis.gl contributors):
// stateless, seeded falling particles in a movable volume, local metres (here: ENU, z up). Two changes
// from luma: the volume is a world-anchored lattice (each particle takes the periodic image nearest
// the camera, so the camera moving does not drag the flakes along), and the fall drift is reduced
// modulo the volume on the CPU in doubles (the shader never sees a large `time`).
// The GLSL and the CPU twin below share one hash, so a unit test pins the shader's positions.
import type { ViewStyle } from "../../style/types";

export type WeatherKind = "rain" | "snow";

export type Precipitation = {
	kind: WeatherKind;
	/** Particles drawn (instances), at the style's intensity. */
	count: number;
	/** Fall speed, m/s (positive = down). */
	fallSpeed: number;
	/** Horizontal wind, m/s, ENU (x east, y north). */
	wind: [number, number];
	/** Sideways wobble amplitude, m. */
	turbulence: number;
	/** Cube edge of the particle volume around the camera, m (z edge is 0.6 of it). */
	volumeM: number;
	/** Flake radius (snow) or streak half-width basis (rain), m. */
	sizeM: number;
	/** Rain streak length, m (0 for snow). */
	streakM: number;
	/** Linear-ish sRGB colour and peak alpha. */
	color: [number, number, number, number];
};

const RAIN_MAX = 9000;
const SNOW_MAX = 7000;

/** style.world.weather → draw parameters; null when off (the layer is not even built). */
export function precipitationFor(
	w: ViewStyle["world"]["weather"],
): Precipitation | null {
	if (!w || w.mode === "off") return null;
	const wind: [number, number] = [w.wind, w.wind * 0.35];
	if (w.mode === "rain")
		return {
			kind: "rain",
			count: Math.round(RAIN_MAX * w.intensity),
			fallSpeed: 9,
			wind,
			turbulence: 0,
			volumeM: 400,
			sizeM: 0.03,
			streakM: 1.8,
			color: [0.78, 0.84, 0.95, 0.42],
		};
	return {
		kind: "snow",
		count: Math.round(SNOW_MAX * w.intensity),
		fallSpeed: 1.4,
		wind,
		turbulence: 0.6,
		volumeM: 300,
		sizeM: 0.045,
		streakM: 0,
		color: [1, 1, 1, 0.9],
	};
}

/** Seed shared by the GLSL and the CPU twin. */
export const PRECIPITATION_SEED = 29;

/** The cell offset (m) the lattice has drifted by after `t` seconds, reduced modulo the volume. */
export function precipitationDrift(
	p: Pick<Precipitation, "fallSpeed" | "wind" | "volumeM">,
	t: number,
): [number, number, number] {
	const sx = p.volumeM;
	const sz = p.volumeM * 0.6;
	const m = (v: number, s: number) => v - Math.floor(v / s) * s;
	return [m(p.wind[0] * t, sx), m(p.wind[1] * t, sx), m(-p.fallSpeed * t, sz)];
}

/** GLSL: the hash and position of one particle (luma's precipitation_random / _getPosition). */
export const PRECIPITATION_GLSL = /* glsl */ `
float precipitation_random(uint identifier, float seed) {
  uint value = identifier + uint(seed) * 747796405u;
  value = (value ^ (value >> 16u)) * 2246822519u;
  value = (value ^ (value >> 13u)) * 3266489917u;
  value = value ^ (value >> 16u);
  return float(value & 16777215u) / 16777216.0;
}
// the particle's position (ENU m): the lattice image nearest \`center\`, drifted by \`drift\` (already
// reduced modulo \`size\` on the CPU), plus the sideways wobble
vec3 precipitation_getPosition(uint identifier, vec3 center, vec3 size, vec3 drift, float turbulence, float time, float seed) {
  vec3 r = vec3(precipitation_random(identifier * 3u, seed), precipitation_random(identifier * 3u + 1u, seed), precipitation_random(identifier * 3u + 2u, seed));
  vec3 u = r * size + drift;
  vec3 q = u - floor(u / size) * size;
  vec3 p = q + size * floor((center - q) / size + 0.5);
  p.xy += turbulence * vec2(sin(time * 0.9 + r.z * 31.0), cos(time * 0.7 + r.x * 23.0));
  return p;
}
// 1 inside the volume, 0 at its faces (luma's precipitation_getFade)
float precipitation_getFade(vec3 position, vec3 center, vec3 size) {
  vec3 edge = 0.5 - abs((position - center) / size);
  return smoothstep(0.0, 0.08, min(edge.x, min(edge.y, edge.z)));
}
`;

/** The GLSL hash, on the CPU (uint32 arithmetic). */
export function precipitationRandom(identifier: number, seed: number): number {
	let v = (identifier + Math.imul(seed >>> 0, 747796405)) >>> 0;
	v = Math.imul(v ^ (v >>> 16), 2246822519) >>> 0;
	v = Math.imul(v ^ (v >>> 13), 3266489917) >>> 0;
	v = (v ^ (v >>> 16)) >>> 0;
	return (v & 16777215) / 16777216;
}

/** The GLSL precipitation_getPosition, on the CPU (no turbulence). */
export function precipitationPosition(
	id: number,
	center: [number, number, number],
	size: [number, number, number],
	drift: [number, number, number],
	seed = PRECIPITATION_SEED,
): [number, number, number] {
	const out: [number, number, number] = [0, 0, 0];
	for (let k = 0; k < 3; k++) {
		const u = precipitationRandom(id * 3 + k, seed) * size[k] + drift[k];
		const q = u - Math.floor(u / size[k]) * size[k];
		out[k] = q + size[k] * Math.floor((center[k] - q) / size[k] + 0.5);
	}
	return out;
}

/** The uniforms of luma's `precipitation` module that reproduce Rigi's lattice (`time` is 1). */
export type LumaPrecipitationUniforms = {
	time: number;
	fallSpeed: number;
	turbulence: number;
	seed: number;
	volumeCenter: [number, number, number];
	volumeSize: [number, number, number];
	wind: [number, number];
};

/**
 * luma's `precipitation_getPosition` is `mod(r * size + (wind, -fallSpeed) * time - min, size) + min`
 * with `min = center - size / 2`, which equals Rigi's "lattice image nearest the centre" of
 * `r * size + drift`. Feeding `time = 1`, the CPU-reduced drift as wind / fall speed and turbulence 0
 * therefore gives the same positions (the WebGPU layer adds the wobble itself, with the real time).
 */
export function lumaUniformsFor(
	p: Pick<Precipitation, "fallSpeed" | "wind" | "volumeM">,
	center: [number, number, number],
	t: number,
): LumaPrecipitationUniforms {
	const drift = precipitationDrift(p, t);
	const v = p.volumeM;
	return {
		time: 1,
		fallSpeed: -drift[2],
		turbulence: 0,
		seed: PRECIPITATION_SEED,
		volumeCenter: center,
		volumeSize: [v, v, v * 0.6],
		wind: [drift[0], drift[1]],
	};
}

/** luma's `precipitation_getPosition` (the WGSL `source` formula), on the CPU, without turbulence. */
export function lumaPrecipitationPosition(
	id: number,
	u: LumaPrecipitationUniforms,
): [number, number, number] {
	const drift = [u.wind[0] * u.time, u.wind[1] * u.time, -u.fallSpeed * u.time];
	const out: [number, number, number] = [0, 0, 0];
	for (let k = 0; k < 3; k++) {
		const size = Math.max(u.volumeSize[k], 0.001);
		const minimum = u.volumeCenter[k] - size * 0.5;
		const r = precipitationRandom(id * 3 + k, u.seed);
		const unwrapped = r * size + drift[k] - minimum;
		out[k] = unwrapped - Math.floor(unwrapped / size) * size + minimum;
	}
	return out;
}
