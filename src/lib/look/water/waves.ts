// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) vis.gl contributors
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Animated lake waves (style.world.water 'waves', define LOOK_WATER_WAVES): the wave normal of luma's
// riverWaterMaterial (@luma.gl/shadertools, #3311; river-water-shaders.ts, MIT, Copyright (c) vis.gl
// contributors) ported to the terrain programs of both engines: six advected, noise-modulated
// cosine packets, summed to a tilt that water.ts adds to the lake normal. Differences from the
// material: it is a function of the ENU position (the terrain has no uv), the flow direction is
// fixed to +y, and the per-pixel fwidth attenuation is replaced by the pixel footprint estimated
// from the range (WGSL derivatives must sit in uniform control flow, the lake test does not).
// One wave table feeds the GLSL and the WGSL. Display only: the photo overlay never gets the define.
import type { ViewStyle } from "../../style/types";
import { defineBlock } from "../glsl/block";

/** direction x (y is 1, normalised), frequency, amplitude, speed, phase offset: river-water-shaders.ts. */
export const WAVE_TABLE = [
	[0.08, 2.1, 0.018, 1.25, 0.0],
	[-0.28, 3.7, 0.018, 0.95, 1.7],
	[0.47, 5.3, 0.012, 1.7, 3.2],
	[-0.68, 7.9, 0.008, 0.76, 0.8],
	[0.92, 11.6, 0.004, 2.2, 2.1],
	[-1.22, 16.3, 0.002, 1.45, 2.8],
] as const;

/** Wave-space units per metre: the longest packet is 2π / (2.1 · 0.12) ≈ 25 m, the shortest ≈ 3 m. */
export const WAVE_SCALE = 0.12;
/** The material's normalStrength · 3.2, halved: lakes are calmer than a river. */
export const WAVE_TILT = 2.4;
/** Rough angle of one pixel (rad): range · this = the footprint that fades packets finer than it. */
export const WAVE_PIXEL = 0.0004;
/** Time the harnesses see (s): waves are present but still. */
export const WAVE_STILL_TIME = 12.5;
/** Playback speed relative to the river material. */
export const WAVE_SPEED = 0.6;

/** The uniform: seconds on the wave clock (waterWaveSeconds). */
export const WATER_WAVES_BLOCK = defineBlock("wtr", "waterWaves", {
	time: "float",
});

const fl = (x: number) => (Number.isInteger(x) ? x.toFixed(1) : String(x));

/** Waves on: the alpine lake shading is on and the style asks for waves (world view only). */
export const waterWavesOn = (s: ViewStyle) =>
	s.world.water === "waves" &&
	s.terrain.albedo.mode === "alpine" &&
	s.terrain.albedo.water;

/** navigator.webdriver, as the reveal and weather animations read it. */
export const isWebdriver = () =>
	typeof navigator !== "undefined" &&
	!!(navigator as Navigator & { webdriver?: boolean }).webdriver;

/** Whether the world view keeps redrawing for the waves (never under webdriver). */
export const waterWavesAnimate = (s: ViewStyle) =>
	waterWavesOn(s) && !isWebdriver();

const clockStart =
	typeof performance !== "undefined" ? performance.now() : Date.now();

/** The wave clock (s): a fixed frame under webdriver, else seconds since load. */
export function waterWaveSeconds(): number {
	if (isWebdriver()) return WAVE_STILL_TIME;
	const now =
		typeof performance !== "undefined" ? performance.now() : Date.now();
	return ((now - clockStart) / 1000) * WAVE_SPEED;
}

/** Pure JS twin of the shader's hash noise (the unit check's reference). */
export function waveNoise(x: number, y: number): number {
	const cx = Math.floor(x);
	const cy = Math.floor(y);
	const fx = x - cx;
	const fy = y - cy;
	const bx = fx * fx * (3 - 2 * fx);
	const by = fy * fy * (3 - 2 * fy);
	const h = (ix: number, iy: number) => {
		const s = Math.sin(ix * 127.1 + iy * 311.7) * 43758.5453;
		return s - Math.floor(s);
	};
	const a = h(cx, cy);
	const b = h(cx + 1, cy);
	const c = h(cx, cy + 1);
	const d = h(cx + 1, cy + 1);
	return (a + (b - a) * bx) * (1 - by) + (c + (d - c) * bx) * by;
}

