// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { withFlags } from "#/test/helpers";
import type { Pose } from "../../../camera";
import { readoutHit } from "../../generate/readout";
import { intrinsicsFromPose } from "../../geom";
import { camToEnuMatrix, liftToGaussians } from "../../lift";
import { buildMeasureGrid } from "../../measure";
import { filterForExport } from "../../provenance";
import {
	type GaussianCloud,
	type NearFieldDepth,
	type NearFieldScene,
	PixelClass,
	PROVENANCE_CODE,
	type SplitResult,
} from "../../types";
import {
	appendCompletionSplats,
	assertCompletionNotMeasurable,
	completeBehindLayer,
	completeScene,
	completionEnabled,
} from "../index";

const pose: Pose = { yaw: 30, pitch: 0, roll: 0, vfov: 60 };
const aspect = 1.5;
const W = 16;
const H = 16;
const K = intrinsicsFromPose(pose, aspect);
const m = camToEnuMatrix(pose);
const eye = { x: 0, y: 0, z: 1.6 };
const frame = { toGeo: () => ({ lat: 0, lon: 0, h: 0 }) };
const ctx = { pose, aspect, eye, frame };

function cellRay(i: number, j: number) {
	const cx = ((i + 0.5) / W - K.cx) / K.fx;
	const cy = ((j + 0.5) / H - K.cy) / K.fy;
	const f = Math.sqrt(1 + cx * cx + cy * cy);
	const d = [cx / f, cy / f, 1 / f];
	const dir = [
		m[0] * d[0] + m[1] * d[1] + m[2] * d[2],
		m[3] * d[0] + m[4] * d[1] + m[5] * d[2],
		m[6] * d[0] + m[7] * d[1] + m[8] * d[2],
	];
	return { f, dir, ground: dir[2] < 0 ? eye.z / -dir[2] : Number.NaN };
}

/** Flat ground below the horizon (all wrongly Object) + a "person" column above it. One observed splat per cell. */
function build() {
	const cls = new Uint8Array(W * H);
	const dem = new Float32Array(W * H).fill(Number.NaN);
	const z = new Float32Array(W * H).fill(Number.NaN);
	const normal = new Float32Array(3 * W * H);
	const pos: number[] = [];
	const nUp = [
		m[0] * 0 + m[3] * 0 + m[6],
		m[1] * 0 + m[4] * 0 + m[7],
		m[2] * 0 + m[5] * 0 + m[8],
	];
	let ground = 0;
	for (let j = 0; j < H; j++)
		for (let i = 0; i < W; i++) {
			const k = j * W + i;
			const r = cellRay(i, j);
			if (r.dir[2] < 0) {
				cls[k] = PixelClass.Object;
				dem[k] = r.ground;
				z[k] = r.ground / r.f;
				normal.set(nUp, 3 * k);
				pos.push(
					eye.x + r.ground * r.dir[0],
					eye.y + r.ground * r.dir[1],
					eye.z + r.ground * r.dir[2],
				);
				ground++;
			}
		}
	const n = pos.length / 3;
	const splats: GaussianCloud = {
		count: n,
		frame: "enu",
		positions: Float32Array.from(pos),
		scales: new Float32Array(3 * n).fill(0.1),
		rotations: Float32Array.from({ length: 4 * n }, (_, i) => (i % 4 ? 0 : 1)),
		colors: new Uint8Array(4 * n).fill(200),
		provenance: new Uint8Array(n).fill(PROVENANCE_CODE.observed),
	};
	const split: SplitResult = {
		width: W,
		height: H,
		cls,
		counts: [0, 0, 0, ground, 0],
	};
	const scene = {
		photoId: "t",
		anchor: {
			scale: 1,
			shift: 0,
			residualLog: 0,
			inlierFrac: 1,
			n: 1,
			quality: 1,
			maxRange: 100,
		},
		split,
		splats,
		confidenceRadius: 20,
	} as unknown as NearFieldScene;
	const depth: NearFieldDepth = {
		width: W,
		height: H,
		depth: z,
		valid: new Uint8Array(W * H).map((_, k) => (z[k] > 0 ? 1 : 0)),
		normal,
		model: "t",
		seconds: 0,
	};
	return { scene, depth, dem };
}

