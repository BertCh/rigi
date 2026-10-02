// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import type { Pose } from "../../camera";
import { poseBasis } from "../../camera";
import {
	alignMono,
	holeMask,
	holeStats,
	liftGenerated,
	mergeClouds,
	type RgbdView,
	rayDir,
	viewIntrinsics,
} from "../generate/holes";
import { readoutHit } from "../generate/readout";
import { makeTrajectory } from "../generate/trajectory";
import { intrinsicsFromPose, rayFactor } from "../geom";
import {
	type GaussianCloud,
	type NearFieldDepth,
	PROVENANCE_CODE,
} from "../types";

const norm = (v: ArrayLike<number>) => Math.hypot(v[0], v[1], v[2]);

describe("makeTrajectory", () => {
	const pose: Pose = { yaw: 0, pitch: 10, roll: 0, vfov: 60 };
	const eye = { x: 5, y: 6, z: 7 };
	it("defaults to right, left, forward at `step`, level moves in the photo's axes", () => {
		const t = makeTrajectory(pose, eye, { aim: "parallel" });
		expect(t.map((c) => c.name)).toEqual(["right-10m", "left-10m", "fwd-10m"]);
		expect(t[0].offset[0]).toBeCloseTo(10, 9);
		expect(t[0].offset[1]).toBeCloseTo(0, 9);
		expect(t[0].offset[2]).toBe(0);
		expect(t[1].offset[0]).toBeCloseTo(-10, 9);
		expect(t[2].offset[1]).toBeCloseTo(10, 9); // yaw 0: forward = north
		expect(t[2].offset[2]).toBe(0); // level even though the photo pitches up
		expect(t[0].eye[0]).toBeCloseTo(15, 9);
		t.forEach((c) => {
			expect(c.pose).toEqual(pose);
		});
	});
	it("rotates the moves with the heading", () => {
		const t = makeTrajectory({ ...pose, yaw: 90 }, eye, {
			aim: "parallel",
			step: 4,
		});
		expect(t[0].offset[0]).toBeCloseTo(0, 9);
		expect(t[0].offset[1]).toBeCloseTo(-4, 9); // right of east = south
		expect(t[2].offset[0]).toBeCloseTo(4, 9);
	});
	it("pivot mode re-aims every camera at the point pivotDist ahead", () => {
		const t = makeTrajectory(pose, eye, { aim: "pivot", pivotDist: 40 });
		const F = poseBasis(pose).forward;
		const pivot = [5 + F[0] * 40, 6 + F[1] * 40, 7 + F[2] * 40];
		for (const c of t) {
			const f = poseBasis(c.pose).forward;
			const d = [pivot[0] - c.eye[0], pivot[1] - c.eye[1], pivot[2] - c.eye[2]];
			const l = norm(d);
			expect(f[0]).toBeCloseTo(d[0] / l, 9);
			expect(f[1]).toBeCloseTo(d[1] / l, 9);
			expect(f[2]).toBeCloseTo(d[2] / l, 9);
			expect(c.pose.vfov).toBe(60);
		}
		// the forward move ends 10 m closer: the same pivot is now steeper... heading unchanged
		expect(t[2].pose.yaw).toBeCloseTo(0, 6);
		expect(t[0].pose.yaw).toBeGreaterThan(300); // looks back left toward the pivot (wraps below 360)
	});
	it("shortens offsets beyond the confidence radius and honours custom moves", () => {
		const t = makeTrajectory(pose, eye, {
			aim: "parallel",
			radius: 3,
			moves: [{ side: 30 }, { up: 2, forward: 1, name: "hop" }, { side: 0.5 }],
		});
		expect(norm(t[0].offset)).toBeCloseTo(3, 9);
		expect(t[0].name).toBe("view-0");
		expect(t[1].name).toBe("hop");
		expect(t[1].offset[2]).toBe(2);
		expect(t[2].offset[0]).toBeCloseTo(0.5, 9);
		for (const c of t) expect(norm(c.offset)).toBeLessThanOrEqual(3 + 1e-9);
	});
});

function enuCloud(
	pts: number[][],
	std: number | number[],
	prov: number[],
): GaussianCloud {
	const n = pts.length;
	const sc = Array.isArray(std) ? std : pts.map(() => std);
	return {
		count: n,
		frame: "enu",
		positions: Float32Array.from(pts.flat()),
		scales: Float32Array.from(sc.flatMap((s) => [s, s, s])),
		rotations: Float32Array.from(pts.flatMap(() => [1, 0, 0, 0])),
		colors: new Uint8Array(4 * n).fill(255),
		provenance: Uint8Array.from(prov),
	};
}

