// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { seededRandom, uniform } from "#/test/helpers";
import type { Pose } from "../../camera";
import { intrinsicsFromPose } from "../geom";
import {
	camToEnuMatrix,
	liftToGaussians,
	quatFromMatrix,
	type RGBAImage,
	toEnu,
} from "../lift";
import {
	type GaussianCloud,
	type NearFieldDepth,
	PixelClass,
	PROVENANCE_CODE,
	type SplitResult,
} from "../types";

const pose = (yaw: number, pitch = 0, roll = 0, vfov = 60): Pose => ({
	yaw,
	pitch,
	roll,
	vfov,
});

function flatScene(W: number, H: number, z: number, cls = PixelClass.Object) {
	const depth: NearFieldDepth = {
		width: W,
		height: H,
		depth: new Float32Array(W * H).fill(z),
		valid: new Uint8Array(W * H).fill(1),
		model: "t",
		seconds: 0,
	};
	const split: SplitResult = {
		width: W,
		height: H,
		cls: new Uint8Array(W * H).fill(cls),
		counts: [0, 0, 0, 0, 0],
	};
	const photo: RGBAImage = {
		width: W,
		height: H,
		data: new Uint8Array(W * H * 4),
	};
	for (let i = 0; i < W * H; i++) {
		photo.data[4 * i] = 200;
		photo.data[4 * i + 1] = 100;
		photo.data[4 * i + 2] = 50;
		photo.data[4 * i + 3] = 255;
	}
	return { depth, split, photo };
}

const K = intrinsicsFromPose(pose(0, 0, 0, 60), 1);

describe("camToEnuMatrix", () => {
	it("maps camera forward to the heading and camera down to -up (yaw 0 = north)", () => {
		const m = camToEnuMatrix(pose(0));
		// columns: right, -up, forward; row-major
		expect([m[2], m[5], m[8]]).toEqual([0, 1, 0]); // forward = north
		expect(m[0]).toBeCloseTo(1, 12); // right = east
		expect(m[4]).toBeCloseTo(0, 12);
		expect(m[3 * 2 + 1]).toBeCloseTo(-1, 12); // camera y (down) -> -z
	});
	it("is a proper rotation for random poses", () => {
		const r = seededRandom(5);
		for (let i = 0; i < 30; i++) {
			const m = camToEnuMatrix(
				pose(uniform(r, 0, 360), uniform(r, -70, 70), uniform(r, -45, 45)),
			);
			const det =
				m[0] * (m[4] * m[8] - m[5] * m[7]) -
				m[1] * (m[3] * m[8] - m[5] * m[6]) +
				m[2] * (m[3] * m[7] - m[4] * m[6]);
			expect(det).toBeCloseTo(1, 9);
			for (let a = 0; a < 3; a++)
				for (let b = 0; b < 3; b++) {
					const dot = m[a] * m[b] + m[3 + a] * m[3 + b] + m[6 + a] * m[6 + b];
					expect(dot).toBeCloseTo(a === b ? 1 : 0, 9);
				}
		}
	});
});

describe("quatFromMatrix", () => {
	function rotate(q: number[], v: number[]) {
		const [w, x, y, z] = q;
		// v' = q v q*
		const tx = 2 * (y * v[2] - z * v[1]);
		const ty = 2 * (z * v[0] - x * v[2]);
		const tz = 2 * (x * v[1] - y * v[0]);
		return [
			v[0] + w * tx + (y * tz - z * ty),
			v[1] + w * ty + (z * tx - x * tz),
			v[2] + w * tz + (x * ty - y * tx),
		];
	}
	it("is unit length and reproduces the matrix action on every branch", () => {
		const r = seededRandom(11);
		const mats: number[][] = [
			[1, 0, 0, 0, 1, 0, 0, 0, 1],
			[1, 0, 0, 0, -1, 0, 0, 0, -1], // 180 about x (m00 branch)
			[-1, 0, 0, 0, 1, 0, 0, 0, -1], // 180 about y (m11 branch)
			[-1, 0, 0, 0, -1, 0, 0, 0, 1], // 180 about z (m22 branch)
		];
		for (let i = 0; i < 40; i++)
			mats.push(
				camToEnuMatrix(
					pose(uniform(r, 0, 360), uniform(r, -85, 85), uniform(r, -90, 90)),
				),
			);
		for (const m of mats) {
			const q = quatFromMatrix(m);
			expect(Math.hypot(...q)).toBeCloseTo(1, 12);
			for (let c = 0; c < 3; c++) {
				const e = [0, 0, 0];
				e[c] = 1;
				const out = rotate(q, e);
				for (let rI = 0; rI < 3; rI++)
					expect(out[rI]).toBeCloseTo(m[3 * rI + c], 9);
			}
		}
	});
});

