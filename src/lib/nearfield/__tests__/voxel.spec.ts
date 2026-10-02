// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { concatClouds, inPlaneStd, voxelMerge } from "../roll/voxel";
import type { GaussianCloud } from "../types";

function cloud(
	pts: [number, number, number][],
	std = 0.05,
	opts: { frame?: "enu" | "camera"; source?: number } = {},
): GaussianCloud {
	const n = pts.length;
	return {
		count: n,
		frame: opts.frame ?? "enu",
		positions: Float32Array.from(pts.flat()),
		scales: new Float32Array(3 * n).fill(std),
		rotations: Float32Array.from(pts.flatMap(() => [1, 0, 0, 0])),
		colors: new Uint8Array(4 * n).fill(255),
		provenance: new Uint8Array(n),
		...(opts.source != null
			? { source: new Uint16Array(n).fill(opts.source) }
			: {}),
	};
}

describe("inPlaneStd", () => {
	it("is the middle scale", () => {
		expect(inPlaneStd([3, 1, 2], 0)).toBe(2);
		expect(inPlaneStd([0.1, 0.1, 0.01, 5, 4, 9], 1)).toBe(5);
		expect(inPlaneStd([2, 2, 2], 0)).toBe(2);
	});
});

describe("concatClouds", () => {
	it("concatenates and tags sources by index, explicit sources or own source", () => {
		const a = cloud([[0, 0, 0]]);
		const b = cloud([
			[1, 1, 1],
			[2, 2, 2],
		]);
		const c = concatClouds([a, b]);
		expect(c.count).toBe(3);
		expect(Array.from(c.positions)).toEqual([0, 0, 0, 1, 1, 1, 2, 2, 2]);
		expect(Array.from(c.source ?? [])).toEqual([0, 1, 1]);
		expect(Array.from(concatClouds([a, b], [7, 9]).source ?? [])).toEqual([
			7, 9, 9,
		]);
		const owned = concatClouds([cloud([[0, 0, 0]], 0.1, { source: 4 }), b]);
		expect(Array.from(owned.source ?? [])).toEqual([4, 1, 1]);
	});
	it("handles empty input", () => {
		expect(concatClouds([]).count).toBe(0);
		expect(concatClouds([cloud([])]).frame).toBe("enu");
	});
});

describe("voxelMerge", () => {
	it("keeps everything for a single source (no cross-source suppression)", () => {
		const pts: [number, number, number][] = [];
		for (let i = 0; i < 50; i++) pts.push([0.001 * i, 0, 0]);
		const { cloud: out, stats } = voxelMerge([cloud(pts)]);
		expect(out.count).toBe(50);
		expect(stats.dropped).toBe(0);
	});
	it("drops a duplicate observation from a second source", () => {
		const pts: [number, number, number][] = [
			[1, 1, 1],
			[2, 1, 1],
			[3, 1, 1],
		];
		const a = cloud(pts);
		const b = cloud(pts);
		const { cloud: out, stats } = voxelMerge([a, b], { dropAt: 0.5 });
		expect(stats.input).toBe(6);
		expect(out.count).toBe(3);
		// the first source wins ties (input order)
		expect(Array.from(out.source ?? [])).toEqual([0, 0, 0]);
		expect(stats.perSource[0].kept).toBe(3);
		expect(stats.perSource[1].kept).toBe(0);
		expect(stats.perSource[1].input).toBe(3);
	});
	it("keeps the finer (closer) observation over a coarse one", () => {
		const fine = cloud([[1, 1, 1]], 0.03);
		const coarse = cloud([[1, 1, 1]], 0.39);
		const { cloud: out } = voxelMerge([coarse, fine]);
		expect(out.count).toBe(2); // coarse is visited later and fine only covers its own cell + coarser (1/4^k)
		const merged = voxelMerge([coarse, fine], { dropAt: 0.01 });
		expect(merged.cloud.count).toBe(1);
		expect(merged.cloud.scales[0]).toBeCloseTo(0.03, 6);
	});
	it("keeps disjoint observations from different sources", () => {
		const a = cloud([[0, 0, 0]]);
		const b = cloud([[50, 0, 0]]);
		expect(voxelMerge([a, b]).cloud.count).toBe(2);
	});
	it("output preserves input order and is deterministic", () => {
		const pts: [number, number, number][] = [];
		for (let i = 0; i < 20; i++) pts.push([i, 0, 0]);
		const r1 = voxelMerge([cloud(pts), cloud(pts)]);
		const r2 = voxelMerge([cloud(pts), cloud(pts)]);
		expect(Array.from(r1.cloud.positions)).toEqual(
			Array.from(r2.cloud.positions),
		);
		const xs = Array.from(r1.cloud.positions).filter((_, i) => i % 3 === 0);
		expect(xs).toEqual([...xs].sort((p, q) => p - q));
	});
	it("rejects camera-frame clouds", () => {
		expect(() =>
			voxelMerge([cloud([[0, 0, 0]], 0.05, { frame: "camera" })]),
		).toThrow(/ENU/);
	});
	it("handles no clouds", () => {
		const { cloud: out, stats } = voxelMerge([]);
		expect(out.count).toBe(0);
		expect(stats.kept).toBe(0);
	});
});
