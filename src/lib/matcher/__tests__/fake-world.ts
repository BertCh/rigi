// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// A synthetic world, a fake MatchEngine and a fake keypoint backend for the end-to-end pipeline spec.
// The world is a function of direction (a horizon profile plus a smooth range), the engine ray-casts it
// through a pinhole at any pose, and the backend "matches" photo keypoints to view keypoints by the true
// geometry (plus ~10 % wrong pairs), so the pipelines see exactly what ALIKED + LightGlue would give on
// a perfect, textured scene. Conventions: ENU x E, y N, z up; R (poseToR) maps world to OpenCV camera.

import type { Pose } from "#/lib/camera";
import type { MatchEvidence } from "#/lib/renderer";
import type {
	FeatureBackend,
	FeatureMatches,
	FeatureSet,
	MatchEngine,
	PhotoSource,
	RgbaImage,
} from "../context";
import { DEG, focalPx, poseToR } from "../geometry";
import { horizonElevationDeg, makeScenario } from "./fixtures/synth";

export const VIEW_W = 256;
export const VIEW_H = 192;
export const EDGE_W = 128;
export const EDGE_H = 96;
export const EYE = { x: 0, y: 0, z: 1500 } as const;
export const TRUE_POSE: Pose = { yaw: 41.37, pitch: 0.83, roll: 0.4, vfov: 40 };

/** Terrain range along a ray below the horizon: smooth in azimuth and elevation (no 8 % lift jumps). */
export function rangeAt(azimuthRad: number, elevationDeg: number): number {
	const depth = horizonElevationDeg(azimuthRad) - elevationDeg;
	const r = 15000 + 500 * depth + 3000 * Math.sin(2 * azimuthRad);
	return Math.min(40000, Math.max(2000, r));
}

/** ENU point of the terrain hit by the unit ray `d` from the eye, or null for sky. */
export function worldPoint(
	d: ArrayLike<number>,
): [number, number, number] | null {
	const az = Math.atan2(d[0], d[1]);
	const el = Math.asin(Math.max(-1, Math.min(1, d[2]))) / DEG;
	if (el >= horizonElevationDeg(az)) return null;
	const r = rangeAt(az, el);
	return [EYE.x + d[0] * r, EYE.y + d[1] * r, EYE.z + d[2] * r];
}

/** World ray (unit) through continuous pixel (u, v) of a W×H pinhole at `pose`. */
export function rayThrough(
	pose: Pose,
	W: number,
	H: number,
	u: number,
	v: number,
): [number, number, number] {
	const R = poseToR(pose);
	const f = focalPx(pose.vfov, H);
	const cx = (u - W / 2) / f;
	const cy = (v - H / 2) / f;
	// R is orthonormal: world = Rᵀ · camera ray
	const x = R[0] * cx + R[3] * cy + R[6];
	const y = R[1] * cx + R[4] * cy + R[7];
	const z = R[2] * cx + R[5] * cy + R[8];
	const n = Math.hypot(x, y, z);
	return [x / n, y / n, z / n];
}

/** Pixel (continuous, origin top-left) of an ENU point under `pose`, null behind the camera. */
export function project(
	pose: Pose,
	W: number,
	H: number,
	P: ArrayLike<number>,
): [number, number] | null {
	const R = poseToR(pose);
	const f = focalPx(pose.vfov, H);
	const x = P[0] - EYE.x;
	const y = P[1] - EYE.y;
	const z = P[2] - EYE.z;
	const c0 = R[0] * x + R[1] * y + R[2] * z;
	const c1 = R[3] * x + R[4] * y + R[5] * z;
	const c2 = R[6] * x + R[7] * y + R[8] * z;
	if (!(c2 > 0)) return null;
	return [W / 2 + (f * c0) / c2, H / 2 + (f * c1) / c2];
}

export type FakeWorld = ReturnType<typeof createFakeWorld>;

