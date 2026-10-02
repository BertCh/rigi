// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import type { Pose } from "../../camera";
import { intrinsicsFromPose, rayFactor } from "../geom";
import { camToEnuMatrix, toEnu } from "../lift";
import type { EyePair } from "../roll/eyes";
import {
	fitSpotAnchor,
	fuseSpot,
	jointPlacement,
	liftSpotView,
	multiviewPoses,
	nearestRotation,
	nearFieldMask,
	rangeGrid,
	refineSpotEyes,
	regridDepth,
	SPOT_ANCHOR_WINDOWS,
	type SpotView,
	spotEligible,
	spotOrigin,
	toEnuMatrix,
} from "../roll/spot";
import {
	type GaussianCloud,
	type NearFieldDepth,
	PixelClass,
	PROVENANCE_CODE,
	type SplitResult,
} from "../types";

const POSE: Pose = { yaw: 0, pitch: 0, roll: 0, vfov: 60 };
const W = 48;

/** A wall of constant z-depth `z`; the DEM range matches model * `demFactor` everywhere. */
function wallView(opts: {
	z?: number;
	demFactor?: number;
	pose?: Pose;
	eye?: [number, number, number];
	id?: string;
	noDem?: boolean;
}) {
	const z = opts.z ?? 40;
	const pose = opts.pose ?? POSE;
	const K = intrinsicsFromPose(pose, 1);
	const depth = new Float32Array(W * W).fill(z);
	const range = new Float32Array(W * W);
	for (let j = 0; j < W; j++)
		for (let i = 0; i < W; i++)
			range[j * W + i] = opts.noDem
				? Number.POSITIVE_INFINITY
				: z *
					(opts.demFactor ?? 1) *
					rayFactor(K, (i + 0.5) / W, (j + 0.5) / W);
	const view: SpotView = {
		id: opts.id ?? "v",
		pose,
		eye: opts.eye ?? [0, 0, 0],
		aspect: 1,
		photo: { width: W, height: W, data: new Uint8Array(4 * W * W).fill(90) },
		range: { width: W, height: W, data: range },
	};
	const d: NearFieldDepth = {
		width: W,
		height: W,
		depth,
		valid: new Uint8Array(W * W).fill(1),
		model: "t",
		seconds: 0,
	};
	return { view, depth: d, K };
}

describe("rangeGrid", () => {
	it("maps no-terrain markers to NaN and keeps finite ranges", () => {
		const g = rangeGrid({
			width: 4,
			height: 1,
			data: Float32Array.from([10, 0, Number.POSITIVE_INFINITY, Number.NaN]),
		});
		expect(g[0]).toBe(10);
		expect(Array.from(g.slice(1)).every(Number.isNaN)).toBe(true);
	});
});

describe("fitSpotAnchor", () => {
	it("fits on the first window that has samples and reports it", () => {
		const { view, depth, K } = wallView({});
		const dem = (u: number, v: number) => {
			const x = Math.min(W - 1, Math.floor(u * W));
			const y = Math.min(W - 1, Math.floor(v * W));
			return view.range.data[y * W + x];
		};
		const { fit, window } = fitSpotAnchor(depth, dem, K, {});
		expect(window).toEqual(SPOT_ANCHOR_WINDOWS[0]);
		expect(fit.quality).toBeGreaterThan(0.8);
		expect(fit.curve).toBeDefined();
	});
	it("returns a null window when nothing fits", () => {
		const { depth, K } = wallView({});
		const { fit, window } = fitSpotAnchor(depth, () => null, K, {});
		expect(window).toBeNull();
		expect(fit.quality).toBe(0);
		expect(
			fitSpotAnchor(depth, () => null, K, {}, { anchorWindows: [] }).fit.n,
		).toBe(0);
	});
	it("falls through to the second window when the first has too few samples", () => {
		const { depth, K } = wallView({});
		// every DEM range is 5 m: below the first window's 15 m floor, inside the second's 2 m
		const { window } = fitSpotAnchor(depth, () => 5, K, {});
		expect(window).toEqual(SPOT_ANCHOR_WINDOWS[1]);
	});
});

