// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { fitAnchor } from "../anchor";
import { detectCliffLip, maskCliffRange } from "../cliff-lip";
import { gridDemRange, sampleDemGrid } from "../geom";
import type { NearFieldDepth } from "../types";

const K = { fx: 1e6, fy: 1e6, cx: 0.5, cy: 0.5 };
const W = 64;
const H = 64;

/** Meadow: ground range 20 m at the bottom row growing geometrically to 600 m at the horizon row. */
const meadowRange = (row: number) => 20 * 30 ** (1 - row / (H - 1));

function depthFrom(
	rangeOfRow: (j: number) => number,
	scale = 1,
): NearFieldDepth {
	const depth = new Float32Array(W * H);
	for (let j = 0; j < H; j++)
		for (let i = 0; i < W; i++) depth[j * W + i] = rangeOfRow(j) * scale;
	return {
		width: W,
		height: H,
		depth,
		valid: new Uint8Array(W * H).fill(1),
		model: "t",
		seconds: 0,
	};
}
const gridOf = (rangeOfRow: (j: number) => number) => {
	const g = new Float32Array(W * H);
	for (let j = 0; j < H; j++)
		for (let i = 0; i < W; i++) g[j * W + i] = rangeOfRow(j);
	return g;
};
const rangeFn =
	(rangeOfRow: (j: number) => number) => (_u: number, v: number) =>
		rangeOfRow(Math.min(H - 1, Math.floor(v * H)));

/** Cliff: rows 0-39 see the far valley (800 m); below the lip at row 40 the DEM floor is 30-60 m away. */
const cliffRange = (j: number) => (j < 40 ? 800 : 30 + (j - 40) * 1.3);
/** The depth model: the valley matches, but the ledge below the lip is much nearer than the DEM floor. */
const cliffModel = (j: number) => (j < 40 ? 800 : 8 + (j - 40) * 0.3);

describe("detectCliffLip", () => {
	it("finds nothing on a smooth meadow (empty mask)", () => {
		const r = detectCliffLip(gridOf(meadowRange), W, H);
		expect(r.detected).toBe(false);
		expect(r.excludedCells).toBe(0);
		expect(r.mask.every((m) => m === 0)).toBe(true);
	});
	it("finds the lip and shadows the rows below it", () => {
		const r = detectCliffLip(gridOf(cliffRange), W, H);
		expect(r.detected).toBe(true);
		expect(r.mask[39 * W + 10]).toBe(1);
		expect(r.mask[41 * W + 10]).toBe(1);
		expect(r.mask[5 * W + 10]).toBe(0);
		expect(r.mask[63 * W + 10]).toBe(0);
	});
	it("ignores sideways-only jumps with no far-to-near step going down (a pole, not a lip)", () => {
		const g = gridOf(meadowRange);
		for (let j = 0; j < H; j++) for (let i = 30; i < 34; i++) g[j * W + i] *= 4;
		const r = detectCliffLip(g, W, H, { minJumpFrac: 0.001 });
		expect(r.jumpCells).toBeGreaterThan(0);
		expect(r.detected).toBe(false);
	});
	it("gives up when the recipe would exclude most of the photo", () => {
		const g = new Float32Array(W * H);
		for (let k = 0; k < W * H; k++) g[k] = k % 2 ? 20 : 400;
		expect(detectCliffLip(g, W, H).detected).toBe(false);
	});
	it("handles an empty grid", () => {
		const g = new Float32Array(W * H).fill(Number.NaN);
		expect(detectCliffLip(g, W, H).detected).toBe(false);
	});
});

describe("maskCliffRange", () => {
	it("returns the same function when no cliff was detected", () => {
		const f = rangeFn(meadowRange);
		const none = detectCliffLip(gridOf(meadowRange), W, H);
		expect(maskCliffRange(f, none, W, H)).toBe(f);
	});
	it("answers null on excluded cells only", () => {
		const f = rangeFn(cliffRange);
		const cliff = detectCliffLip(gridOf(cliffRange), W, H);
		const m = maskCliffRange(f, cliff, W, H);
		expect(m(0.5, 41.5 / H)).toBeNull();
		expect(m(0.5, 5.5 / H)).toBe(800);
	});
});

describe("fitAnchor cliffLip", () => {
	it("is byte-identical to the default on a flat meadow", () => {
		const depth = depthFrom(meadowRange, 0.9);
		const f = rangeFn(meadowRange);
		const base = fitAnchor(depth, f, K);
		const on = fitAnchor(depth, f, K, { cliffLip: true });
		expect(JSON.stringify(on)).toBe(JSON.stringify(base));
		expect(base.quality).toBeGreaterThan(0.5);
	});
	it("is the default when the option is absent even on a cliff", () => {
		const depth = depthFrom(cliffModel);
		const a = fitAnchor(depth, rangeFn(cliffRange), K);
		const b = fitAnchor(depth, rangeFn(cliffRange), K, { cliffLip: undefined });
		expect(JSON.stringify(a)).toBe(JSON.stringify(b));
	});
	it("recovers a sane anchor on the cliff-lip profile that the plain fit does worse on", () => {
		const depth = depthFrom(cliffModel);
		const f = rangeFn(cliffRange);
		const plain = fitAnchor(depth, f, K);
		const lip = fitAnchor(depth, f, K, { cliffLip: true });
		expect(lip.quality).toBeGreaterThan(plain.quality);
		expect(lip.quality).toBeGreaterThan(0.5);
		expect(lip.n).toBeLessThan(plain.n);
	});
});

describe("grid helpers stay in agreement", () => {
	it("gridDemRange over sampleDemGrid reproduces the range function per cell", () => {
		const f = rangeFn(cliffRange);
		const dem = gridDemRange(sampleDemGrid(W, H, f), W, H);
		expect(dem(0.3, 0.9)).toBeCloseTo(f(0.3, 0.9) ?? 0, 4);
	});
});
