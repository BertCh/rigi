// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import type { Pose } from "../../camera";
import { EnuFrame } from "../../geodesy";
import { intrinsicsFromPose } from "../geom";
import { liftToGaussians, toEnu } from "../lift";
import {
	buildMeasureGrid,
	type MeasurableScene,
	type MeasureContext,
	nearFieldSampleAt,
} from "../measure";
import {
	type GaussianCloud,
	type NearFieldScene,
	PixelClass,
	PROVENANCE_CODE,
} from "../types";

const pose: Pose = { yaw: 40, pitch: 5, roll: 0, vfov: 50 };
const eye = { x: 3, y: -2, z: 12 };
const frame = new EnuFrame(46.7, 8.0, 1000);
const ctx: MeasureContext = { pose, aspect: 1.5, eye, frame };

function scene(splats: GaussianCloud, W: number, H: number, obj: boolean[]) {
	const cls = new Uint8Array(W * H);
	obj.forEach((o, i) => {
		cls[i] = o ? PixelClass.Object : PixelClass.Terrain;
	});
	return {
		photoId: "p",
		anchor: {
			scale: 1,
			shift: 0,
			residualLog: 0,
			inlierFrac: 1,
			n: 1,
			quality: 1,
			maxRange: 100,
		},
		split: { width: W, height: H, cls, counts: [0, 0, 0, 0, 0] },
		splats,
	} as unknown as NearFieldScene;
}

describe("buildMeasureGrid + nearFieldSampleAt", () => {
	// a camera-frame 8x8 plane at 15 m lifted, then placed -> the grid should invert the placement
	const W = 8;
	const H = 8;
	const K = intrinsicsFromPose(pose, 1.5);
	const depth = {
		width: W,
		height: H,
		depth: new Float32Array(W * H).fill(15),
		valid: new Uint8Array(W * H).fill(1),
		model: "t",
		seconds: 0,
	};
	const split = {
		width: W,
		height: H,
		cls: new Uint8Array(W * H).fill(PixelClass.Object),
		counts: [0, 0, 0, 0, 0],
	};
	const photo = {
		width: W,
		height: H,
		data: new Uint8Array(W * H * 4).fill(128),
	};
	const camCloud = liftToGaussians(depth, photo, K, split, {
		stride: 1,
		edgeLog: Number.POSITIVE_INFINITY,
	});
	const enu = toEnu(camCloud, pose, eye);

	it("bins each lifted splat back into its own grid cell with its ENU position", () => {
		const g = buildMeasureGrid(scene(enu, W, H, Array(W * H).fill(true)), ctx);
		expect(g.range.length).toBe(W * H);
		for (let k = 0; k < W * H; k++) {
			expect(g.range[k]).toBeGreaterThan(14);
			expect(g.enu[3 * k]).toBeCloseTo(enu.positions[3 * k], 3);
			expect(g.range[k]).toBeCloseTo(
				Math.hypot(
					enu.positions[3 * k] - eye.x,
					enu.positions[3 * k + 1] - eye.y,
					enu.positions[3 * k + 2] - eye.z,
				),
				3,
			);
		}
	});
	it("keeps the nearest splat per cell and skips generated and behind-camera splats", () => {
		const mk = (pts: number[][], prov: number[]): GaussianCloud => ({
			count: pts.length,
			frame: "enu",
			positions: Float32Array.from(pts.flat()),
			scales: new Float32Array(3 * pts.length).fill(1),
			rotations: Float32Array.from(pts.flatMap(() => [1, 0, 0, 0])),
			colors: new Uint8Array(4 * pts.length),
			provenance: Uint8Array.from(prov),
		});
		const fwd = [
			Math.sin((40 * Math.PI) / 180),
			Math.cos((40 * Math.PI) / 180),
			0,
		];
		const at = (d: number) => [eye.x + fwd[0] * d, eye.y + fwd[1] * d, eye.z];
		const s = mk(
			[at(30), at(10), at(5), at(-10)],
			[
				PROVENANCE_CODE.observed,
				PROVENANCE_CODE.observed,
				PROVENANCE_CODE.generated,
				PROVENANCE_CODE.observed,
			],
		);
		const g = buildMeasureGrid(scene(s, 4, 4, Array(16).fill(true)), ctx);
		const filled = Array.from(g.range).filter((r) => !Number.isNaN(r));
		expect(filled.length).toBe(1);
		// pitch 5 deg: the on-axis points differ in v by an eye-height offset, but both land near the centre
		expect(filled[0]).toBeCloseTo(10, 3);
	});
	it("returns null for non-Object pixels, out-of-range uv and missing scenes", () => {
		const sc = scene(enu, W, H, Array(W * H).fill(true)) as MeasurableScene;
		sc.measure = { ...buildMeasureGrid(sc, ctx), ...ctx };
		const hit = nearFieldSampleAt(sc, 0.5, 0.5);
		expect(hit).not.toBeNull();
		expect(hit?.source).toBe("object");
		expect(hit?.range).toBeGreaterThan(14);
		expect(hit?.lat).toBeCloseTo(46.7, 2);
		expect(hit?.lon).toBeCloseTo(8.0, 2);
		expect(nearFieldSampleAt(sc, -0.1, 0.5)).toBeNull();
		expect(nearFieldSampleAt(sc, 1, 0.5)).toBeNull();
		expect(nearFieldSampleAt(null, 0.5, 0.5)).toBeNull();
		expect(
			nearFieldSampleAt({ ...sc, measure: undefined }, 0.5, 0.5),
		).toBeNull();
		sc.split.cls.fill(PixelClass.Terrain);
		expect(nearFieldSampleAt(sc, 0.5, 0.5)).toBeNull();
	});
	it("falls back to a covered Object cell within two cells", () => {
		const sc = scene(enu, W, H, Array(W * H).fill(true)) as MeasurableScene;
		const g = buildMeasureGrid(sc, ctx);
		const i0 = 4;
		const j0 = 4;
		g.range[j0 * W + i0] = Number.NaN; // hole under the cursor
		sc.measure = { ...g, ...ctx };
		const hit = nearFieldSampleAt(sc, (i0 + 0.5) / W, (j0 + 0.5) / H);
		expect(hit).not.toBeNull();
		// empty everywhere except 3 cells away -> null
		g.range.fill(Number.NaN);
		g.range[j0 * W + 7] = 10;
		expect(nearFieldSampleAt(sc, (i0 + 0.5) / W, (j0 + 0.5) / H)).toBeNull();
	});
});