describe("liftSpotView / fuseSpot", () => {
	it("lifts a DEM-consistent wall into ENU reconstructed splats ahead of the eye", () => {
		const { view, depth } = wallView({ eye: [100, 200, 30] });
		const { cloud, result } = liftSpotView(view, depth, 3);
		expect(result.skipped).toBeUndefined();
		expect(result.anchorWindow).toEqual(SPOT_ANCHOR_WINDOWS[0]);
		expect(cloud.frame).toBe("enu");
		expect(cloud.count).toBeGreaterThan(300);
		expect(result.splats).toBe(cloud.count);
		expect(
			cloud.provenance.every((p) => p === PROVENANCE_CODE.reconstructed),
		).toBe(true);
		expect(cloud.source?.every((s) => s === 3)).toBe(true);
		// yaw 0 = north: y = eye.y + 40, x spans +-tan30*40*(1-1/W)
		for (let i = 0; i < cloud.count; i += 37) {
			expect(cloud.positions[3 * i + 1]).toBeCloseTo(240, 0);
			expect(Math.abs(cloud.positions[3 * i] - 100)).toBeLessThan(24);
		}
	});
	it("skips a photo whose depth is unrelated to the DEM and one without terrain", () => {
		// ratio varies over 3 orders: no consistent anchor
		const bad = wallView({});
		for (let k = 0; k < bad.depth.depth.length; k++)
			bad.depth.depth[k] = 5 * 1.05 ** (k % 120);
		const r = liftSpotView(bad.view, bad.depth, 0);
		expect(r.cloud.count).toBe(0);
		expect(r.result.skipped).toMatch(/anchor quality|no anchor fit/);
		const none = wallView({ noDem: true });
		const r2 = liftSpotView(none.view, none.depth, 0);
		expect(r2.result.skipped).toMatch(/no anchor fit/);
		expect(r2.result.anchorWindow).toBeNull();
	});
	it("people-mask pixels are left out of the lift", () => {
		const a = wallView({});
		const full = liftSpotView(a.view, a.depth, 0).cloud.count;
		const half = {
			width: W,
			height: W,
			data: Uint8Array.from({ length: W * W }, (_, k) =>
				k % W < W / 2 ? 1 : 0,
			),
		};
		const b = wallView({});
		b.view.peopleMask = half;
		const part = liftSpotView(b.view, b.depth, 0).cloud.count;
		expect(part).toBeGreaterThan(0);
		expect(part).toBeLessThan(0.7 * full);
		const c = wallView({});
		c.view.peopleMask = half;
		expect(
			liftSpotView(c.view, c.depth, 0, { dropPeople: false }).cloud.count,
		).toBeGreaterThan(part);
	});
	it("fuseSpot dedupes identical views, reports unusable ones and validates lengths", () => {
		const a = wallView({ id: "a" });
		const b = wallView({ id: "b" });
		const single = fuseSpot([a.view], [a.depth]);
		const both = fuseSpot([a.view, b.view], [a.depth, b.depth]);
		expect(both.merge.input).toBe(2 * single.cloud.count);
		expect(both.cloud.count).toBe(single.cloud.count);
		expect(both.views.map((v) => v.id)).toEqual(["a", "b"]);
		const missing = fuseSpot([a.view, b.view], [a.depth, null]);
		expect(missing.views[1].skipped).toBe("no depth");
		expect(missing.cloud.count).toBe(single.cloud.count);
		expect(() => fuseSpot([a.view], [])).toThrow(/one depth per view/);
	});
	it("a placement overrides the Rigi pose and anchor", () => {
		const a = wallView({ z: 40 });
		a.view.placement = {
			camToEnu: [1, 0, 0, 0, 0, 1, 0, -1, 0],
			eye: [0, 0, 0],
			scale: 1,
			K: a.K,
			quality: 0.9,
		};
		const { cloud, result } = liftSpotView(a.view, a.depth, 0);
		expect(result.anchorWindow).toEqual([0, 0]);
		expect(result.anchor.scale).toBe(1);
		expect(cloud.count).toBeGreaterThan(0);
		// camToEnu maps cam z (forward) to ENU y
		expect(cloud.positions[1]).toBeCloseTo(40, 0);
	});
});

