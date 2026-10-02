// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// snapPeaksNear / projectPoint: the hoisted-basis projector and the per-peak precompute are
// bit-identical to the old per-point implementation (kept below as the reference).
import { describe, expect, it } from "vitest";
import { dot3 } from "#/lib/linalg";
import { seededRandom, uniform } from "#/test/helpers";
import {
	makeProjector,
	type Pose,
	poseBasis,
	projectPoint,
} from "../../camera";
import { DEG as D, distanceM, EnuFrame } from "../../geodesy";
import { type Peak, type SnappedPeak, snapPeaksNear } from "../scene";
import type { TerrainSet } from "../terrain-data";

function projectPointOld(
	p: Pose,
	aspect: number,
	eye: ArrayLike<number>,
	pt: ArrayLike<number>,
) {
	const { forward, right, up } = poseBasis(p);
	const v = [pt[0] - eye[0], pt[1] - eye[1], pt[2] - eye[2]];
	const z = dot3(v, forward);
	if (z <= 0) return null;
	const t = Math.tan((p.vfov * D) / 2);
	const x = dot3(v, right) / z / (t * aspect);
	const y = dot3(v, up) / z / t;
	return { u: 0.5 + x / 2, v: 0.5 - y / 2, depth: z };
}

type LocalMax = { lat: number; lon: number; h: number } | undefined;

function snapPeaksNearOld(
	terrain: TerrainSet,
	peaks: Peak[],
	at: { lat: number; lon: number },
	pose: Pose,
	eye: [number, number, number],
	aspect: number,
	cache: Map<Peak, SnappedPeak | null>,
	localMax?: (p: Peak, r: number) => LocalMax,
): SnappedPeak[] {
	const m = 0.15;
	for (const p of peaks) {
		if (cache.has(p)) continue;
		const dist = distanceM(at, p);
		if (dist > 110000 || dist < 150) {
			cache.set(p, null);
			continue;
		}
		const raw = terrain.frame.fromGeo(p.lat, p.lon, p.ele ?? eye[2]);
		const pr = projectPointOld(pose, aspect, eye, raw);
		if (!pr || pr.u < -m || pr.u > 1 + m || pr.v < -m - 0.3 || pr.v > 1 + m)
			continue;
		const radiusM = Math.min(250, 60 + dist * 0.004);
		const snap = localMax
			? localMax(p, radiusM)
			: terrain.localMax(p.lat, p.lon, radiusM);
		if (!snap) continue;
		if (!Number.isFinite(snap.h)) {
			cache.set(p, null);
			continue;
		}
		const w = terrain.frame.fromGeo(snap.lat, snap.lon, snap.h);
		cache.set(p, {
			name: p.name,
			ele: p.ele,
			prominence: p.prominence,
			position: [w[0], w[1], w[2]],
		});
	}
	const out: SnappedPeak[] = [];
	for (const v of cache.values()) if (v) out.push(v);
	return out;
}

const sameNum = (a: number, b: number) => Object.is(a, b);

describe("makeProjector / projectPoint", () => {
	it("is bit-identical to the old projectPoint", () => {
		const rand = seededRandom(7);
		for (let i = 0; i < 300; i++) {
			const pose: Pose = {
				yaw: uniform(rand, -400, 400),
				pitch: uniform(rand, -60, 60),
				roll: uniform(rand, -30, 30),
				vfov: uniform(rand, 10, 90),
			};
			const aspect = uniform(rand, 0.5, 2.5);
			const eye = [
				uniform(rand, -50, 50),
				uniform(rand, -50, 50),
				uniform(rand, -5, 5),
			];
			const bound = makeProjector(pose, aspect, eye);
			for (let k = 0; k < 5; k++) {
				const pt = [
					uniform(rand, -1e5, 1e5),
					uniform(rand, -1e5, 1e5),
					uniform(rand, -2e3, 2e3),
				];
				const ref = projectPointOld(pose, aspect, eye, pt);
				for (const got of [projectPoint(pose, aspect, eye, pt), bound(pt)]) {
					if (!ref) expect(got).toBeNull();
					else {
						expect(got).not.toBeNull();
						expect(sameNum(got?.u as number, ref.u)).toBe(true);
						expect(sameNum(got?.v as number, ref.v)).toBe(true);
						expect(sameNum(got?.depth as number, ref.depth)).toBe(true);
					}
				}
			}
		}
	});
});

