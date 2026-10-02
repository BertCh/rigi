// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it, vi } from "vitest";
import { type Pose, poseBasis } from "../../camera";
import { intrinsicsFromPose, rayFactor, sampleDemGrid } from "../geom";
import {
	type BuildSceneInput,
	buildNearFieldScene,
	confidenceRadiusFrom,
	imageToRGBA,
	type NearFieldRendererLike,
} from "../scene";
import {
	type GaussianCloud,
	type NearFieldDepth,
	PixelClass,
	PROVENANCE_CODE,
} from "../types";

const POSE: Pose = { yaw: 20, pitch: -15, roll: 0, vfov: 60 };
const ASPECT = 4 / 3;
const EYE = { x: 50, y: -20, z: 10 };
const W = 64;
const H = 48;
const K = intrinsicsFromPose(POSE, ASPECT);

/** Flat ground z = 0 seen from EYE: ray length per normalised pixel, or null above the horizon. */
function groundRange(u: number, v: number): number | null {
	const B = poseBasis(POSE);
	const x = (u - K.cx) / K.fx;
	const y = (v - K.cy) / K.fy;
	const d = [0, 1, 2].map((a) => B.right[a] * x - B.up[a] * y + B.forward[a]);
	const l = Math.hypot(d[0], d[1], d[2]);
	const dz = d[2] / l;
	return dz < -1e-6 ? -EYE.z / dz : null;
}

function renderer(): NearFieldRendererLike & {
	sampleAt: ReturnType<typeof vi.fn>;
} {
	return {
		pose: POSE,
		aspect: ASPECT,
		eye: EYE,
		sampleAt: vi.fn((u: number, v: number) => {
			const r = groundRange(u, v);
			return r == null ? null : { range: r };
		}),
	};
}

const OBJ = { i0: 26, i1: 36, j0: 26, j1: 36 };
const inObj = (i: number, j: number) =>
	i >= OBJ.i0 && i <= OBJ.i1 && j >= OBJ.j0 && j <= OBJ.j1;

/** Metric depth map of the ground with a box-like object 8 m from the lens. */
function depthMap(): NearFieldDepth {
	const depth = new Float32Array(W * H);
	const valid = new Uint8Array(W * H);
	for (let j = 0; j < H; j++)
		for (let i = 0; i < W; i++) {
			const u = (i + 0.5) / W;
			const v = (j + 0.5) / H;
			const r = groundRange(u, v);
			const k = j * W + i;
			if (inObj(i, j)) {
				depth[k] = 8;
				valid[k] = 1;
			} else if (r != null) {
				depth[k] = r / rayFactor(K, u, v);
				valid[k] = 1;
			}
		}
	return {
		width: W,
		height: H,
		depth,
		valid,
		model: "t",
		seconds: 0,
		intrinsicsNorm: K,
	};
}

const photo = {
	width: W,
	height: H,
	data: new Uint8Array(W * H * 4).fill(150),
};
const dist = (p: Float32Array, i: number) =>
	Math.hypot(p[3 * i] - EYE.x, p[3 * i + 1] - EYE.y, p[3 * i + 2] - EYE.z);

describe("confidenceRadiusFrom", () => {
	it("is half the median range plus 10 m, capped at 60 + 10", () => {
		expect(confidenceRadiusFrom([20, 20, 20])).toBe(20);
		expect(confidenceRadiusFrom([1000, 2000])).toBe(70);
		expect(confidenceRadiusFrom([0, 0])).toBe(10);
	});
	it("is 10 m with no content", () => {
		expect(confidenceRadiusFrom([])).toBe(10);
	});
});

describe("buildNearFieldScene (depth-lift path)", () => {
	const input = (extra: Partial<BuildSceneInput> = {}): BuildSceneInput => ({
		photoId: "p1",
		depth: depthMap(),
		renderer: renderer(),
		photo,
		...extra,
	});
	it("anchors on the ground, classifies the near object and lifts only it into ENU around the eye", () => {
		const s = buildNearFieldScene(input());
		expect(s.photoId).toBe("p1");
		expect(s.anchor.quality).toBeGreaterThan(0.6);
		expect(s.anchor.curve).toBeDefined();
		const k = (OBJ.j0 + 3) * W + OBJ.i0 + 3;
		expect(s.split.cls[k]).toBe(PixelClass.Object);
		expect(s.split.counts[PixelClass.Object]).toBeGreaterThanOrEqual(
			11 * 11 - 10,
		);
		expect(s.splats.frame).toBe("enu");
		expect(s.splats.count).toBeGreaterThan(5);
		for (let i = 0; i < s.splats.count; i++) {
			const d = dist(s.splats.positions, i);
			expect(d).toBeGreaterThan(7);
			expect(d).toBeLessThan(11);
		}
		expect(
			s.splats.provenance.every((p) => p === PROVENANCE_CODE.observed),
		).toBe(true);
		expect(s.confidenceRadius).toBeCloseTo(0.5 * 8.5 + 10, 0);
	});
	it("returns an empty cloud without a photo or cloud, and still reports the split", () => {
		const s = buildNearFieldScene(input({ photo: null }));
		expect(s.splats.count).toBe(0);
		expect(s.split.counts[PixelClass.Object]).toBeGreaterThan(0);
	});
	it("reuses a pre-sampled DEM grid instead of calling the renderer", () => {
		const r = renderer();
		const d = depthMap();
		const grid = sampleDemGrid(W, H, groundRange);
		const s = buildNearFieldScene({
			photoId: "p",
			depth: d,
			renderer: r,
			photo,
			demGrid: grid,
		});
		expect(r.sampleAt).not.toHaveBeenCalled();
		expect(s.anchor.quality).toBeGreaterThan(0.6);
		const r2 = renderer();
		buildNearFieldScene({
			photoId: "p",
			depth: d,
			renderer: r2,
			photo,
			demGrid: new Float32Array(3),
		});
		expect(r2.sampleAt).toHaveBeenCalled(); // wrong size: ignored
	});
	it("ground:false / farObjects:false skip grounding and still build a scene", () => {
		const a = buildNearFieldScene(input({ ground: false }));
		expect(a.split.counts[PixelClass.Object]).toBeGreaterThan(0);
		const b = buildNearFieldScene(input({ farObjects: false }));
		expect(b.splats.count).toBeGreaterThan(0);
	});
	it("a sky mask removes pixels from the anchor candidates", () => {
		const sky = { width: W, height: H, data: new Uint8Array(W * H).fill(1) };
		const s = buildNearFieldScene(input({ skyMask: sky }));
		expect(s.anchor.n).toBe(0);
		expect(s.anchor.quality).toBe(0);
	});
	it("lift options are passed through (stride, alpha)", () => {
		const a = buildNearFieldScene(input({ lift: { stride: 1, alpha: 99 } }));
		const b = buildNearFieldScene(input({ lift: { stride: 4 } }));
		expect(a.splats.count).toBeGreaterThan(b.splats.count);
		expect(a.splats.colors[3]).toBe(99);
	});
});