describe("multiviewPoses", () => {
	it("packs camToEnu and the shifted eye into row-major 4x4 c2w", () => {
		const pose: Pose = { yaw: 30, pitch: -5, roll: 2, vfov: 50 };
		const mv = multiviewPoses(
			[{ pose, eye: [10, 20, 30], aspect: 1.5 }],
			[10, 20, 0],
		);
		const m = camToEnuMatrix(pose);
		const c = mv.c2w[0];
		expect(c).toHaveLength(16);
		expect([c[0], c[1], c[2], c[4], c[5], c[6], c[8], c[9], c[10]]).toEqual(m);
		expect([c[3], c[7], c[11]]).toEqual([0, 0, 30]);
		expect(c.slice(12)).toEqual([0, 0, 0, 1]);
		expect(mv.intrinsicsNorm[0]).toEqual(intrinsicsFromPose(pose, 1.5));
	});
});

describe("regridDepth", () => {
	const sq = (w: number, h: number): NearFieldDepth => ({
		width: w,
		height: h,
		depth: Float32Array.from({ length: w * h }, (_, k) => 1 + (k % w)),
		valid: new Uint8Array(w * h).fill(1),
		normal: new Float32Array(3 * w * h).fill(0.5),
		intrinsicsNorm: { fx: 1, fy: 1, cx: 0.5, cy: 0.5 },
		model: "t",
		seconds: 0,
	});
	it("returns the input when aspects agree within 2 %", () => {
		const d = sq(40, 30);
		expect(regridDepth(d, 4 / 3)).toBe(d);
	});
	it("re-grids a square crop onto a landscape photo, invalidating the margins", () => {
		const r = regridDepth(sq(30, 30), 4 / 3, 40);
		expect([r.width, r.height]).toEqual([40, 30]);
		expect(r.valid[15 * 40 + 1]).toBe(0);
		expect(r.valid[15 * 40 + 20]).toBe(1);
		expect(r.intrinsicsNorm?.fx).toBeCloseTo(0.75, 9);
		expect(r.intrinsicsNorm?.fy).toBeCloseTo(1, 9);
		expect(r.normal?.length).toBe(3 * 40 * 30);
	});
	it("portrait photos get a tall grid; a wide crop of a portrait photo crops vertically", () => {
		const r = regridDepth(sq(30, 30), 0.5, 40);
		expect([r.width, r.height]).toEqual([20, 40]);
		expect(r.intrinsicsNorm?.fx).toBeCloseTo(1, 9);
		expect(r.intrinsicsNorm?.fy).toBeCloseTo(0.5, 9);
		const t = regridDepth(sq(40, 20), 1, 30); // wide depth, square photo: depth crops horizontally in photo
		expect([t.width, t.height]).toEqual([30, 30]);
		expect(t.valid.some((v) => v === 0)).toBe(true);
	});
});

