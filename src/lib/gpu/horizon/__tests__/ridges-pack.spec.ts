// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import type { Mosaic } from "#/lib/horizon-fast/mosaic";
import { packRidgeMarch, type RidgeMarch } from "../ridges";
import { RIDGES_U } from "../uniforms";

const mosaic = (over: Partial<Mosaic>): Mosaic =>
	({
		z: 10,
		tileSize: 256,
		worldPx: 2 ** 10 * 256,
		x0: 100,
		y0: 200,
		width: 64,
		height: 32,
		data: new Float32Array(0),
		minDistance: 0,
		maxDistance: 5000,
		...over,
	}) as Mosaic;

const mosaics = [
	mosaic({ maxDistance: 5000 }),
	mosaic({ maxDistance: 20000, z: 8, worldPx: 2 ** 8 * 256, width: 16 }),
];
const pageOf = [
	{ page: 0, dataOff: 0 },
	{ page: 1, dataOff: 4096 },
];
const march: RidgeMarch = {
	eye: { lat: 46.7, lon: 8.1, h: 1500.123 },
	cols: 4,
	step: 90,
	inv2R: 6.2e-8,
	slabs: 3,
	dists: [1000, 4000, 6000, 15000],
	slabOf: [0, 0, 1, 2],
};

describe("packRidgeMarch", () => {
	const { params, uniform } = packRidgeMarch(mosaics, pageOf, march);
	const u32 = new Uint32Array(params);
	const f32 = new Float32Array(params);
	const U = (k: Parameters<typeof RIDGES_U.offsetOf>[0]) =>
		new Uint32Array(uniform)[RIDGES_U.offsetOf(k)];

	it("sizes the params as rings + 2/col + 4/dist + 2/slab words", () => {
		expect(params.byteLength / 4).toBe(12 * 2 + 2 * 4 + 4 * 4 + 2 * 3);
		expect(U("ringOff")).toBe(0);
		expect(U("azOff")).toBe(24);
		expect(U("distOff")).toBe(32);
		expect(U("slabOff")).toBe(48);
		expect(U("nRings")).toBe(2);
		expect(U("nDist")).toBe(4);
	});
	it("writes ring page, offset and size", () => {
		expect(Array.from(u32.slice(0, 4))).toEqual([0, 0, 64, 32]);
		expect(Array.from(u32.slice(12, 16))).toEqual([1, 4096, 16, 32]);
		expect(f32[4]).toBe(2 ** 10 * 256);
	});
	it("splits the eye pixel position into integer + fraction", () => {
		const i32 = new Int32Array(params);
		const lon = 8.1;
		const bx = (lon * (Math.PI / 180) + Math.PI) / (2 * Math.PI);
		const u = bx * mosaics[0].worldPx - (100 + 0.5);
		expect(i32[5]).toBe(Math.floor(u));
		expect(f32[6]).toBeCloseTo(u - Math.floor(u), 4);
		expect(f32[6]).toBeGreaterThanOrEqual(0);
		expect(f32[6]).toBeLessThan(1);
	});
	it("azimuth table holds sin/cos of col * step", () => {
		const az = 24;
		for (let c = 0; c < 4; c++) {
			const a = ((c * 90) / 180) * Math.PI;
			expect(f32[az + 2 * c]).toBeCloseTo(Math.sin(a), 6);
			expect(f32[az + 2 * c + 1]).toBeCloseTo(Math.cos(a), 6);
		}
	});
	it("assigns each distance to the first ring that reaches it", () => {
		const ring = (i: number) => u32[32 + 4 * i + 3];
		expect([0, 1, 2, 3].map(ring)).toEqual([0, 0, 1, 1]);
		expect(f32[32]).toBe(1000);
		const D = 4000 / 6371000;
		expect(f32[32 + 4 + 1]).toBeCloseTo(Math.sin(D), 6);
		expect(f32[32 + 4 + 2]).toBeCloseTo(1 - Math.cos(D), 10);
	});
	it("slab table holds [lo, hi) distance ranges", () => {
		const s = (k: number) => [u32[48 + 2 * k], u32[48 + 2 * k + 1]];
		expect(s(0)).toEqual([0, 2]);
		expect(s(1)).toEqual([2, 3]);
		expect(s(2)).toEqual([3, 4]);
	});
	it("an empty slab gets an empty range", () => {
		const m2 = { ...march, slabs: 3, slabOf: [0, 0, 2, 2] };
		const p = new Uint32Array(packRidgeMarch(mosaics, pageOf, m2).params);
		expect([p[50], p[51]]).toEqual([2, 2]);
	});
});
