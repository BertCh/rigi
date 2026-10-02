// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { normalsFromDepth } from "../compose";

const W = 40;
const H = 30;
const K = { fx: 0.9, fy: 1.2, cx: 0.5, cy: 0.5 };

/** Depth of the plane n · X = d along each pixel ray (camera frame, OpenCV axes). */
function planeDepth(n: [number, number, number], d: number) {
	const depth = new Float32Array(W * H);
	const valid = new Uint8Array(W * H);
	for (let j = 0; j < H; j++)
		for (let i = 0; i < W; i++) {
			const rx = ((i + 0.5) / W - K.cx) / K.fx;
			const ry = ((j + 0.5) / H - K.cy) / K.fy;
			const z = d / (n[0] * rx + n[1] * ry + n[2]);
			depth[j * W + i] = z;
			valid[j * W + i] = z > 0 ? 1 : 0;
		}
	return { depth, valid };
}

describe("normalsFromDepth", () => {
	it("recovers a tilted plane's normal, facing the camera", () => {
		const len = Math.hypot(0.3, -0.5, 1);
		const n: [number, number, number] = [0.3 / len, -0.5 / len, 1 / len];
		const { depth, valid } = planeDepth(n, 10);
		const out = normalsFromDepth(depth, valid, W, H, K);
		for (const k of [0, 5 * W + 7, 15 * W + 20, H * W - 1]) {
			// camera-facing: the plane normal flipped towards the camera (z < 0)
			expect(out[3 * k]).toBeCloseTo(-n[0], 4);
			expect(out[3 * k + 1]).toBeCloseTo(-n[1], 4);
			expect(out[3 * k + 2]).toBeCloseTo(-n[2], 4);
		}
	});

	it("keeps each side's slope at a depth edge and leaves isolated pixels at 0", () => {
		const depth = new Float32Array(W * H).fill(5);
		const valid = new Uint8Array(W * H).fill(1);
		// right half twice as far: a step, both halves fronto-parallel
		for (let j = 0; j < H; j++)
			for (let i = W / 2; i < W; i++) depth[j * W + i] = 10;
		const lone = 3 * W + 3;
		for (const k of [lone - 2, lone + 2, lone - 2 * W, lone + 2 * W])
			valid[k] = 0;
		const out = normalsFromDepth(depth, valid, W, H, K);
		for (const i of [W / 2 - 1, W / 2]) {
			const k = 10 * W + i;
			expect(out[3 * k + 2]).toBeCloseTo(-1, 4);
		}
		expect([out[3 * lone], out[3 * lone + 1], out[3 * lone + 2]]).toEqual([
			0, 0, 0,
		]);
	});
});
