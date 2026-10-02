// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import {
	borderMask,
	countAbove,
	patchNodes,
	sddhCorners,
	softArgmax,
	toPaddedGrid,
	windowIndices,
} from "../dkd";
import { compactMatches } from "../index";
import {
	confidenceThreshold,
	filterMatches,
	normalizeKeypoints,
	positionalEncoding,
} from "../lightglue";
import {
	antialiasKernel,
	padTo32,
	resizedSize,
	rgbaToPlanes,
} from "../preprocess";

describe("preprocess (lightglue / kornia sizes)", () => {
	it("resizes the long side with Python int() truncation", () => {
		expect(resizedSize(2048, 1536, 1024)).toEqual([768, 1024]);
		expect(resizedSize(1536, 2048, 1024)).toEqual([1024, 768]);
		expect(resizedSize(1000, 333, 1024)).toEqual([340, 1024]); // int(1024 / 3.003) = 340
		expect(resizedSize(500, 500, 1024)).toEqual([1024, 1024]);
	});
	it("builds kornia's odd, normalised antialias kernel", () => {
		const k = antialiasKernel(2); // sigma 0.5, size max(int(2), 3) = 3
		const e = Math.exp(-2);
		expect(k.length).toBe(3);
		expect(k[0]).toBeCloseTo(e / (1 + 2 * e), 6);
		expect(k[1]).toBeCloseTo(1 / (1 + 2 * e), 6);
		const big = antialiasKernel(4); // sigma 1.5, int(6) = 6 → 7
		expect(big.length).toBe(7);
		expect(big.reduce((s, v) => s + v, 0)).toBeCloseTo(1, 6);
	});
	it("pads to a multiple of 32 like ALIKED's InputPadder", () => {
		expect(padTo32(768, 1024)).toEqual([0, 0, 0, 0]);
		expect(padTo32(100, 50)).toEqual([7, 7, 14, 14]);
		expect(padTo32(33, 31)).toEqual([0, 1, 15, 16]);
	});
	it("converts RGBA bytes to planar RGB in [0, 1]", () => {
		const p = rgbaToPlanes({
			data: new Uint8Array([255, 0, 51, 9, 0, 255, 102, 9]),
			width: 2,
			height: 1,
		});
		[1, 0, 0, 1, 0.2, 0.4].forEach((v, i) => {
			expect(p[i]).toBeCloseTo(v, 6);
		});
	});
});

describe("DKD helpers", () => {
	it("masks a radius-2 border", () => {
		const m = borderMask(6, 7);
		expect(m.reduce((s, v) => s + v, 0)).toBe(2 * 3);
		expect(m[2 * 7 + 2]).toBe(1);
		expect(m[2 * 7 + 1]).toBe(0);
		expect(m[3 * 7 + 4]).toBe(1);
		expect(m[3 * 7 + 5]).toBe(0);
	});
	it("counts the prefix above the threshold, with the mean fallback", () => {
		const v = new Float32Array([0.5, 0.2, 0.01, 0]);
		expect(countAbove(v, 0.01).count).toBe(2);
		expect(countAbove(new Float32Array([0.005, 0.002, 0]), 0.01).count).toBe(0);
		expect(
			countAbove(new Float32Array([0.005, 0.002, 0]), 0.01, () => 0.001),
		).toEqual({ count: 2, threshold: 0.001 });
	});
	it("refines a symmetric peak to its pixel and a shifted one sub-pixel", () => {
		const width = 10;
		const flat = [3 * width + 4];
		const sym = new Float32Array(25).fill(0);
		sym[12] = 1;
		const a = softArgmax(sym, flat, 1, width);
		expect(a.keypoints[0]).toBeCloseTo(4, 6);
		expect(a.keypoints[1]).toBeCloseTo(3, 6);
		expect(a.scores[0]).toBeCloseTo(1, 6);
		// equal mass at the centre and one to the right: x moves half a pixel
		const two = new Float32Array(25).fill(-10);
		two[12] = 1;
		two[13] = 1;
		const b = softArgmax(two, flat, 1, width);
		expect(b.keypoints[0]).toBeCloseTo(4.5, 5);
		expect(b.keypoints[1]).toBeCloseTo(3, 5);
		expect(b.scores[0]).toBeCloseTo(1, 5);
	});
	it("lists 5×5 window indices row-major", () => {
		const w = windowIndices([2 * 8 + 3], 1, 8);
		expect(w[0]).toBe(0 * 8 + 1);
		expect(w[12]).toBe(2 * 8 + 3);
		expect(w[24]).toBe(4 * 8 + 5);
	});
	it("places SDDH patch corners like get_patches (trunc, clamp to size − 4)", () => {
		const kp = new Float32Array([0.3, 0.7, 10.2, 5.9, 19.5, 19.9]);
		const n = patchNodes(kp, 3, 20, 20);
		expect([n[0], n[1]]).toEqual([0, 0]);
		expect([n[18], n[19]]).toEqual([9, 4]);
		expect([n[36], n[37]]).toEqual([16, 16]);
		// last node of the first patch: row 2, column 2
		expect([n[16], n[17]]).toEqual([2, 2]);
	});
	it("splits SDDH samples into weighted integer corners, zero outside the map", () => {
		// one keypoint at (1, 1), two samples: (+0.25, +0.5) inside, (−1.5, 0) half outside
		const c = sddhCorners(
			new Float32Array([1, 1]),
			new Float32Array([0.25, -1.5, 0.5, 0]),
			1,
			2,
			4,
			4,
		);
		expect(Array.from(c.nodes.subarray(0, 8))).toEqual([
			1, 1, 2, 1, 1, 2, 2, 2,
		]);
		expect(Array.from(c.weights.subarray(0, 4))).toEqual([
			0.75 * 0.5,
			0.25 * 0.5,
			0.75 * 0.5,
			0.25 * 0.5,
		]);
		// x = −0.5: corner x = −1 is outside (weight 0), x = 0 keeps 0.5
		expect(Array.from(c.weights.subarray(4, 8))).toEqual([0, 0.5, 0, 0]);
		const sum = c.weights.subarray(0, 4).reduce((s, v) => s + v, 0);
		expect(sum).toBeCloseTo(1, 6);
	});
	it("maps unpadded pixels to align-corners grid coordinates of the padded map", () => {
		const g = toPaddedGrid(new Float32Array([0, 0, 9, 4]), 1, 0, 11, 5);
		const want = [-0.8, -1, 1, 1];
		want.forEach((v, i) => {
			expect(g[i]).toBeCloseTo(v, 6);
		});
	});
});