describe("readoutHit", () => {
	const obs = PROVENANCE_CODE.observed;
	const gen = PROVENANCE_CODE.generated;
	it("hits the nearest measurable splat on the ray, skipping generated ones in front", () => {
		const c = enuCloud(
			[
				[0, 5, 0],
				[0, 10, 0],
				[0, 20, 0],
			],
			0.1,
			[gen, obs, obs],
		);
		const h = readoutHit(c, [0, 0, 0], [0, 2, 0]);
		expect(h?.index).toBe(1);
		expect(h?.t).toBeCloseTo(10, 6);
		expect(h?.point).toEqual([0, 10, 0]);
		expect(h?.skippedGenerated).toBe(1);
		expect(h?.provenance).toBe(obs);
	});
	it("misses when the ray passes outside the hit radius, honours sigmas / minRadius / near", () => {
		const c = enuCloud([[1, 10, 0]], 0.2, [obs]);
		expect(readoutHit(c, [0, 0, 0], [0, 1, 0])).toBeNull();
		expect(readoutHit(c, [0, 0, 0], [0, 1, 0], { sigmas: 6 })?.index).toBe(0);
		const tiny = enuCloud([[0.04, 10, 0]], 0.001, [obs]);
		expect(readoutHit(tiny, [0, 0, 0], [0, 1, 0])?.index).toBe(0); // minRadius 0.05
		expect(
			readoutHit(tiny, [0, 0, 0], [0, 1, 0], { minRadius: 0.01 }),
		).toBeNull();
		expect(readoutHit(c, [0, 0, 0], [1, 10, 0], { near: 20 })).toBeNull();
	});
	it("ignores splats behind the origin and returns null when only generated ones are met", () => {
		const behind = enuCloud([[0, -5, 0]], 1, [obs]);
		expect(readoutHit(behind, [0, 0, 0], [0, 1, 0])).toBeNull();
		const onlyGen = enuCloud([[0, 5, 0]], 1, [gen]);
		expect(readoutHit(onlyGen, [0, 0, 0], [0, 1, 0])).toBeNull();
		const unknown = enuCloud([[0, 5, 0]], 1, [200]);
		expect(readoutHit(unknown, [0, 0, 0], [0, 1, 0])).toBeNull();
	});
	it("rejects camera-frame clouds", () => {
		const c = { ...enuCloud([[0, 5, 0]], 1, [obs]), frame: "camera" as const };
		expect(() => readoutHit(c, [0, 0, 0], [0, 1, 0])).toThrow(/ENU/);
	});
});

// ---- RGB-D views over a flat ground plane z = 0 seen from an eye at z = 2 ----
const VW = 64;
const VH = 48;
function groundView(
	observedFn: (i: number, j: number) => boolean = () => true,
): RgbdView {
	const pose: Pose = { yaw: 0, pitch: -20, roll: 0, vfov: 60 };
	const camera = {
		name: "c",
		pose,
		eye: [0, 0, 2] as [number, number, number],
		offset: [0, 0, 0] as [number, number, number],
	};
	const aspect = VW / VH;
	const K = intrinsicsFromPose(pose, aspect);
	const range = new Float32Array(VW * VH);
	const world = new Float32Array(3 * VW * VH).fill(Number.NaN);
	const observed = new Uint8Array(VW * VH);
	for (let j = 0; j < VH; j++)
		for (let i = 0; i < VW; i++) {
			const k = j * VW + i;
			const d = rayDir(pose, K, (i + 0.5) / VW, (j + 0.5) / VH);
			if (d[2] < -1e-3) {
				const t = -2 / d[2];
				range[k] = t;
				world[3 * k] = d[0] * t;
				world[3 * k + 1] = d[1] * t;
				world[3 * k + 2] = 2 + d[2] * t;
			}
			observed[k] = observedFn(i, j) ? 1 : 0;
		}
	return {
		width: VW,
		height: VH,
		camera,
		aspect,
		rgba: new Uint8ClampedArray(4 * VW * VH),
		world,
		range,
		observed,
		sky: new Uint8Array(VW * VH),
	};
}
const filledRgba = (r: number, g: number, b: number) => {
	const a = new Uint8ClampedArray(4 * VW * VH);
	for (let i = 0; i < VW * VH; i++) a.set([r, g, b, 255], 4 * i);
	return a;
};

