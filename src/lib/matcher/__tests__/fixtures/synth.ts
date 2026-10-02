// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors
/**
 * Deterministic synthetic matcher scenarios (TypeScript twin of synth.py).
 *
 * Purpose: the same skyline edge maps, horizon directions, correspondences and xyz view the Python
 * reference sees, from a params object, with an integer-exact PRNG (mulberry32). synth.spec.ts
 * compares this output against the checksums that make_fixtures.py stored in fusion.json.
 * Keep the operation order identical to synth.py. To regenerate the fixtures (from the repo root):
 *   /Users/robertchristie/Documents/GitHub/mt-image/tools/matcher/.venv/bin/python src/lib/matcher/__tests__/fixtures/make_fixtures.py
 */

export interface SynthPose {
	yaw: number;
	pitch: number;
	roll: number;
	vfov: number;
}

export interface SynthParams {
	name: string;
	seed: number;
	W: number;
	H: number;
	w: number;
	h: number;
	truePose: SynthPose;
	appPose: SynthPose;
	nCorr: number;
	outlierFrac: number;
	noisePx: number;
	/** [x0, y0, x1, y1] in edge-map px (x1, y1 exclusive) or null. */
	fgBlock: [number, number, number, number] | null;
	eye: [number, number, number];
}

export interface SynthScenario {
	/** N×3 ENU horizon directions, azimuth order, 0..360° in 0.2° steps. */
	dirs: Float64Array;
	/** h×w row-major, row 0 = top. */
	sky: Float32Array;
	fine: Float32Array;
	fg: Float32Array;
	/** nCorr×2 render-px photo points. */
	x2d: Float64Array;
	/** nCorr×3 ENU world points. */
	X: Float64Array;
	/** 48×64×3 ENU buffer (rows < 20 sky = 0). */
	xyz: Float32Array;
	/** 40×2 keypoints in xyz-view px. */
	kp: Float64Array;
}

export const XYZ_H = 48;
export const XYZ_W = 64;
export const N_KP = 40;

const D = Math.PI / 180;

function createMulberry32(seed: number) {
	let a = seed >>> 0;
	const rand = (): number => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	const gauss = (): number => {
		const u1 = 1 - rand();
		const u2 = rand();
		return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
	};
	return { rand, gauss };
}

type Vec3 = [number, number, number];

/** common.pose_to_R rows: right, -up, forward (world ENU to OpenCV camera). */
function poseRotation(p: SynthPose): [Vec3, Vec3, Vec3] {
	const y = p.yaw * D;
	const pt = p.pitch * D;
	const r = p.roll * D;
	const f: Vec3 = [
		Math.sin(y) * Math.cos(pt),
		Math.cos(y) * Math.cos(pt),
		Math.sin(pt),
	];
	const r0: Vec3 = [Math.cos(y), -Math.sin(y), 0.0];
	const u0: Vec3 = [
		r0[1] * f[2] - r0[2] * f[1],
		r0[2] * f[0] - r0[0] * f[2],
		r0[0] * f[1] - r0[1] * f[0],
	];
	const cr = Math.cos(r);
	const sr = Math.sin(r);
	const right: Vec3 = [
		r0[0] * cr - u0[0] * sr,
		r0[1] * cr - u0[1] * sr,
		r0[2] * cr - u0[2] * sr,
	];
	const up: Vec3 = [
		u0[0] * cr + r0[0] * sr,
		u0[1] * cr + r0[1] * sr,
		u0[2] * cr + r0[2] * sr,
	];
	return [right, [-up[0], -up[1], -up[2]], f];
}

function toCamera(R: [Vec3, Vec3, Vec3], v: Vec3): Vec3 {
	const row = (i: number) => R[i][0] * v[0] + R[i][1] * v[1] + R[i][2] * v[2];
	return [row(0), row(1), row(2)];
}

function focalPx(vfov: number, h: number): number {
	return h / 2 / Math.tan((vfov * D) / 2);
}

export function horizonElevationDeg(azimuthRad: number): number {
	return (
		1.2 + 1.5 * Math.sin(3 * azimuthRad) + 0.7 * Math.sin(7 * azimuthRad + 1.0)
	);
}

function direction(azimuthRad: number, elevationRad: number): Vec3 {
	return [
		Math.sin(azimuthRad) * Math.cos(elevationRad),
		Math.cos(azimuthRad) * Math.cos(elevationRad),
		Math.sin(elevationRad),
	];
}