describe("snapPeaksNear", () => {
	const at = { lat: 46.7, lon: 8.0 };
	const frame = new EnuFrame(at.lat, at.lon, 1500);
	const localMax = (lat: number, lon: number, r: number) => ({
		lat: lat + r * 1e-7,
		lon,
		h: 1000 + ((lat * 1e4 + lon * 1e3) % 1500),
	});
	const terrain = { frame, localMax } as unknown as TerrainSet;

	const makePeaks = (rand: () => number, n: number): Peak[] =>
		Array.from({ length: n }, (_, i) => ({
			name: `p${i}`,
			lat: at.lat + uniform(rand, -0.9, 0.9),
			lon: at.lon + uniform(rand, -1.3, 1.3),
			ele: rand() < 0.3 ? null : uniform(rand, 500, 4000),
			prominence: null,
		}));

	it("matches the old implementation across turning poses, and reuses the precompute", () => {
		const rand = seededRandom(11);
		const peaks = makePeaks(rand, 600);
		const eye: [number, number, number] = [0, 0, 20];
		const cacheNew = new Map<Peak, SnappedPeak | null>();
		const cacheOld = new Map<Peak, SnappedPeak | null>();
		// ready only after the first sweep, so unknown peaks are retried
		let calls = 0;
		const lm = (p: Peak, r: number): LocalMax =>
			calls++ % 3 === 0 ? undefined : localMax(p.lat, p.lon, r);
		for (let step = 0; step < 24; step++) {
			const pose: Pose = {
				yaw: step * 9,
				pitch: uniform(rand, -10, 10),
				roll: uniform(rand, -5, 5),
				vfov: uniform(rand, 25, 60),
			};
			const aspect = uniform(rand, 0.7, 1.8);
			calls = 0;
			const a = snapPeaksNear(
				terrain,
				peaks,
				at,
				pose,
				eye,
				aspect,
				cacheNew,
				lm,
			);
			calls = 0;
			const b = snapPeaksNearOld(
				terrain,
				peaks,
				at,
				pose,
				eye,
				aspect,
				cacheOld,
				lm,
			);
			expect(a.length).toBe(b.length);
			for (let i = 0; i < a.length; i++) {
				expect(a[i].name).toBe(b[i].name);
				for (let k = 0; k < 3; k++)
					expect(sameNum(a[i].position[k], b[i].position[k])).toBe(true);
			}
			expect([...cacheNew.keys()]).toEqual([...cacheOld.keys()]);
		}
		expect(cacheNew.size).toBeGreaterThan(0);
	});

	it("invalidates the precompute when the eye height or photo changes", () => {
		const rand = seededRandom(3);
		const peaks = makePeaks(rand, 200);
		const pose: Pose = { yaw: 0, pitch: 0, roll: 0, vfov: 50 };
		const cache = new Map<Peak, SnappedPeak | null>();
		const ref = new Map<Peak, SnappedPeak | null>();
		for (const [lat, z] of [
			[46.7, 20],
			[46.7, 900],
			[46.75, 900],
		] as const) {
			const here = { lat, lon: at.lon };
			const eye: [number, number, number] = [0, 0, z];
			cache.clear();
			ref.clear();
			const a = snapPeaksNear(terrain, peaks, here, pose, eye, 1.3, cache);
			const b = snapPeaksNearOld(terrain, peaks, here, pose, eye, 1.3, ref);
			expect(a.map((s) => s.position)).toEqual(b.map((s) => s.position));
			expect(cache.size).toBe(ref.size);
		}
	});
});