/** An ENU generated cloud of `n` splats on the line of sight through the middle of the image, 5 m out. */
function generatedCloud(
	n: number,
	prov = PROVENANCE_CODE.generated,
): GaussianCloud {
	const r = cellRay(8, 8);
	const pos: number[] = [];
	for (let i = 0; i < n; i++)
		pos.push(
			eye.x + (5 + i * 0.01) * r.dir[0],
			eye.y + (5 + i * 0.01) * r.dir[1],
			eye.z + (5 + i * 0.01) * r.dir[2],
		);
	return {
		count: n,
		frame: "enu",
		positions: Float32Array.from(pos),
		scales: new Float32Array(3 * n).fill(0.5),
		rotations: Float32Array.from({ length: 4 * n }, (_, i) => (i % 4 ? 0 : 1)),
		colors: new Uint8Array(4 * n).fill(255),
		provenance: new Uint8Array(n).fill(prov),
	};
}

describe("completion is display-only (added splats are never measurable)", () => {
	const { scene } = build();
	const extra = generatedCloud(3);
	const { scene: withExtra, range } = appendCompletionSplats(scene, extra);

	it("appends after the observed splats with generated provenance", () => {
		expect(range).toEqual({ start: scene.splats.count, count: 3 });
		expect(withExtra.splats.count).toBe(scene.splats.count + 3);
		expect(() =>
			assertCompletionNotMeasurable(withExtra.splats, range),
		).not.toThrow();
		expect(scene.splats.count).toBe(withExtra.splats.count - 3); // input unchanged
	});
	it("rejects observed, reconstructed, dem and unknown codes", () => {
		for (const code of [0, 1, 2, 4, 255]) {
			expect(() =>
				appendCompletionSplats(scene, generatedCloud(1, code)),
			).toThrow();
			expect(() =>
				assertCompletionNotMeasurable(generatedCloud(2, code)),
			).toThrow();
		}
	});
	it("never passes filterForExport", () => {
		const out = filterForExport(withExtra.splats);
		expect(out.count).toBe(scene.splats.count);
		for (let i = 0; i < out.count; i++)
			expect(out.provenance[i]).not.toBe(PROVENANCE_CODE.generated);
	});
	it("never enters the measure grid", () => {
		const only = { ...withExtra, splats: extra };
		const g = buildMeasureGrid(only, ctx);
		expect(g.range.every((r) => Number.isNaN(r))).toBe(true);
		// and the observed ground still bins identically with the extra splats present
		const a = buildMeasureGrid(scene, ctx);
		const b = buildMeasureGrid(withExtra, ctx);
		expect(Array.from(b.range.map((v) => (Number.isNaN(v) ? -1 : v)))).toEqual(
			Array.from(a.range.map((v) => (Number.isNaN(v) ? -1 : v))),
		);
	});
	it("is passed through by readoutHit (the ray reaches the observed splat behind)", () => {
		const r = cellRay(8, 8);
		const o = [eye.x, eye.y, eye.z];
		expect(readoutHit(extra, o, r.dir, { sigmas: 4 })).toBeNull();
		const hit = readoutHit(withExtra.splats, o, r.dir, {
			sigmas: 4,
			minRadius: 0.5,
		});
		expect(hit).not.toBeNull();
		expect(hit?.index).toBeLessThan(scene.splats.count);
	});
});

