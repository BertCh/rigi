// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { wrap360 } from "#/lib/geodesy";
// Synthetic live sequences for the tracker's evidence: a ridge-line horizon profile (or a real one),
// a camera trajectory, sensor readings with noise, bias and drift, and rendered RGBA frames with a
// sky gradient, clouds, hazy ground, screen-fixed occluders and pixel noise. Pure CPU and
// deterministic per seed. Projection uses camera/index poseBasis (independent of the
// refine/model.ts evalColumn the solver uses), so a tracker that recovers the pose also proves the
// two conventions agree.
import { type Pose, poseBasis } from "../camera";
import type { HorizonProfile } from "../geo/horizon";
import type { SensorSample } from "../live/contract";
import { DEG } from "../refine/model";
import type { RgbaImage } from "./skyline-cpu";

/** mulberry32. */
export function rng(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Standard normal from a uniform generator. */
export const gaussian = (rand: () => number) =>
	Math.sqrt(-2 * Math.log(Math.max(1e-12, rand()))) *
	Math.cos(2 * Math.PI * rand());

/**
 * A ridge-line horizon: a sum of harmonics plus sharp peaks, elevations about -1..10 degrees,
 * distances 2-40 km. Distinct enough around the circle that yaw is observable everywhere.
 */
export function makeRidgeProfile(seed = 1, step = 0.1): HorizonProfile {
	const rand = rng(seed);
	const n = Math.round(360 / step);
	const harmonics = Array.from({ length: 24 }, (_, k) => ({
		k: k + 1,
		amp: 3.2 / (k + 1) ** 0.9,
		phase: rand() * 2 * Math.PI,
	}));
	const peaks = Array.from({ length: 40 }, () => ({
		az: rand() * 360,
		height: 0.5 + rand() * 4,
		width: 0.5 + rand() * 2.5,
	}));
	const elevation = new Float32Array(n);
	const distance = new Float32Array(n);
	for (let i = 0; i < n; i++) {
		const az = i * step;
		let e = 3;
		for (const h of harmonics) e += h.amp * Math.sin(h.k * az * DEG + h.phase);
		let near = 0;
		for (const p of peaks) {
			const d = ((((az - p.az) % 360) + 540) % 360) - 180;
			const v = p.height * Math.exp(-((d / p.width) ** 2));
			e += v;
			near += v;
		}
		elevation[i] = e;
		distance[i] = 2000 + 38000 / (1 + near * 1.5) + 4000 * Math.sin(az * 0.07);
	}
	return {
		step,
		elevation,
		distance,
		ridges: Array.from({ length: n }, () => []),
	};
}

/** Horizon elevation (deg) at azimuth, linear interpolation. */
export function horizonAt(h: HorizonProfile, azDeg: number): number {
	const n = h.elevation.length;
	const u = wrap360(azDeg) / h.step;
	const i = Math.floor(u) % n;
	const f = u - Math.floor(u);
	return h.elevation[i] * (1 - f) + h.elevation[(i + 1) % n] * f;
}

export interface TrajectoryOptions {
	yawCentre?: number;
	/** Pan amplitude, degrees, and period, seconds. */
	panDeg?: number;
	panPeriod?: number;
	pitchCentre?: number;
	vfov?: number;
	/** Hand shake σ, degrees (smooth, per axis). */
	shakeDeg?: number;
	seed?: number;
}

/** A handheld-like pan: slow sweep, slower tilt, small shake. Deterministic in t (seconds). */
export function makeTrajectory(o: TrajectoryOptions = {}): (t: number) => Pose {
	const rand = rng(o.seed ?? 7);
	const ph = Array.from({ length: 9 }, () => rand() * 2 * Math.PI);
	const shake = o.shakeDeg ?? 0.3;
	return (t) => ({
		yaw:
			((((o.yawCentre ?? 120) +
				(o.panDeg ?? 25) *
					Math.sin((2 * Math.PI * t) / (o.panPeriod ?? 20) + ph[0]) +
				4 * Math.sin(0.9 * t + ph[1]) +
				shake * Math.sin(5.1 * t + ph[2])) %
				360) +
				360) %
			360,
		pitch:
			(o.pitchCentre ?? 4) +
			3 * Math.sin((2 * Math.PI * t) / 9 + ph[3]) +
			shake * Math.sin(6.3 * t + ph[4]),
		roll:
			1.5 * Math.sin((2 * Math.PI * t) / 13 + ph[5]) +
			shake * Math.sin(4.7 * t + ph[6]),
		vfov: o.vfov ?? 50,
	});
}

export interface SensorModel {
	/** Initial yaw bias, degrees (compass error) and its random walk, deg per sqrt(s). */
	yawBias?: number;
	yawWalk?: number;
	pitchBias?: number;
	rollBias?: number;
	pitchRollWalk?: number;
	/** White noise σ, degrees. */
	noise?: number;
	/** Report yaw as null (relative-only sensor). */
	noCompass?: boolean;
	/** [startSeconds, endSeconds, deltaDegrees] sudden compass offsets (magnetic interference). */
	yawJumps?: [number, number, number][];
	seed?: number;
}

/** Sensor readings for a truth trajectory: stateful (random-walk bias), call in time order. */
export function makeSensor(o: SensorModel = {}) {
	const rand = rng(o.seed ?? 11);
	let yawBias = o.yawBias ?? 10;
	let pitchBias = o.pitchBias ?? 0.6;
	let rollBias = o.rollBias ?? -0.4;
	let lastT = 0;
	return (truth: Pose, t: number): SensorSample => {
		const dt = Math.max(0, t - lastT);
		lastT = t;
		const root = Math.sqrt(dt);
		yawBias += (o.yawWalk ?? 0.3) * root * gaussian(rand);
		const pr = (o.pitchRollWalk ?? 0.05) * root;
		pitchBias += pr * gaussian(rand);
		rollBias += pr * gaussian(rand);
		let jump = 0;
		for (const [a, b, d] of o.yawJumps ?? []) if (t >= a && t < b) jump += d;
		const noise = o.noise ?? 0.15;
		return {
			time: t * 1000,
			yaw: o.noCompass
				? null
				: (((truth.yaw + yawBias + jump + noise * gaussian(rand)) % 360) +
						360) %
					360,
			pitch: truth.pitch + pitchBias + noise * gaussian(rand),
			roll: truth.roll + rollBias + noise * gaussian(rand),
		};
	};
}

export interface FrameStyle {
	/** Pixel noise σ in 0..1. */
	noise?: number;
	clouds?: boolean;
	/** Screen-fixed foreground bars (branches, a finger) rising above the skyline. */
	occluders?: boolean;
	/** The whole frame is a flat dark colour (lens covered). */
	blackout?: boolean;
	haze?: boolean;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const hash2 = (x: number, y: number) => {
	let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263);
	h = Math.imul(h ^ (h >>> 13), 1274126177);
	return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

/** Render one RGBA frame of `pose` over `profile`. `time` (s) drifts the clouds. */
export function renderFrame(
	profile: HorizonProfile,
	pose: Pose,
	width: number,
	height: number,
	style: FrameStyle,
	rand: () => number,
	time = 0,
): RgbaImage {
	const data = new Uint8ClampedArray(width * height * 4);
	const noise = style.noise ?? 0.02;
	if (style.blackout) {
		for (let i = 0; i < width * height; i++) {
			const v = 12 + 20 * noise * gaussian(rand);
			data[i * 4] = v;
			data[i * 4 + 1] = v;
			data[i * 4 + 2] = v;
			data[i * 4 + 3] = 255;
		}
		return { width, height, data };
	}
	const { forward, right, up } = poseBasis(pose);
	const f = height / 2 / Math.tan((pose.vfov * DEG) / 2);
	const n = profile.elevation.length;
	// per-column occluder heights (screen fixed, so they stay put while the world pans)
	const occluder = new Float32Array(width);
	if (style.occluders) {
		const orand = rng(99);
		for (let x = 0; x < width; ) {
			const span = 2 + Math.floor(orand() * 5);
			const h = orand() < 0.1 ? 0.15 + orand() * 0.15 : 0;
			for (let i = 0; i < span && x < width; i++, x++) occluder[x] = h * height;
			x += Math.floor(orand() * 30);
		}
	}
	for (let py = 0; py < height; py++) {
		const Y = (py + 0.5 - height / 2) / f;
		for (let px = 0; px < width; px++) {
			const X = (px + 0.5 - width / 2) / f;
			const de = forward[0] + X * right[0] - Y * up[0];
			const dn = forward[1] + X * right[1] - Y * up[1];
			const dz = forward[2] + X * right[2] - Y * up[2];
			const az = wrap360(Math.atan2(de, dn) / DEG);
			const el = Math.asin(dz / Math.hypot(de, dn, dz)) / DEG;
			const u = az / profile.step;
			const i0 = Math.floor(u) % n;
			const fr = u - Math.floor(u);
			const H =
				profile.elevation[i0] * (1 - fr) + profile.elevation[(i0 + 1) % n] * fr;
			let r: number;
			let g: number;
			let b: number;
			const screenBottom = height - py;
			const occluded =
				occluder[px] > 0 && screenBottom < occluder[px] + 0.25 * height;
			if (occluded) {
				r = 0.08;
				g = 0.12;
				b = 0.06;
			} else if (el < H) {
				// ground; far ridges hazier
				const d = profile.distance[i0];
				const hz = style.haze === false ? 0 : Math.min(0.55, d / 70000);
				const tex = 0.7 + 0.3 * hash2(Math.floor(az * 40), Math.floor(el * 40));
				r = lerp(0.22 * tex, 0.62, hz);
				g = lerp(0.26 * tex, 0.7, hz);
				b = lerp(0.2 * tex, 0.82, hz);
			} else {
				const above = Math.min(1, (el - H) / 40);
				r = lerp(0.72, 0.28, above);
				g = lerp(0.82, 0.5, above);
				b = lerp(0.95, 0.9, above);
				if (style.clouds !== false) {
					// angular cloud field drifting with time
					const c =
						Math.sin(az * 0.21 + time * 0.05) *
						Math.sin(el * 0.33 + 1.3 + Math.cos(az * 0.11) * 2);
					const m = Math.max(0, Math.min(1, (c - 0.15) * 3));
					r = lerp(r, 0.97, m);
					g = lerp(g, 0.97, m);
					b = lerp(b, 0.98, m);
				}
			}
			const o = (py * width + px) * 4;
			data[o] = (r + noise * gaussian(rand)) * 255;
			data[o + 1] = (g + noise * gaussian(rand)) * 255;
			data[o + 2] = (b + noise * gaussian(rand)) * 255;
			data[o + 3] = 255;
		}
	}
	return { width, height, data };
}

/** Smallest rotation angle (degrees) between two poses' camera bases. */
export function rotationErrorDeg(a: Pose, b: Pose): number {
	const A = poseBasis(a);
	const B = poseBasis(b);
	const dot = (u: number[], v: number[]) =>
		u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
	// trace of A^T B = sum of axis dot products; angle = acos((trace - 1) / 2)
	const trace =
		dot(A.forward, B.forward) + dot(A.right, B.right) + dot(A.up, B.up);
	return Math.acos(Math.max(-1, Math.min(1, (trace - 1) / 2))) / DEG;
}