const smooth = (a: number, b: number, x: number) => {
	const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
	return t * t * (3 - 2 * t);
};

/** JS reference of waterWaveTilt (GLSL / WGSL): ENU metres, wave seconds, range m -> tilt xy. */
export function waterWaveTilt(
	x: number,
	y: number,
	t: number,
	range: number,
): [number, number] {
	let cx = x * WAVE_SCALE;
	let cy = y * WAVE_SCALE;
	const pix = range * WAVE_PIXEL * WAVE_SCALE;
	const dx = cx * 0.7;
	const dy = cy * 0.7 + t * 0.22;
	cx += (waveNoise(dx, dy) - 0.5) * 0.65;
	cy += (waveNoise(dx + 17.2, dy + 9.4) - 0.5) * 0.65;
	let gx = 0;
	let gy = 0;
	for (const [dirX, freq, amp, speed, ph] of WAVE_TABLE) {
		const n = Math.hypot(dirX, 1);
		const ux = dirX / n;
		const uy = 1 / n;
		const mx = cx + ux * ((t * speed) / freq);
		const my = cy + uy * ((t * speed) / freq);
		const vx = (mx * -uy + my * ux) * freq * 0.38 + ph * 3.7;
		const vy = (mx * ux + my * uy) * freq * 0.16 + ph * 3.7;
		const variation = waveNoise(vx, vy);
		const detail = waveNoise(vx * 2.13 + 11.3, vy * 2.13 + 7.9);
		const envelope = smooth(
			0.12,
			0.88,
			waveNoise(vx * 0.71 + 23.6, vy * 0.71 + 5.2),
		);
		const phase =
			(mx * ux + my * uy) * freq +
			ph +
			(variation - 0.5) * 7 +
			(detail - 0.5) * 2.5;
		const atten = 1 - smooth(0.8, 3, freq * pix);
		const k = Math.cos(phase) * freq * amp * atten * (0.15 + envelope * 1.2);
		gx += ux * k;
		gy += uy * k;
	}
	return [gx * WAVE_TILT, gy * WAVE_TILT];
}

const HASH_COMMON = "127.1, 311.7";

/** GLSL: waterWaveTilt(xy, t, range); needs WATER_WAVES_BLOCK (declared by its luma module). */
export const WATER_WAVES_FNS = /* glsl */ `
float wvNoise(vec2 c) {
  vec2 cell = floor(c);
  vec2 fr = fract(c);
  vec2 b = fr * fr * (vec2(3.0) - 2.0 * fr);
  vec2 H = vec2(${HASH_COMMON});
  vec4 k = vec4(dot(cell, H), dot(cell + vec2(1.0, 0.0), H), dot(cell + vec2(0.0, 1.0), H), dot(cell + vec2(1.0, 1.0), H));
  vec4 v = fract(sin(k) * 43758.5453);
  return mix(mix(v.x, v.y, b.x), mix(v.z, v.w, b.x), b.y);
}
vec2 wvPacket(vec2 c, vec2 dir, float freq, float amp, float speed, float ph, float t, float pix) {
  vec2 mc = c + dir * (t * speed / freq);
  vec2 cr = vec2(-dir.y, dir.x);
  vec2 vc = vec2(dot(mc, cr), dot(mc, dir)) * freq * vec2(0.38, 0.16) + vec2(ph * 3.7);
  float variation = wvNoise(vc);
  float detail = wvNoise(vc * 2.13 + vec2(11.3, 7.9));
  float envelope = smoothstep(0.12, 0.88, wvNoise(vc * 0.71 + vec2(23.6, 5.2)));
  float phase = dot(mc, dir) * freq + ph + (variation - 0.5) * 7.0 + (detail - 0.5) * 2.5;
  float atten = 1.0 - smoothstep(0.8, 3.0, freq * pix);
  return dir * (cos(phase) * freq * amp * atten * (0.15 + envelope * 1.2));
}
vec2 waterWaveTilt(vec2 xy, float t, float range) {
  vec2 c = xy * ${fl(WAVE_SCALE)};
  float pix = range * ${fl(WAVE_PIXEL)} * ${fl(WAVE_SCALE)};
  vec2 drift = c * 0.7 + vec2(0.0, t * 0.22);
  c += (vec2(wvNoise(drift), wvNoise(drift + vec2(17.2, 9.4))) - 0.5) * 0.65;
  vec2 g = vec2(0.0);
${WAVE_TABLE.map(
	([dx, freq, amp, speed, ph]) =>
		`  g += wvPacket(c, normalize(vec2(${fl(dx)}, 1.0)), ${fl(freq)}, ${fl(amp)}, ${fl(speed)}, ${fl(ph)}, t, pix);`,
).join("\n")}
  return g * ${fl(WAVE_TILT)};
}
`;