describe("liftToGaussians", () => {
	it("lifts a fronto-parallel plane onto z = depth with the right grid layout", () => {
		const { depth, split, photo } = flatScene(8, 8, 10);
		const c = liftToGaussians(depth, photo, K, split, { stride: 2 });
		expect(c.frame).toBe("camera");
		expect(c.count).toBe(16);
		for (let i = 0; i < c.count; i++)
			expect(c.positions[3 * i + 2]).toBeCloseTo(10, 5);
		// x extent: block centres at (k+0.5)/4, tan(30deg) half-width
		const xs = Array.from({ length: c.count }, (_, i) => c.positions[3 * i]);
		const half = 10 * Math.tan(Math.PI / 6);
		expect(Math.max(...xs)).toBeCloseTo(half * 0.75, 4);
		expect(Math.min(...xs)).toBeCloseTo(-half * 0.75, 4);
		expect(Array.from(c.colors.subarray(0, 4))).toEqual([200, 100, 50, 255]);
		expect(Array.from(c.rotations.subarray(0, 4))).toEqual([1, 0, 0, 0]);
		expect(c.scales[0]).toBeGreaterThan(0);
		expect(c.scales[0]).toBe(c.scales[1]);
		expect(c.provenance.every((p) => p === PROVENANCE_CODE.observed)).toBe(
			true,
		);
	});
	it("scales positions by the anchor", () => {
		const { depth, split, photo } = flatScene(8, 8, 10);
		const a = liftToGaussians(depth, photo, K, split, {});
		const b = liftToGaussians(depth, photo, K, split, {
			anchor: { scale: 3, shift: 0 },
		});
		expect(b.count).toBe(a.count);
		expect(b.positions[2]).toBeCloseTo(30, 4);
		expect(b.scales[0]).toBeCloseTo(3 * a.scales[0], 6);
	});
	it("keeps only requested classes", () => {
		const { depth, split, photo } = flatScene(8, 8, 10, PixelClass.Terrain);
		expect(liftToGaussians(depth, photo, K, split).count).toBe(0);
		expect(
			liftToGaussians(depth, photo, K, split, { keep: [PixelClass.Terrain] })
				.count,
		).toBe(16);
	});
	it("drops invalid depth and flying pixels at discontinuities", () => {
		const { depth, split, photo } = flatScene(8, 8, 10);
		depth.valid[3 * 8 + 3] = 0; // block (1,1) centre cell (i=1+... )
		const base = liftToGaussians(depth, photo, K, split, { stride: 2 });
		expect(base.count).toBeLessThan(16);
		const jump = flatScene(8, 8, 10);
		for (let j = 0; j < 8; j++)
			for (let i = 4; i < 8; i++) jump.depth.depth[j * 8 + i] = 40;
		const cut = liftToGaussians(jump.depth, jump.photo, K, jump.split, {
			stride: 2,
		});
		const kept = liftToGaussians(jump.depth, jump.photo, K, jump.split, {
			stride: 2,
			edgeLog: Number.POSITIVE_INFINITY,
		});
		expect(kept.count).toBe(16);
		expect(cut.count).toBeLessThan(16);
		expect(cut.count).toBeGreaterThan(0);
	});
	it("emits unit-quaternion discs facing the normal when normals exist", () => {
		const { depth, split, photo } = flatScene(8, 8, 10);
		const n = new Float32Array(8 * 8 * 3);
		for (let k = 0; k < 64; k++) n[3 * k + 2] = -1; // facing the camera (OpenCV)
		depth.normal = n;
		const c = liftToGaussians(depth, photo, K, split);
		for (let i = 0; i < c.count; i++) {
			expect(
				Math.hypot(...Array.from(c.rotations.subarray(4 * i, 4 * i + 4))),
			).toBeCloseTo(1, 5);
			expect(c.scales[3 * i + 2]).toBeLessThan(c.scales[3 * i]);
		}
		// camera-facing normal -> identity rotation
		expect(c.rotations[0]).toBeCloseTo(1, 5);
	});
	it("averages the photo over each block and honours alpha/provenance", () => {
		const { depth, split, photo } = flatScene(4, 4, 5);
		for (let i = 0; i < 16; i++) {
			const v = i % 2 ? 100 : 0;
			photo.data[4 * i] = v;
		}
		const c = liftToGaussians(depth, photo, K, split, {
			stride: 4,
			alpha: 128,
			provenance: PROVENANCE_CODE.generated,
		});
		expect(c.count).toBe(1);
		expect(c.colors[0]).toBe(50);
		expect(c.colors[3]).toBe(128);
		expect(c.provenance[0]).toBe(PROVENANCE_CODE.generated);
	});
	it("rejects mismatched grids", () => {
		const a = flatScene(4, 4, 5);
		const b = flatScene(8, 8, 5);
		expect(() => liftToGaussians(a.depth, a.photo, K, b.split)).toThrow();
	});
});