describe("refineSpotEyes / spotOrigin / nearFieldMask / spotEligible", () => {
	const pair: EyePair = {
		a: "a",
		b: "b",
		ok: true,
		t: [0.2, 0, 0],
		info: [1e4, 0, 0, 0, 1e4, 0, 0, 0, 1e4],
		baselineM: 0.2,
		used: 100,
		inliers: 100,
		nearInliers: 50,
		medPx: 1,
		relRotCorrDeg: 0,
		focalScale: [1, 1],
		gpsDist: 6.7,
	};
	const views = [
		{ id: "a", eye: [0, 0, 1.6] as [number, number, number] },
		{ id: "b", eye: [3, 6, 1.6] as [number, number, number] },
	];
	it("is off by default, and null without pairs", () => {
		expect(refineSpotEyes(views, [pair], () => 0)).toBeNull();
		expect(refineSpotEyes(views, [], () => 0, { refineEyes: true })).toBeNull();
	});
	it("refines when enabled and a pair passes the gate", () => {
		const r = refineSpotEyes(views, [pair], () => 0, { refineEyes: true });
		expect(r?.pairsUsed).toEqual(["a-b"]);
		expect(Object.keys(r?.eyes ?? {})).toEqual(["a", "b"]);
		const o = refineSpotEyes(views, [{ ...pair }], () => 0, {
			refineEyes: { eyeHeight: 2 },
		});
		expect(o).not.toBeNull();
	});
	it("spotOrigin is the mean eye", () => {
		expect(spotOrigin(views)).toEqual([1.5, 3, 1.6]);
		expect(spotOrigin([])).toEqual([0, 0, 0]);
	});
	it("nearFieldMask keeps requested classes minus people", () => {
		const split: SplitResult = {
			width: 4,
			height: 1,
			cls: Uint8Array.from([
				PixelClass.Sky,
				PixelClass.Terrain,
				PixelClass.Object,
				PixelClass.Far,
			]),
			counts: [1, 1, 1, 1, 0],
		};
		expect(Array.from(nearFieldMask(split).data)).toEqual([0, 255, 255, 0]);
		expect(Array.from(nearFieldMask(split, [PixelClass.Far]).data)).toEqual([
			0, 0, 0, 255,
		]);
		const people = { width: 4, height: 1, data: Uint8Array.from([0, 0, 1, 0]) };
		expect(Array.from(nearFieldMask(split, undefined, people).data)).toEqual([
			0, 255, 0, 0,
		]);
	});
	it("only accepted poses are eligible", () => {
		expect(spotEligible({ poseSource: "prior" })).toBe(false);
		expect(spotEligible({ poseSource: "saved" })).toBe(true);
	});
});

describe("nearestRotation / toEnuMatrix", () => {
	const det = (r: number[]) =>
		r[0] * (r[4] * r[8] - r[5] * r[7]) -
		r[1] * (r[3] * r[8] - r[5] * r[6]) +
		r[2] * (r[3] * r[7] - r[4] * r[6]);
	it("projects scaled and perturbed matrices onto SO(3)", () => {
		const R = camToEnuMatrix({ yaw: 33, pitch: 12, roll: -7, vfov: 50 });
		const scaled = R.map((v) => 2.5 * v);
		nearestRotation(scaled).forEach((v, i) => {
			expect(v).toBeCloseTo(R[i], 8);
		});
		const noisy = R.map((v, i) => v + 0.01 * Math.sin(i * 7));
		const N = nearestRotation(noisy);
		expect(det(N)).toBeCloseTo(1, 9);
		for (let a = 0; a < 3; a++)
			expect(N[3 * a] ** 2 + N[3 * a + 1] ** 2 + N[3 * a + 2] ** 2).toBeCloseTo(
				1,
				9,
			);
	});
	it("a singular matrix is returned unchanged", () => {
		const z = [1, 0, 0, 0, 0, 0, 0, 0, 0];
		expect(nearestRotation(z)).toEqual(z);
	});
	it("toEnuMatrix equals toEnu for the pose's own matrix", () => {
		const cam: GaussianCloud = {
			count: 2,
			frame: "camera",
			positions: Float32Array.from([1, 2, 3, -4, 0, 9]),
			scales: new Float32Array(6).fill(0.1),
			rotations: Float32Array.from([1, 0, 0, 0, 0.5, 0.5, 0.5, 0.5]),
			colors: new Uint8Array(8),
			provenance: new Uint8Array(2),
			source: Uint16Array.from([1, 2]),
		};
		const pose: Pose = { yaw: 77, pitch: -10, roll: 4, vfov: 60 };
		const a = toEnu(cam, pose, [5, 6, 7]);
		const b = toEnuMatrix(cam, camToEnuMatrix(pose), [5, 6, 7]);
		a.positions.forEach((v, i) => {
			expect(b.positions[i]).toBeCloseTo(v, 4);
		});
		a.rotations.forEach((v, i) => {
			expect(b.rotations[i]).toBeCloseTo(v, 5);
		});
		expect(Array.from(b.source ?? [])).toEqual([1, 2]);
	});
});