/** WGSL twin; `ts_water_wave_tilt(xy, t, range)`. Has no uniform of its own (the caller passes t). */
export const WATER_WAVES_WGSL = /* wgsl */ `
fn ts_wv_noise(c: vec2<f32>) -> f32 {
  let cell = floor(c);
  let fr = fract(c);
  let b = fr * fr * (vec2<f32>(3.0) - 2.0 * fr);
  let H = vec2<f32>(${HASH_COMMON});
  let k = vec4<f32>(dot(cell, H), dot(cell + vec2<f32>(1.0, 0.0), H), dot(cell + vec2<f32>(0.0, 1.0), H), dot(cell + vec2<f32>(1.0, 1.0), H));
  let v = fract(sin(k) * 43758.5453);
  return mix(mix(v.x, v.y, b.x), mix(v.z, v.w, b.x), b.y);
}
fn ts_wv_packet(c: vec2<f32>, dir: vec2<f32>, freq: f32, amp: f32, speed: f32, ph: f32, t: f32, pix: f32) -> vec2<f32> {
  let mc = c + dir * (t * speed / freq);
  let cr = vec2<f32>(-dir.y, dir.x);
  let vc = vec2<f32>(dot(mc, cr), dot(mc, dir)) * freq * vec2<f32>(0.38, 0.16) + vec2<f32>(ph * 3.7);
  let variation = ts_wv_noise(vc);
  let detail = ts_wv_noise(vc * 2.13 + vec2<f32>(11.3, 7.9));
  let envelope = smoothstep(0.12, 0.88, ts_wv_noise(vc * 0.71 + vec2<f32>(23.6, 5.2)));
  let phase = dot(mc, dir) * freq + ph + (variation - 0.5) * 7.0 + (detail - 0.5) * 2.5;
  let atten = 1.0 - smoothstep(0.8, 3.0, freq * pix);
  return dir * (cos(phase) * freq * amp * atten * (0.15 + envelope * 1.2));
}
fn ts_water_wave_tilt(xy: vec2<f32>, t: f32, range: f32) -> vec2<f32> {
  var c = xy * ${fl(WAVE_SCALE)};
  let pix = range * ${fl(WAVE_PIXEL)} * ${fl(WAVE_SCALE)};
  let drift = c * 0.7 + vec2<f32>(0.0, t * 0.22);
  c += (vec2<f32>(ts_wv_noise(drift), ts_wv_noise(drift + vec2<f32>(17.2, 9.4))) - 0.5) * 0.65;
  var g = vec2<f32>(0.0);
${WAVE_TABLE.map(
	([dx, freq, amp, speed, ph]) =>
		`  g += ts_wv_packet(c, normalize(vec2<f32>(${fl(dx)}, 1.0)), ${fl(freq)}, ${fl(amp)}, ${fl(speed)}, ${fl(ph)}, t, pix);`,
).join("\n")}
  return g * ${fl(WAVE_TILT)};
}
`;