describe("rayDir / viewIntrinsics", () => {
	it("is unit length and the image centre looks along forward", () => {
		const pose: Pose = { yaw: 40, pitch: 15, roll: 3, vfov: 50 };
		const K = intrinsicsFromPose(pose, 1.5);
		const c = rayDir(pose, K, 0.5, 0.5);
		const f = poseBasis(pose).forward;
		for (let a = 0; a < 3; a++) expect(c[a]).toBeCloseTo(f[a], 9);
		expect(norm(rayDir(pose, K, 0.1, 0.9))).toBeCloseTo(1, 12);
		// right half of the image points toward camera right
		const R = poseBasis(pose).right;
		const r = rayDir(pose, K, 0.9, 0.5);
		expect(r[0] * R[0] + r[1] * R[1] + r[2] * R[2]).toBeGreaterThan(0.3);
		expect(viewIntrinsics(groundView())).toEqual(
			intrinsicsFromPose(groundView().camera.pose, VW / VH),
		);
	});
});

describe("holeMask / holeStats", () => {
	it("marks unobserved pixels and dilates by the requested radius", () => {
		const v = groundView((i, j) => !(i === 10 && j === 10));
		const m0 = holeMask(v, 0);
		expect(m0.reduce((a, b) => a + b, 0)).toBe(1);
		const m1 = holeMask(v);
		expect(m1.reduce((a, b) => a + b, 0)).toBe(5);
		expect(m1[10 * VW + 11]).toBe(1);
		expect(m1[11 * VW + 11]).toBe(0); // 4-neighbourhood
		expect(holeMask(v, 2).reduce((a, b) => a + b, 0)).toBe(13);
	});
	it("dilation clips at the image border", () => {
		const v = groundView((i, j) => !(i === 0 && j === 0));
		expect(holeMask(v, 1).reduce((a, b) => a + b, 0)).toBe(3);
	});
	it("holeStats splits hole pixels into DEM-backed and no-geometry", () => {
		const v = groundView((_i, j) => j >= 24); // top half unobserved: sky rows + ground rows
		const hole = holeMask(v, 0);
		const s = holeStats(v, hole);
		expect(s.holeFrac).toBeCloseTo(0.5, 9);
		expect(s.demBacked + s.noGeo).toBeCloseTo(1, 9);
		expect(s.noGeo).toBeGreaterThan(0);
		expect(s.demBacked).toBeGreaterThan(0);
		expect(holeStats(v, new Uint8Array(VW * VH))).toEqual({
			holeFrac: 0,
			demBacked: 0,
			noGeo: 0,
		});
	});
});