describe("jointPlacement", () => {
	// two cameras 3 m apart looking at flat ground 20 m below; the model is the world scaled by 1/s0
	const s0 = 7;
	const poses: Pose[] = [
		{ yaw: 10, pitch: -30, roll: 1, vfov: 60 },
		{ yaw: 25, pitch: -32, roll: -1, vfov: 60 },
	];
	const eyes: [number, number, number][] = [
		[0, 0, 0],
		[3, 1, 0.2],
	];
	function scene() {
		const views: SpotView[] = [];
		const depths: NearFieldDepth[] = [];
		const cams: {
			c2w: number[];
			intrinsicsNorm: ReturnType<typeof intrinsicsFromPose>;
		}[] = [];
		const Wd = 40;
		poses.forEach((p, i) => {
			const K = intrinsicsFromPose(p, 1);
			const M = camToEnuMatrix(p);
			const range = new Float32Array(Wd * Wd);
			const dz = new Float32Array(Wd * Wd);
			for (let j = 0; j < Wd; j++)
				for (let k = 0; k < Wd; k++) {
					const x = ((k + 0.5) / Wd - 0.5) / K.fx;
					const y = ((j + 0.5) / Wd - 0.5) / K.fy;
					const dirz = M[6] * x + M[7] * y + M[8];
					const t = dirz < -1e-3 ? -20 / dirz : Number.NaN;
					range[j * Wd + k] = Number.isFinite(t)
						? t * Math.sqrt(1 + x * x + y * y)
						: 0;
					dz[j * Wd + k] = Number.isFinite(t) ? t / s0 : 0;
				}
			views.push({
				id: `v${i}`,
				pose: p,
				eye: eyes[i],
				aspect: 1,
				photo: {
					width: Wd,
					height: Wd,
					data: new Uint8Array(4 * Wd * Wd).fill(128),
				},
				range: { width: Wd, height: Wd, data: range },
			});
			depths.push({
				width: Wd,
				height: Wd,
				depth: dz,
				valid: Uint8Array.from(dz, (v) => (v > 0 ? 1 : 0)),
				intrinsicsNorm: K,
				model: "t",
				seconds: 0,
			});
			cams.push({
				c2w: [
					M[0],
					M[1],
					M[2],
					eyes[i][0] / s0,
					M[3],
					M[4],
					M[5],
					eyes[i][1] / s0,
					M[6],
					M[7],
					M[8],
					eyes[i][2] / s0,
					0,
					0,
					0,
					1,
				],
				intrinsicsNorm: K,
			});
		});
		return { views, depths, cams };
	}
	it("recovers scale, rotations and eyes of a consistent reconstruction", () => {
		const { views, depths, cams } = scene();
		const jp = jointPlacement(views, depths, cams);
		expect(jp).not.toBeNull();
		expect(jp?.scale).toBeCloseTo(s0, 1);
		expect(jp?.inlierFrac).toBeGreaterThan(0.95);
		expect(Math.max(...(jp?.rotErrDeg ?? [9]))).toBeLessThan(0.05);
		expect(Math.max(...(jp?.eyeShiftM ?? [9]))).toBeLessThan(0.1 * s0);
		expect(jp?.placements).toHaveLength(2);
		// the placements feed fuseSpot, with ground ~20 m below
		views.forEach((v, i) => {
			v.placement = jp?.placements[i];
		});
		const res = fuseSpot(views, depths, {
			keep: [PixelClass.Terrain, PixelClass.Object],
		});
		expect(res.cloud.count).toBeGreaterThan(0);
		const zs = Array.from(
			{ length: res.cloud.count },
			(_, i) => res.cloud.positions[3 * i + 2],
		).sort((a, b) => a - b);
		expect(zs[zs.length >> 1]).toBeCloseTo(-20, 0);
		expect(res.views.every((v) => v.anchor.n >= 200)).toBe(true);
	});
	it("needs two consistent views with enough terrain samples", () => {
		const { views, depths, cams } = scene();
		expect(
			jointPlacement(views.slice(0, 1), depths.slice(0, 1), cams.slice(0, 1)),
		).toBeNull();
		expect(jointPlacement(views, depths.slice(0, 1), cams)).toBeNull();
		const noDem = views.map((v) => ({
			...v,
			range: { ...v.range, data: new Float32Array(v.range.data.length) },
		}));
		expect(jointPlacement(noDem, depths, cams)).toBeNull();
	});
});