describe("LightGlue helpers", () => {
	it("uses lightglue's confidence thresholds", () => {
		expect(confidenceThreshold(0)).toBeCloseTo(0.9, 12);
		expect(confidenceThreshold(8)).toBeCloseTo(
			0.8 + 0.1 * Math.exp(-32 / 9),
			12,
		);
	});
	it("normalises keypoints by the long side about the centre", () => {
		const k = normalizeKeypoints(
			new Float32Array([100, 50, 0, 0]),
			2,
			200,
			100,
		);
		expect(Array.from(k)).toEqual([0, 0, -1, -0.5]);
	});
	it("repeats each Fourier feature twice (interleaved)", () => {
		const wr = new Float32Array([1, 0, 0, 2]); // two frequencies
		const e = positionalEncoding(new Float32Array([0.5, 0.25]), 1, wr);
		expect(e.cos.length).toBe(4);
		expect(e.cos[0]).toBeCloseTo(Math.cos(0.5), 6);
		expect(e.cos[1]).toBeCloseTo(Math.cos(0.5), 6);
		expect(e.sin[2]).toBeCloseTo(Math.sin(0.5), 6);
		expect(e.sin[3]).toBeCloseTo(Math.sin(0.5), 6);
	});
	it("keeps only mutual nearest neighbours above the threshold", () => {
		// rows 0,1,2 → cols 1,0,0; cols 0,1 → rows 1,0
		const f = filterMatches(
			new Float32Array([Math.log(0.9), Math.log(0.05), Math.log(0.8)]),
			[1, 0, 0],
			[1, 0],
			0.1,
		);
		expect(Array.from(f.matches0)).toEqual([1, -1, -1]);
		expect(Array.from(f.matches1)).toEqual([-1, 0]);
		expect(f.scores0[1]).toBeCloseTo(0.05, 6); // mutual but under the threshold: scored, unmatched
		expect(f.scores0[2]).toBe(0); // not mutual
	});
	it("compacts matches0 into index pairs", () => {
		const m = compactMatches(
			new Int32Array([-1, 3, -1, 0]),
			new Float32Array([0, 0.5, 0, 0.7]),
		);
		expect(m.count).toBe(2);
		expect(Array.from(m.indices0)).toEqual([1, 3]);
		expect(Array.from(m.indices1)).toEqual([3, 0]);
		expect(Array.from(m.scores)).toEqual([0.5, Math.fround(0.7)]);
	});
});