describe("liftGenerated", () => {
	it("lifts only hole pixels, on the DEM surface just in front of it, as generated discs", () => {
		const v = groundView((i, j) => !(j >= 30 && i >= 20 && i < 44)); // a hole on the ground
		const hole = holeMask(v, 0);
		const { cloud, stats } = liftGenerated(v, filledRgba(10, 20, 30), hole);
		expect(cloud.frame).toBe("enu");
		expect(cloud.count).toBe(stats.demBacked);
		expect(stats.mono).toBe(0);
		expect(cloud.count).toBeGreaterThan(50);
		expect(cloud.provenance.every((p) => p === PROVENANCE_CODE.generated)).toBe(
			true,
		);
		for (let i = 0; i < cloud.count; i++) {
			// on the ground plane (ray pulled toward the eye by 0.2 % + 5 cm lifts it slightly)
			const z = cloud.positions[3 * i + 2];
			expect(z).toBeGreaterThan(0);
			expect(z).toBeLessThan(0.5);
		}
		expect(Array.from(cloud.colors.subarray(0, 4))).toEqual([10, 20, 30, 255]);
		// disc: thin along its normal, flat-ground normal = +z -> identity rotation
		expect(cloud.scales[2]).toBeLessThan(cloud.scales[0]);
		expect(cloud.rotations[0]).toBeCloseTo(1, 5);
	});
	it("never lifts observed pixels and skips holes without geometry", () => {
		const v = groundView();
		const none = liftGenerated(v, filledRgba(0, 0, 0), holeMask(v, 0));
		expect(none.cloud.count).toBe(0);
		const sky = groundView((_i, j) => j >= 10);
		const skyOnly = new Uint8Array(VW * VH);
		for (let k = 0; k < 5 * VW; k++) skyOnly[k] = 1; // top rows: above the horizon
		const r = liftGenerated(sky, filledRgba(0, 0, 0), skyOnly);
		expect(r.cloud.count).toBe(0);
		expect(r.stats.skipped).toBeGreaterThan(0);
	});
	it("a custom provenance and stride are honoured", () => {
		const v = groundView((_i, j) => j < 40);
		const hole = holeMask(v, 0);
		const a = liftGenerated(v, filledRgba(1, 2, 3), hole, {
			stride: 1,
			provenance: PROVENANCE_CODE.reconstructed,
		});
		const b = liftGenerated(v, filledRgba(1, 2, 3), hole, { stride: 4 });
		expect(a.cloud.count).toBeGreaterThan(8 * b.cloud.count);
		expect(a.cloud.provenance[0]).toBe(PROVENANCE_CODE.reconstructed);
	});
	it("monocular fallback lifts sky holes standing above modelled terrain only when aligned locally", () => {
		const v = groundView((_i, j) => j >= 20); // top 20 rows are holes (sky above the horizon + far ground)
		const hole = holeMask(v, 0);
		const needs = new Uint8Array(VW * VH);
		for (let k = 0; k < VW * VH; k++)
			needs[k] = hole[k] && !(v.range[k] > 0) ? 1 : 0;
		const K = viewIntrinsics(v);
		const mono: NearFieldDepth = {
			width: VW,
			height: VH,
			depth: new Float32Array(VW * VH),
			valid: new Uint8Array(VW * VH).fill(1),
			model: "t",
			seconds: 0,
		};
		for (let j = 0; j < VH; j++)
			for (let i = 0; i < VW; i++) {
				const k = j * VW + i;
				const rf = rayFactor(K, (i + 0.5) / VW, (j + 0.5) / VH);
				mono.depth[k] = (v.range[k] > 0 ? v.range[k] / 2 : 50) / rf; // model is half the DEM range
			}
		const align = alignMono(v, mono, needs);
		expect(align.mode).toBe("local");
		expect(align.scale).toBeCloseTo(2, 2);
		expect(align.residualLog).toBeLessThan(1e-3);
		const withMono = liftGenerated(v, filledRgba(5, 5, 5), hole, {
			mono: { depth: mono, align },
		});
		const without = liftGenerated(v, filledRgba(5, 5, 5), hole);
		expect(withMono.stats.mono).toBeGreaterThan(0);
		expect(without.stats.mono).toBe(0);
		expect(withMono.cloud.count).toBeGreaterThan(without.cloud.count);
		// no support test: more is lifted
		const floaty = liftGenerated(v, filledRgba(5, 5, 5), hole, {
			mono: { depth: mono, align },
			monoSupportRows: 0,
		});
		expect(floaty.stats.mono).toBeGreaterThanOrEqual(withMono.stats.mono);
		// a global alignment is not trusted unless asked for
		const g = { ...align, mode: "global" as const };
		expect(
			liftGenerated(v, filledRgba(5, 5, 5), hole, {
				mono: { depth: mono, align: g },
			}).stats.mono,
		).toBe(0);
		expect(
			liftGenerated(v, filledRgba(5, 5, 5), hole, {
				mono: { depth: mono, align: g },
				monoGlobal: true,
			}).stats.mono,
		).toBeGreaterThan(0);
	});
});

describe("alignMono", () => {
	it("falls back to a global fit, then to none when there is too little DEM", () => {
		const v = groundView();
		const mono: NearFieldDepth = {
			width: VW,
			height: VH,
			depth: new Float32Array(VW * VH).fill(10),
			valid: new Uint8Array(VW * VH).fill(1),
			model: "t",
			seconds: 0,
		};
		const needs = new Uint8Array(VW * VH); // nothing needs mono -> no local neighbourhood
		const g = alignMono(v, mono, needs, { maxRange: 1e6 });
		expect(g.mode).toBe("global");
		expect(g.n).toBeGreaterThan(200);
		const empty = alignMono(
			{ ...v, range: new Float32Array(VW * VH) },
			mono,
			needs,
		);
		expect(empty.mode).toBe("none");
		expect(empty.scale).toBe(1);
		expect(empty.residualLog).toBeNaN();
	});
});

describe("mergeClouds", () => {
	const a = enuCloud([[1, 2, 3]], 0.1, [1]);
	const b = enuCloud(
		[
			[4, 5, 6],
			[7, 8, 9],
		],
		0.2,
		[2, 3],
	);
	it("concatenates attributes and drops source unless every part has it", () => {
		const m = mergeClouds(a, b);
		expect(m.count).toBe(3);
		expect(Array.from(m.positions)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
		expect(Array.from(m.provenance)).toEqual([1, 2, 3]);
		expect(m.source).toBeUndefined();
		const sa = { ...a, source: Uint16Array.from([7]) };
		const sb = { ...b, source: Uint16Array.from([8, 9]) };
		expect(Array.from(mergeClouds(sa, sb).source ?? [])).toEqual([7, 8, 9]);
		expect(mergeClouds(sa, enuCloud([], 1, [])).source).toBeDefined();
	});
	it("handles no parts and rejects camera clouds", () => {
		expect(mergeClouds().count).toBe(0);
		expect(() => mergeClouds({ ...a, frame: "camera" })).toThrow(/ENU/);
	});
});
