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
