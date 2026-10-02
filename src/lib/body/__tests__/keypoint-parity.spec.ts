// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import {
	compareHeatmaps,
	percentile,
	summarizeParity,
} from "../keypoint-parity";

const H = 64;
const W = 48;
/** One keypoint: a Gaussian bump (peak `amp`) centred on (cx, cy). */
function bump(cx: number, cy: number, amp = 1): Float32Array {
	const hm = new Float32Array(H * W);
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++)
			hm[y * W + x] =
				amp * Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (2 * 1.5 ** 2));
	return hm;
}

describe("percentile", () => {
	it("interpolates and handles empty input", () => {
		expect(percentile([4, 1, 3, 2], 0.5)).toBeCloseTo(2.5);
		expect(percentile([1, 2, 3], 1)).toBe(3);
		expect(percentile([1, 2, 3], 0)).toBe(1);
		expect(percentile([], 0.5)).toBeNaN();
	});
});

describe("compareHeatmaps", () => {
	it("is zero for identical heatmaps", () => {
		const a = bump(20, 30);
		const [d] = compareHeatmaps(a, a, 1);
		expect(d.errPx).toBeCloseTo(0, 6);
		expect(d.scoreDelta).toBe(0);
		expect(d.argmaxMoved).toBe(false);
	});
	it("reports a one-cell shift in input-frame pixels and flags the argmax move", () => {
		const [d] = compareHeatmaps(bump(20, 30), bump(21, 30), 1);
		// one heatmap cell is (192 - 1) / (48 - 1) input pixels in x
		expect(d.errPx).toBeGreaterThan(3.5);
		expect(d.errPx).toBeLessThan(4.6);
		expect(d.argmaxMoved).toBe(true);
	});
	it("reports the peak change", () => {
		const [d] = compareHeatmaps(bump(20, 30, 1), bump(20, 30, 0.9), 1);
		expect(d.scoreDelta).toBeCloseTo(0.1, 5);
		expect(d.scoreA).toBeCloseTo(1, 5);
		expect(d.argmaxMoved).toBe(false);
	});
});

describe("summarizeParity", () => {
	it("aggregates", () => {
		const s = summarizeParity([
			{ errPx: 0, scoreDelta: 0, scoreA: 1, argmaxMoved: false },
			{ errPx: 1, scoreDelta: 0.1, scoreA: 1, argmaxMoved: false },
			{ errPx: 5, scoreDelta: 0.2, scoreA: 1, argmaxMoved: true },
		]);
		expect(s.count).toBe(3);
		expect(s.errMedian).toBe(1);
		expect(s.errMax).toBe(5);
		expect(s.argmaxMovedFraction).toBeCloseTo(1 / 3);
		expect(s.scoreDeltaMax).toBeCloseTo(0.2);
	});
});
