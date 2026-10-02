// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { seededRandom } from "#/test/helpers";
import { depthGridSize } from "../client";
import { composeDepth } from "../compose";
import { interpolatePosEmbed, tokenGrid, uvPlanes } from "../depth-net";
import {
	focalShiftSamples,
	intrinsicsFromFocal,
	nearestIndex,
	solveFocalShift,
	viewPlaneUv,
} from "../focal-shift";

/** A MoGe-style affine point map of a tilted plane seen with `focal`, z offset by −shift. */
function syntheticMap(W: number, H: number, focal: number, shift: number) {
	const r = seededRandom(7);
	const points = new Float32Array(3 * W * H);
	const z = new Float32Array(W * H);
	for (let j = 0; j < H; j++)
		for (let i = 0; i < W; i++) {
			const [u, v] = viewPlaneUv(i, j, W, H);
			const depth = 5 + 2 * v + 0.5 * u + 0.01 * r();
			const k = j * W + i;
			points[3 * k] = (u / focal) * depth;
			points[3 * k + 1] = (v / focal) * depth;
			points[3 * k + 2] = depth - shift;
			z[k] = depth - shift;
		}
	return { points, z };
}

function downsample(points: Float32Array, W: number, H: number) {
	const p64 = new Float32Array(64 * 64 * 3);
	for (let y = 0; y < 64; y++)
		for (let x = 0; x < 64; x++) {
			const k = nearestIndex(y, 64, H) * W + nearestIndex(x, 64, W);
			p64.set(points.subarray(3 * k, 3 * k + 3), 3 * (y * 64 + x));
		}
	return p64;
}

describe("MoGe focal / shift recovery", () => {
	it("recovers a synthetic focal and z shift", () => {
		const W = 160;
		const H = 120;
		const { points } = syntheticMap(W, H, 1.3, 1.7);
		const s = focalShiftSamples(
			downsample(points, W, H),
			new Float32Array(4096).fill(1),
			W,
			H,
		);
		expect(s.n).toBe(4096);
		const { focal, shift } = solveFocalShift(s.uv, s.xyz, s.n);
		expect(focal).toBeCloseTo(1.3, 3);
		expect(shift).toBeCloseTo(1.7, 2);
	});

	it("falls back to focal 1, shift 0 without samples", () => {
		expect(
			solveFocalShift(new Float64Array(0), new Float64Array(0), 0),
		).toEqual({
			focal: 1,
			shift: 0,
		});
	});

	it("intrinsics: focal is relative to half the diagonal, centre at 0.5", () => {
		const K = intrinsicsFromFocal(1, 400, 300);
		// focal 1 = the half diagonal (250 px) → fx = 250 / 400, fy = 250 / 300
		expect(K.fx).toBeCloseTo(0.625, 9);
		expect(K.fy).toBeCloseTo(250 / 300, 9);
		expect([K.cx, K.cy]).toEqual([0.5, 0.5]);
	});
});

describe("composeDepth", () => {
	it("metric depth = (z + shift) · scale on the mask; normals zeroed off it", () => {
		const W = 96;
		const H = 64;
		const { points, z } = syntheticMap(W, H, 1.1, 0.8);
		const mask = new Float32Array(W * H).fill(0.9);
		mask[5] = 0.2;
		const normal = new Float32Array(3 * W * H).fill(0.5);
		const d = composeDepth(
			{
				width: W,
				height: H,
				z,
				mask,
				normal,
				points64: downsample(points, W, H),
				mask64: new Float32Array(4096).fill(1),
				metricScale: 3,
			},
			"m",
		);
		expect(d.valid[5]).toBe(0);
		expect(d.depth[5]).toBe(0);
		expect(d.normal?.[15]).toBe(0);
		expect(d.depth[6] / ((z[6] + d.shift) * 3)).toBeCloseTo(1, 6);
		expect(d.depth[6] / 3).toBeCloseTo(z[6] + 0.8, 2);
		expect(d.intrinsicsNorm?.cx).toBe(0.5);
	});
});

describe("depth-net helpers", () => {
	it("token grid follows MoGe's base_h / base_w rounding", () => {
		expect(tokenGrid(1200, 4 / 3)).toEqual([30, 40]);
		expect(tokenGrid(1200, 3 / 4)).toEqual([40, 30]);
	});

	it("uv planes match the view-plane uv", () => {
		const uv = uvPlanes(5, 3, 2);
		const [u, v] = viewPlaneUv(4, 2, 5, 3);
		// viewPlaneUv uses aspect = W / H; with aspect 5/3 for both they agree
		const uv2 = uvPlanes(5, 3, 5 / 3);
		expect(uv2[2 * 5 + 4]).toBeCloseTo(u, 6);
		expect(uv2[15 + 2 * 5 + 4]).toBeCloseTo(v, 6);
		expect(uv.length).toBe(30);
	});

	it("pos-embed bicubic keeps the cls row, is the identity at the native grid, and keeps a constant", () => {
		const M = 4;
		const C = 2;
		const pos = new Float32Array((1 + M * M) * C).map((_, i) => i);
		expect(interpolatePosEmbed(pos, M, C, M, M)).toEqual(pos);
		const flat = new Float32Array((1 + M * M) * C).fill(3);
		flat[0] = 9;
		const out = interpolatePosEmbed(flat, M, C, 3, 5);
		expect(out.length).toBe((1 + 15) * C);
		expect(out[0]).toBe(9);
		for (let i = C; i < out.length; i++) expect(out[i]).toBeCloseTo(3, 5);
	});

	it("depth grid: the service's maxSide rounding", () => {
		expect(depthGridSize(4032, 3024)).toEqual([1024, 768]);
		expect(depthGridSize(800, 600)).toEqual([800, 600]);
	});
});