function makeHorizonDirs(): Float64Array {
	const n = 1801;
	const out = new Float64Array(n * 3);
	for (let i = 0; i < n; i++) {
		const az = i * 0.2 * D;
		out.set(direction(az, horizonElevationDeg(az) * D), i * 3);
	}
	return out;
}

function skylineRows(
	dirs: Float64Array,
	pose: SynthPose,
	w: number,
	h: number,
): number[] {
	const R = poseRotation(pose);
	const f = focalPx(pose.vfov, h);
	const n = dirs.length / 3;
	const u = new Array<number>(n);
	const v = new Array<number>(n);
	const z = new Array<number>(n);
	for (let i = 0; i < n; i++) {
		const c = toCamera(R, [dirs[i * 3], dirs[i * 3 + 1], dirs[i * 3 + 2]]);
		z[i] = c[2];
		const zs = c[2] > 1e-6 ? c[2] : 1e-6;
		u[i] = w / 2 + (f * c[0]) / zs;
		v[i] = h / 2 + (f * c[1]) / zs;
	}
	const rows = new Array<number>(w).fill(Number.POSITIVE_INFINITY);
	for (let i = 0; i < n - 1; i++) {
		if (!(z[i] > 0.1 && z[i + 1] > 0.1 && Math.abs(u[i + 1] - u[i]) < 0.05 * w))
			continue;
		const lo = Math.min(u[i], u[i + 1]);
		const hi = Math.max(u[i], u[i + 1]);
		let j = Math.max(0, Math.ceil(lo - 0.5));
		while (j < w && j + 0.5 < hi) {
			const t = (j + 0.5 - u[i]) / (u[i + 1] - u[i]);
			const val = v[i] + t * (v[i + 1] - v[i]);
			if (val < rows[j]) rows[j] = val;
			j++;
		}
	}
	return rows;
}

export function makeScenario(params: SynthParams): SynthScenario {
	const rng = createMulberry32(params.seed);
	const { W, H, w, h, eye } = params;
	const tp = params.truePose;
	const dirs = makeHorizonDirs();

	const rows = skylineRows(dirs, tp, w, h);
	const visible = rows.map((r) => Number.isFinite(r) && r > 0 && r < h);
	const sky = new Float32Array(w * h);
	const fine = new Float32Array(w * h);
	const fg = new Float32Array(w * h);
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const above = !visible[x] || y + 0.5 < rows[x];
			const val = (above ? 0.95 : 0.05) + (rng.rand() * 2 - 1) * 0.03;
			sky[y * w + x] = Math.min(1.0, Math.max(0.0, val));
		}
	}
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			let val = rng.rand() * 0.05;
			if (visible[x]) {
				const d = (y + 0.5 - rows[x]) / 1.5;
				val += Math.exp(-(d * d));
			}
			fine[y * w + x] = val;
		}
	}
	if (params.fgBlock) {
		const [x0, y0, x1, y1] = params.fgBlock;
		for (let y = y0; y < y1; y++)
			for (let x = x0; x < x1; x++) fg[y * w + x] = 1.0;
	}

	const R = poseRotation(tp);
	const f = focalPx(tp.vfov, H);
	const hfov = 2 * Math.atan((Math.tan((tp.vfov * D) / 2) * W) / H);
	const x2d: number[] = [];
	const X3: number[] = [];
	let tries = 0;
	while (
		x2d.length / 2 < params.nCorr &&
		tries < 200 * Math.max(1, params.nCorr)
	) {
		tries++;
		const az = tp.yaw * D + ((rng.rand() * 2 - 1) * hfov) / 2;
		const elmax = horizonElevationDeg(az) - 0.2;
		const el = (-6 + rng.rand() * (elmax + 6)) * D;
		const r = 2000 + rng.rand() * 28000;
		const d = direction(az, el);
		const P: Vec3 = [eye[0] + r * d[0], eye[1] + r * d[1], eye[2] + r * d[2]];
		const c = toCamera(R, [P[0] - eye[0], P[1] - eye[1], P[2] - eye[2]]);
		if (!(c[2] > 0)) continue;
		const u = W / 2 + (f * c[0]) / c[2];
		const v = H / 2 + (f * c[1]) / c[2];
		if (!(u >= 0 && u < W && v >= 0 && v < H)) continue;
		let ux = u + params.noisePx * rng.gauss();
		let vx = v + params.noisePx * rng.gauss();
		if (rng.rand() < params.outlierFrac) {
			ux = rng.rand() * W;
			vx = rng.rand() * H;
		}
		x2d.push(ux, vx);
		X3.push(P[0], P[1], P[2]);
	}

	const xyz = new Float32Array(XYZ_H * XYZ_W * 3);
	for (let row = 20; row < XYZ_H; row++) {
		for (let col = 0; col < XYZ_W; col++) {
			let r = 400 + 30 * col + 50 * (row - 20);
			if (col >= 32) r *= 1.5;
			if (row >= 44 && col < 8) r = 150 + 10 * col;
			const az = (10 + 0.3 * col) * D;
			const o = (row * XYZ_W + col) * 3;
			xyz[o] = eye[0] + r * Math.sin(az);
			xyz[o + 1] = eye[1] + r * Math.cos(az);
			xyz[o + 2] = eye[2] - 0.05 * r + 20 * Math.sin(0.2 * col);
		}
	}
	const kp = new Float64Array(N_KP * 2);
	for (let i = 0; i < N_KP; i++) {
		if (i < 10) {
			kp[i * 2] = rng.rand() * XYZ_W;
			kp[i * 2 + 1] = rng.rand() * 19;
		} else if (i < 20) {
			kp[i * 2] = 30 + rng.rand() * 4;
			kp[i * 2 + 1] = 20 + rng.rand() * 28;
		} else if (i < 28) {
			kp[i * 2] = rng.rand() * 8;
			kp[i * 2 + 1] = 44 + rng.rand() * 4;
		} else {
			kp[i * 2] = rng.rand() * XYZ_W;
			kp[i * 2 + 1] = rng.rand() * XYZ_H;
		}
	}
	return {
		dirs,
		sky,
		fine,
		fg,
		x2d: Float64Array.from(x2d),
		X: Float64Array.from(X3),
		xyz,
		kp,
	};
}