describe("completeScene", () => {
	it("reclassifies slab ground to Terrain and drops exactly its observed splats", () => {
		const { scene, depth, dem } = build();
		const res = completeScene(scene, { depth, demGrid: dem, K, pose, eye });
		expect(res.slab?.count).toBeGreaterThan(10);
		expect(res.scene.split.counts[PixelClass.Terrain]).toBe(res.slab?.count);
		expect(res.removedSplats).toBe(res.slab?.count);
		expect(res.scene.splats.count).toBe(scene.splats.count - res.removedSplats);
		expect(res.addedSplats).toBe(0);
		// survivors keep their (observed) provenance: nothing was relabelled
		for (let i = 0; i < res.scene.splats.count; i++)
			expect(res.scene.splats.provenance[i]).toBe(PROVENANCE_CODE.observed);
		// the input scene is untouched
		expect(scene.split.counts[PixelClass.Terrain]).toBe(0);
		// the measure grid built afterwards has no cell in a reclassified region
		const g = buildMeasureGrid(res.scene, ctx);
		for (let k = 0; k < W * H; k++)
			if (res.slab?.mask[k]) expect(Number.isNaN(g.range[k])).toBe(true);
	});
	it("slab: false is a no-op returning the same scene", () => {
		const { scene, depth, dem } = build();
		const res = completeScene(
			scene,
			{ depth, demGrid: dem, K, pose, eye },
			{ slab: false },
		);
		expect(res.scene).toBe(scene);
		expect(res.slab).toBeNull();
	});
	it("the behind layer is explicitly not implemented", () => {
		const { scene, depth, dem } = build();
		expect(() => completeBehindLayer()).toThrow(/not implemented/);
		expect(() =>
			completeScene(
				scene,
				{ depth, demGrid: dem, K, pose, eye },
				{ behindLayer: true },
			),
		).toThrow(/decision 6/);
	});
});

describe("?nearfield=complete flag", () => {
	it("is accepted by the flag table and read by completionEnabled only", () => {
		withFlags({ nearfield: "complete" });
		expect(completionEnabled()).toBe(true);
		for (const v of ["on", "sharp", "auto", "off"]) {
			withFlags({ nearfield: v });
			expect(completionEnabled()).toBe(false);
		}
	});
});

describe("liftToGaussians stays byte-identical unless completion opts are passed", () => {
	const w = 12;
	const h = 8;
	const z = new Float32Array(w * h);
	for (let j = 0; j < h; j++)
		for (let i = 0; i < w; i++) z[j * w + i] = i < 6 ? 4 : 20;
	const depth: NearFieldDepth = {
		width: w,
		height: h,
		depth: z,
		valid: new Uint8Array(w * h).fill(1),
		model: "t",
		seconds: 0,
	};
	const split: SplitResult = {
		width: w,
		height: h,
		cls: new Uint8Array(w * h).fill(PixelClass.Object),
		counts: [0, 0, w * h, 0, 0],
	};
	const photo = {
		width: w,
		height: h,
		data: new Uint8Array(w * h * 4).fill(90),
	};
	const base = liftToGaussians(depth, photo, K, split, {
		stride: 1,
		edgeLog: Number.POSITIVE_INFINITY,
	});
	it("default and explicit-off options give identical clouds", () => {
		const off = liftToGaussians(depth, photo, K, split, {
			stride: 1,
			edgeLog: Number.POSITIVE_INFINITY,
			edgeSnap: false,
			rimAlpha: false,
		});
		expect(off.count).toBe(base.count);
		expect(Array.from(off.positions)).toEqual(Array.from(base.positions));
		expect(Array.from(off.colors)).toEqual(Array.from(base.colors));
	});
	it("edgeSnap changes the cloud only at the depth edge and keeps provenance observed", () => {
		const snap = liftToGaussians(depth, photo, K, split, {
			stride: 1,
			edgeLog: Number.POSITIVE_INFINITY,
			edgeSnap: {},
		});
		expect(snap.count).toBeLessThanOrEqual(base.count);
		expect(snap.provenance.every((p) => p === PROVENANCE_CODE.observed)).toBe(
			true,
		);
	});
});