describe("buildNearFieldScene (service cloud path)", () => {
	/** Camera-frame gaussians on every depth cell's ray at the depth map's z. */
	function cloudFromDepth(d: NearFieldDepth, scale = 1): GaussianCloud {
		const pos: number[] = [];
		for (let j = 0; j < H; j += 2)
			for (let i = 0; i < W; i += 2) {
				const k = j * W + i;
				if (!d.valid[k]) continue;
				const z = d.depth[k] * scale;
				pos.push(
					(((i + 0.5) / W - K.cx) / K.fx) * z,
					(((j + 0.5) / H - K.cy) / K.fy) * z,
					z,
				);
			}
		const n = pos.length / 3;
		return {
			count: n,
			frame: "camera",
			positions: Float32Array.from(pos),
			scales: new Float32Array(3 * n).fill(0.1),
			rotations: Float32Array.from(
				Array.from({ length: n }, () => [1, 0, 0, 0]).flat(),
			),
			colors: new Uint8Array(4 * n).fill(200),
			provenance: new Uint8Array(n).fill(PROVENANCE_CODE.observed),
		};
	}
	it("keeps only the near-field object Gaussians and rescales a differently-scaled cloud onto the anchor", () => {
		const d = depthMap();
		const base = buildNearFieldScene({
			photoId: "p",
			depth: d,
			renderer: renderer(),
			cloud: cloudFromDepth(d),
		});
		expect(base.splats.count).toBeGreaterThan(5);
		expect(base.splats.count).toBeLessThan(0.2 * ((W * H) / 4));
		for (let i = 0; i < base.splats.count; i++)
			expect(dist(base.splats.positions, i)).toBeLessThan(12);
		// a cloud with its own scale (3x) is brought back to the depth model's units
		const scaled = buildNearFieldScene({
			photoId: "p",
			depth: d,
			renderer: renderer(),
			cloud: cloudFromDepth(d, 3),
		});
		expect(scaled.splats.count).toBe(base.splats.count);
		for (let i = 0; i < scaled.splats.count; i++)
			expect(dist(scaled.splats.positions, i)).toBeCloseTo(
				dist(base.splats.positions, i),
				0,
			);
	});
	it("an empty service cloud falls back to the depth lift", () => {
		const d = depthMap();
		const empty: GaussianCloud = { ...cloudFromDepth(d), count: 0 };
		const s = buildNearFieldScene({
			photoId: "p",
			depth: d,
			renderer: renderer(),
			cloud: empty,
			photo,
		});
		expect(s.splats.count).toBeGreaterThan(0);
	});
	it("rejects camera-frame requirement violations", () => {
		const d = depthMap();
		const c = { ...cloudFromDepth(d), frame: "enu" as const };
		expect(() =>
			buildNearFieldScene({
				photoId: "p",
				depth: d,
				renderer: renderer(),
				cloud: c,
			}),
		).toThrow(/camera-frame/);
	});
	it("re-projects a cloud built with other intrinsics onto the photo rays", () => {
		const d = depthMap();
		const wide = { fx: K.fx * 0.8, fy: K.fy * 0.8, cx: 0.5, cy: 0.5 };
		// gaussians generated with the wide camera at the same pixels
		const c = cloudFromDepth(d);
		for (let i = 0; i < c.count; i++) {
			c.positions[3 * i] *= K.fx / wide.fx;
			c.positions[3 * i + 1] *= K.fy / wide.fy;
		}
		const s = buildNearFieldScene({
			photoId: "p",
			depth: d,
			renderer: renderer(),
			cloud: c,
			cloudIntrinsics: wide,
		});
		const ref = buildNearFieldScene({
			photoId: "p",
			depth: d,
			renderer: renderer(),
			cloud: cloudFromDepth(d),
		});
		expect(s.splats.count).toBe(ref.splats.count);
	});
});

describe("imageToRGBA", () => {
	it("is null for empty images and when no canvas context is available", () => {
		expect(imageToRGBA({ width: 0, height: 0 } as never)).toBeNull();
		expect(imageToRGBA({ width: 10, height: 10 } as never)).toBeNull(); // node: no canvas
	});
});