export interface SynthChecksum {
	n: number;
	sum: number;
	sumsq: number;
	first: number;
	last: number;
}

export function checksumArray(a: ArrayLike<number>): SynthChecksum {
	let sum = 0;
	let sumsq = 0;
	for (let i = 0; i < a.length; i++) {
		sum += a[i];
		sumsq += a[i] * a[i];
	}
	return {
		n: a.length,
		sum,
		sumsq,
		first: a.length ? a[0] : 0,
		last: a.length ? a[a.length - 1] : 0,
	};
}

const BASE_TRUE: SynthPose = { yaw: 41.37, pitch: 0.83, roll: 0.4, vfov: 40 };
const PORTRAIT_TRUE: SynthPose = {
	yaw: 200.55,
	pitch: 3.1,
	roll: -0.7,
	vfov: 55,
};
const BASE_APP: SynthPose = { ...BASE_TRUE, yaw: 41.57, pitch: 0.73 };

function scenario(
	name: string,
	seed: number,
	size: [number, number, number, number],
	truePose: SynthPose,
	appPose: SynthPose,
	nCorr: number,
	fgBlock: SynthParams["fgBlock"] = null,
): SynthParams {
	const [W, H, w, h] = size;
	return {
		name,
		seed,
		W,
		H,
		w,
		h,
		truePose,
		appPose,
		nCorr,
		outlierFrac: 0.1,
		noisePx: 0.8,
		fgBlock,
		eye: [0, 0, 1500],
	};
}

export const SCENARIOS: SynthParams[] = [
	scenario("agree", 1, [1024, 768, 256, 192], BASE_TRUE, BASE_APP, 500),
	scenario(
		"disagree",
		2,
		[1024, 768, 256, 192],
		BASE_TRUE,
		{ ...BASE_TRUE, yaw: 45.37 },
		500,
	),
	scenario("skyOnly", 3, [1024, 768, 256, 192], BASE_TRUE, BASE_APP, 0),
	scenario(
		"fgBlock",
		4,
		[1024, 768, 256, 192],
		BASE_TRUE,
		BASE_APP,
		500,
		[96, 0, 160, 192],
	),
	scenario(
		"portrait",
		5,
		[768, 1024, 192, 256],
		PORTRAIT_TRUE,
		{ ...PORTRAIT_TRUE, yaw: 200.75, pitch: 3.0 },
		300,
	),
];