describe("toEnu", () => {
	const cam: GaussianCloud = {
		count: 2,
		frame: "camera",
		positions: Float32Array.from([0, 0, 10, 1, 0, 0]),
		scales: Float32Array.from([1, 1, 1, 2, 2, 2]),
		rotations: Float32Array.from([1, 0, 0, 0, 1, 0, 0, 0]),
		colors: Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]),
		provenance: Uint8Array.from([0, 1]),
		source: Uint16Array.from([3, 4]),
	};
	it("places a forward point along the heading from the eye", () => {
		const e = toEnu(cam, pose(90), { x: 100, y: 200, z: 30 });
		expect(e.frame).toBe("enu");
		// yaw 90 = east
		expect(e.positions[0]).toBeCloseTo(110, 4);
		expect(e.positions[1]).toBeCloseTo(200, 4);
		expect(e.positions[2]).toBeCloseTo(30, 4);
		// camera +x (right) at yaw 90 = south
		expect(e.positions[3]).toBeCloseTo(100, 4);
		expect(e.positions[4]).toBeCloseTo(199, 4);
	});
	it("accepts array eyes, copies attributes and is a no-op for ENU clouds", () => {
		const e = toEnu(cam, pose(0), [1, 2, 3]);
		expect(Array.from(e.source ?? [])).toEqual([3, 4]);
		expect(Array.from(e.colors)).toEqual(Array.from(cam.colors));
		expect(e.scales).not.toBe(cam.scales);
		expect(toEnu(e, pose(10), [0, 0, 0])).toBe(e);
	});
	it("rotated quaternions stay unit and encode the pose rotation", () => {
		const r = seededRandom(2);
		for (let i = 0; i < 10; i++) {
			const p = pose(
				uniform(r, 0, 360),
				uniform(r, -60, 60),
				uniform(r, -30, 30),
			);
			const e = toEnu(cam, p, [0, 0, 0]);
			expect(Math.hypot(...Array.from(e.rotations.subarray(0, 4)))).toBeCloseTo(
				1,
				5,
			);
			// identity camera rotation -> pose quaternion = quatFromMatrix(M) up to sign
			const q = quatFromMatrix(camToEnuMatrix(p));
			const dot = Math.abs(
				q[0] * e.rotations[0] +
					q[1] * e.rotations[1] +
					q[2] * e.rotations[2] +
					q[3] * e.rotations[3],
			);
			expect(dot).toBeCloseTo(1, 5);
		}
	});
});
