// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import type { Pose } from "../../../camera";
import { intrinsicsFromPose } from "../../geom";
import { camToEnuMatrix } from "../../lift";
import { PixelClass, type SplitResult } from "../../types";
import { diagnoseGroundSlabs, reclassifySlabs } from "../slab";

const pose: Pose = { yaw: 30, pitch: 0, roll: 0, vfov: 60 };
const W = 16;
const H = 16;
const K = intrinsicsFromPose(pose, 1.5);
const m = camToEnuMatrix(pose);
const EYE_H = 1.6;

/** ENU direction of a cell and its ground range for an eye EYE_H above flat ground. */
function ray(i: number, j: number) {
	const cx = ((i + 0.5) / W - K.cx) / K.fx;
	const cy = ((j + 0.5) / H - K.cy) / K.fy;
	const f = Math.sqrt(1 + cx * cx + cy * cy);
	const d = [cx / f, cy / f, 1 / f];
	const up = m[6] * d[0] + m[7] * d[1] + m[8] * d[2];
	return { d, up, ground: up < 0 ? EYE_H / -up : Number.NaN };
}

/** Camera-frame normal for an ENU normal (M is a rotation: n_cam = M^T n_enu). */
const camNormal = (e: number[]) => [
	m[0] * e[0] + m[3] * e[1] + m[6] * e[2],
	m[1] * e[0] + m[4] * e[1] + m[7] * e[2],
	m[2] * e[0] + m[5] * e[1] + m[8] * e[2],
];

function world(
	mutate?: (
		w: { range: Float32Array; normals: Float32Array },
		k: number,
		i: number,
		j: number,
	) => void,
) {
	const cls = new Uint8Array(W * H);
	const dem = new Float32Array(W * H).fill(Number.NaN);
	const range = new Float32Array(W * H).fill(Number.NaN);
	const normals = new Float32Array(3 * W * H);
	for (let j = 0; j < H; j++)
		for (let i = 0; i < W; i++) {
			const k = j * W + i;
			const r = ray(i, j);
			if (!(r.up < 0)) continue;
			cls[k] = PixelClass.Object; // everything below the horizon wrongly Object
			dem[k] = r.ground;
			range[k] = r.ground;
			normals.set(camNormal([0, 0, 1]), 3 * k);
			mutate?.({ range, normals }, k, i, j);
		}
	const split: SplitResult = {
		width: W,
		height: H,
		cls,
		counts: [
			0,
			0,
			cls.reduce((a, c) => a + (c === PixelClass.Object ? 1 : 0), 0),
			0,
			0,
		],
	};
	return { split, dem, range, normals };
}

const diag = (w: ReturnType<typeof world>, extra: object = {}, p = {}) =>
	diagnoseGroundSlabs(
		{
			split: w.split,
			demGrid: w.dem,
			modelRange: w.range,
			normals: w.normals,
			camToEnu: m,
			K,
			...extra,
		},
		p,
	);

describe("diagnoseGroundSlabs", () => {
	it("flags near DEM-consistent up-facing ground and reclassifies it to Terrain", () => {
		const w = world();
		const d = diag(w);
		expect(d.count).toBeGreaterThan(10);
		expect(d.usedNormals).toBe(true);
		// every flagged cell is within maxRange and below the eye
		for (let k = 0; k < W * H; k++)
			if (d.mask[k]) expect(w.range[k]).toBeLessThanOrEqual(40);
		const s = reclassifySlabs(w.split, d.mask);
		expect(s.counts[PixelClass.Terrain]).toBe(d.count);
		expect(s.counts[PixelClass.Object]).toBe(d.objectCount - d.count);
		expect(w.split.cls).not.toBe(s.cls); // input not modified
		expect(w.split.counts[PixelClass.Terrain]).toBe(0);
		expect(d.fraction).toBeCloseTo(d.count / d.objectCount, 6);
	});

	it("does not flag vertical surfaces (a person's torso), floating content, or protected cells", () => {
		const base = diag(world()).count;
		const wall = world((w, k) =>
			w.normals.set(camNormal([Math.cos(0.5), Math.sin(0.5), 0]), 3 * k),
		);
		expect(diag(wall).count).toBe(0);
		// model point 3 m closer than the DEM along the ray = well above the ground
		const floating = world((w, k, i, j) => {
			w.range[k] = ray(i, j).ground - 3;
		});
		expect(diag(floating).count).toBeLessThan(base);
		const w = world();
		const prot = new Uint8Array(W * H).fill(1);
		expect(diag(w, { protect: prot }).count).toBe(0);
	});

	it("flags nothing beyond maxRangeM, and nothing that is not Object", () => {
		const w = world();
		expect(diag(w, {}, { maxRangeM: 0.5 }).count).toBe(0);
		const none = world();
		none.split.cls.fill(PixelClass.Terrain);
		expect(diag(none).count).toBe(0);
	});

	it("falls back to the geometry tests without normals, and is deterministic", () => {
		const w = world();
		const a = diagnoseGroundSlabs({
			split: w.split,
			demGrid: w.dem,
			modelRange: w.range,
			camToEnu: m,
			K,
		});
		expect(a.usedNormals).toBe(false);
		expect(a.count).toBeGreaterThan(0);
		const b = diagnoseGroundSlabs({
			split: w.split,
			demGrid: w.dem,
			modelRange: w.range,
			camToEnu: m,
			K,
		});
		expect(Array.from(b.mask)).toEqual(Array.from(a.mask));
	});
});
