// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { CpuNn } from "#/lib/nn";
import {
	patchNodes,
	sddhCorners,
	softArgmax,
	toPaddedGrid,
	windowIndices,
} from "../dkd";
import {
	createDkdTables,
	patchGridNn,
	sddhCornersNn,
	softArgmaxNn,
} from "../dkd-nn";

const nn = new CpuNn();
const H = 14;
const W = 17;
const P = 4;
const pads = { left: 3, top: 2, paddedWidth: W + 8, paddedHeight: H + 6 };

function lcg(seed: number) {
	let s = seed;
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 2 ** 32;
	};
}

function setup() {
	const rand = lcg(7);
	const score = Float32Array.from({ length: H * W }, () => rand());
	// interior points (>= 2 px from the border) plus border points that only the garbage slots hit
	const flat = [
		4 * W + 5,
		7 * W + 8,
		2 * W + 2,
		(H - 3) * W + (W - 3),
		0,
		H * W - 1,
	];
	return { score, flat: Float32Array.from(flat), count: 4 };
}

describe("dkd-nn (ALIKED soft-argmax and SDDH math as nn ops)", () => {
	it("softArgmaxNn matches dkd.softArgmax", async () => {
		const { score, flat, count } = setup();
		const t = createDkdTables(nn);
		const got = softArgmaxNn(
			nn,
			t,
			nn.fromArray(score, [H * W]),
			nn.fromArray(flat, [flat.length]),
			W,
		);
		const wi = windowIndices(flat, count, W);
		const ref = softArgmax(
			Float32Array.from(wi, (idx) => score[idx]),
			flat,
			count,
			W,
		);
		const [x, y, s] = await Promise.all([
			nn.read(got.x),
			nn.read(got.y),
			nn.read(got.score),
		]);
		for (let i = 0; i < count; i++) {
			expect(x[i]).toBeCloseTo(ref.keypoints[2 * i], 4);
			expect(y[i]).toBeCloseTo(ref.keypoints[2 * i + 1], 4);
			expect(s[i]).toBeCloseTo(ref.scores[i], 5);
		}
		// garbage slots (border / corner pixels) stay finite
		for (const v of [...x, ...y, ...s]) expect(Number.isFinite(v)).toBe(true);
	});

	it("patchGridNn matches patchNodes + toPaddedGrid", async () => {
		const t = createDkdTables(nn);
		const kp = Float32Array.of(
			0.4,
			0.2,
			5.7,
			6.2,
			16.3,
			13.9,
			8.5,
			2.1,
			-0.6,
			3,
		);
		const n = kp.length / 2;
		const x = nn.fromArray(
			Float32Array.from({ length: n }, (_, i) => kp[2 * i]),
			[n, 1],
		);
		const y = nn.fromArray(
			Float32Array.from({ length: n }, (_, i) => kp[2 * i + 1]),
			[n, 1],
		);
		const got = await nn.read(patchGridNn(nn, t, x, y, H, W, pads));
		const ref = toPaddedGrid(
			patchNodes(kp, n, H, W),
			pads.left,
			pads.top,
			pads.paddedWidth,
			pads.paddedHeight,
		);
		expect(got.length).toBe(ref.length);
		for (let i = 0; i < ref.length; i++) expect(got[i]).toBeCloseTo(ref[i], 5);
	});

	it("sddhCornersNn matches sddhCorners + toPaddedGrid, including corners outside the map", async () => {
		const rand = lcg(11);
		const n = 5;
		const kp = Float32Array.from({ length: 2 * n }, (_, i) =>
			i % 2 ? rand() * H : rand() * W,
		);
		kp[0] = 0.3; // offsets will push samples across the border
		kp[1] = 0.2;
		const offsets = Float32Array.from(
			{ length: n * 2 * P },
			() => (rand() - 0.5) * 6,
		);
		const x = nn.fromArray(
			Float32Array.from({ length: n }, (_, i) => kp[2 * i]),
			[n, 1],
		);
		const y = nn.fromArray(
			Float32Array.from({ length: n }, (_, i) => kp[2 * i + 1]),
			[n, 1],
		);
		const got = sddhCornersNn(
			nn,
			x,
			y,
			nn.fromArray(offsets, [n, 2 * P]),
			P,
			H,
			W,
			pads,
		);
		const ref = sddhCorners(kp, offsets, n, P, H, W);
		const refGrid = toPaddedGrid(
			ref.nodes,
			pads.left,
			pads.top,
			pads.paddedWidth,
			pads.paddedHeight,
		);
		const [grid, weights] = await Promise.all([
			nn.read(got.grid),
			nn.read(got.weights),
		]);
		expect(got.grid.shape).toEqual([1, n, P * 4, 2]);
		for (let i = 0; i < refGrid.length; i++)
			expect(grid[i]).toBeCloseTo(refGrid[i], 5);
		for (let i = 0; i < ref.weights.length; i++)
			expect(weights[i]).toBeCloseTo(ref.weights[i], 5);
		expect(ref.weights.some((v) => v === 0)).toBe(true);
	});
});