export function createFakeWorld(
	o: { truePose?: Pose; alignYawErrorDeg?: number } = {},
) {
	const truePose = o.truePose ?? TRUE_POSE;
	const scenario = makeScenario({
		name: "fake-world",
		seed: 7,
		W: VIEW_W,
		H: VIEW_H,
		w: EDGE_W,
		h: EDGE_H,
		truePose,
		appPose: truePose,
		nCorr: 0,
		outlierFrac: 0,
		noisePx: 0,
		fgBlock: null,
		eye: [EYE.x, EYE.y, EYE.z],
	});
	const viewPoses = new Map<object, Pose>();
	const photoBuffers = new WeakSet<object>();
	const photoWorld = new WeakMap<FeatureSet, Float64Array>();
	const viewSource = new WeakMap<FeatureSet, Int32Array>();
	const calls = { renderPoseView: 0, matchEvidence: 0, extract: 0 };

	const engine: MatchEngine = {
		aspect: VIEW_W / VIEW_H,
		prior: { ...truePose },
		eye: EYE,
		frame: { lat: 46.7, lon: 7.8 } as MatchEngine["frame"],
		async renderPoseView(pose) {
			calls.renderPoseView++;
			const xyz = new Float32Array(VIEW_W * VIEW_H * 3);
			for (let y = 0; y < VIEW_H; y++)
				for (let x = 0; x < VIEW_W; x++) {
					const P = worldPoint(
						rayThrough(pose, VIEW_W, VIEW_H, x + 0.5, y + 0.5),
					);
					if (P) xyz.set(P, (y * VIEW_W + x) * 3);
				}
			const rgba = new Uint8ClampedArray(VIEW_W * VIEW_H * 4);
			for (let i = 0; i < VIEW_W * VIEW_H; i++) {
				rgba[i * 4] = xyz[i * 3] === 0 ? 200 : 90 + (i % 50);
				rgba[i * 4 + 1] = 110;
				rgba[i * 4 + 2] = 80;
				rgba[i * 4 + 3] = 255;
			}
			viewPoses.set(rgba, { ...pose });
			return { width: VIEW_W, height: VIEW_H, xyz, rgba };
		},
		async loadSatellite() {
			return { tiles: 0, missing: 0, retries: 0 };
		},
		async loadFullTerrain() {
			return 0;
		},
		async matchEvidence(alignFrom) {
			calls.matchEvidence++;
			const n = EDGE_W * EDGE_H;
			const rgb = new Uint8ClampedArray(n * 4).fill(128);
			const ev: MatchEvidence = {
				w: EDGE_W,
				h: EDGE_H,
				horizon: Float32Array.from(scenario.dirs),
				fine: scenario.fine,
				coarse: scenario.fine,
				fg: scenario.fg,
				sky: scenario.sky,
				rgb,
				align: alignFrom
					? {
							pose: {
								...truePose,
								yaw: truePose.yaw + (o.alignYawErrorDeg ?? 0.2),
							},
							score: 1,
							confidence: 0.9,
							alternatives: [],
						}
					: null,
			};
			return ev;
		},
	};

	const photo: PhotoSource & { rasters: number } = {
		width: 1024,
		height: 768,
		rasters: 0,
		async at(W, H): Promise<RgbaImage> {
			this.rasters++;
			const img = {
				data: new Uint8ClampedArray(W * H * 4),
				width: W,
				height: H,
			};
			photoBuffers.add(img.data);
			return img;
		},
	};

	const KP_GRID = 20;
	const features: FeatureBackend = {
		async extractFeatures(image) {
			calls.extract++;
			if (photoBuffers.has(image.data)) {
				// a grid of keypoints over the photo, terrain only, remembered with their world points
				const kp: number[] = [];
				const world: number[] = [];
				for (let j = 0; j < KP_GRID; j++)
					for (let i = 0; i < KP_GRID; i++) {
						const u = ((i + 0.5) * image.width) / KP_GRID;
						const v = ((j + 0.5) * image.height) / KP_GRID;
						const P = worldPoint(
							rayThrough(truePose, image.width, image.height, u, v),
						);
						if (!P) continue;
						kp.push(u - 0.5, v - 0.5);
						world.push(...P);
					}
				const set = featureSet(image, kp);
				photoWorld.set(set, Float64Array.from(world));
				return set;
			}
			const pose = viewPoses.get(image.data);
			if (!pose) throw new Error("fake backend: unknown image");
			// every photo keypoint whose world point projects inside this view
			const kp: number[] = [];
			const src: number[] = [];
			const lastPhoto = lastPhotoSet;
			if (!lastPhoto) throw new Error("fake backend: view before photo");
			const world = photoWorld.get(lastPhoto) as Float64Array;
			for (let k = 0; k < world.length / 3; k++) {
				const px = project(
					pose,
					image.width,
					image.height,
					world.subarray(k * 3, k * 3 + 3),
				);
				if (
					!px ||
					px[0] < 0 ||
					px[0] >= image.width ||
					px[1] < 0 ||
					px[1] >= image.height
				)
					continue;
				kp.push(px[0] - 0.5, px[1] - 0.5);
				src.push(k);
			}
			const set = featureSet(image, kp);
			viewSource.set(set, Int32Array.from(src));
			return set;
		},
		async matchFeatures(a, b) {
			const src = viewSource.get(b);
			if (!src) throw new Error("fake backend: second set is not a view");
			const nPhoto = a.count;
			const indices0 = new Uint32Array(src.length);
			const indices1 = new Uint32Array(src.length);
			for (let i = 0; i < src.length; i++) {
				// every 10th pair is wrong: the photo keypoint is another one
				indices0[i] = i % 10 === 9 ? (src[i] + 37) % nPhoto : src[i];
				indices1[i] = i;
			}
			const m: FeatureMatches = {
				indices0,
				indices1,
				scores: new Float32Array(src.length).fill(0.9),
				count: src.length,
			};
			return m;
		},
	};

	// the photo set the views are matched against (the backend is stateful across one request)
	let lastPhotoSet: FeatureSet | null = null;
	const extract = features.extractFeatures.bind(features);
	features.extractFeatures = async (image, opts) => {
		const set = await extract(image, opts);
		if (photoWorld.has(set)) lastPhotoSet = set;
		return set;
	};

	return { truePose, scenario, engine, photo, features, calls };
}

function featureSet(image: RgbaImage, kp: number[]): FeatureSet {
	const count = kp.length / 2;
	return {
		width: image.width,
		height: image.height,
		keypoints: Float32Array.from(kp),
		scores: new Float32Array(count).fill(1),
		descriptors: new Float32Array(count),
		dim: 1,
		count,
	};
}
