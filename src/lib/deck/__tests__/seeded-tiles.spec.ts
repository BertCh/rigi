// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it, vi } from "vitest";
import {
	seededTileLoader,
	sharedSeed,
	streamTileNeed,
} from "#/lib/deck/seeded-tiles";
import type { DemRaster } from "#/lib/dem/load";

const key = { z: 12, x: 2133, y: 1432 };
const id = "12/2133/1432";
const raster = (size: number, f = (i: number) => i): DemRaster => ({
	key,
	source: key,
	size,
	heights: Float32Array.from({ length: size * size }, (_, i) => f(i)),
});
const opts = {} as never;

describe("streamTileNeed", () => {
	it("keeps 512 only for seg 256", () => {
		expect(streamTileNeed(256)).toBe(512);
		expect(streamTileNeed(128)).toBe(256);
		expect(streamTileNeed(64)).toBe(256);
	});
});

describe("seededTileLoader", () => {
	it("serves a big enough seeded raster, downsampled to the need", async () => {
		const fallback = vi.fn(async () => null);
		const load = seededTileLoader(
			new Map([[id, raster(512, () => 8)]]),
			fallback,
		);
		const r = await load(key, 128, opts);
		expect(r?.size).toBe(256);
		expect(r?.heights?.[0]).toBe(8);
		expect(fallback).not.toHaveBeenCalled();
	});

	it("keeps a 256 raster as is for seg 128 and 64", async () => {
		const seeded = raster(256);
		const load = seededTileLoader(new Map([[id, seeded]]), vi.fn());
		expect(await load(key, 128, opts)).toBe(seeded);
		expect(await load(key, 64, opts)).toBe(seeded);
	});

	it("falls through when the seeded raster is too small (never upsampled)", async () => {
		const out = raster(512);
		const fallback = vi.fn(async () => out);
		const load = seededTileLoader(new Map([[id, raster(256)]]), fallback);
		expect(await load(key, 256, opts)).toBe(out);
		expect(fallback).toHaveBeenCalledOnce();
	});

	it("falls through for a tile the seed lacks", async () => {
		const fallback = vi.fn(async () => null);
		const load = seededTileLoader(new Map(), fallback);
		expect(await load(key, 64, opts)).toBeNull();
		expect(fallback).toHaveBeenCalledWith(key, 64, opts);
	});

	it("averages 2x2 blocks when downsampling", async () => {
		// 512 -> 256 for seg 128: each output is the box mean of 4 inputs; row-major ramp
		const load = seededTileLoader(
			new Map([[id, raster(512, (i) => i % 512)]]),
			vi.fn(),
		);
		const r = await load(key, 128, opts);
		expect(r?.heights?.[0]).toBeCloseTo(0.5);
		expect(r?.heights?.[1]).toBeCloseTo(2.5);
	});
});

describe("sharedSeed", () => {
	it("decodes once for concurrent users and again after the last release", async () => {
		const decode = vi.fn(async () => new Map());
		const s = sharedSeed(decode);
		const a = s.acquire();
		const b = s.acquire();
		expect(await a.seed).toBe(await b.seed);
		a.release();
		a.release(); // idempotent
		s.acquire().release();
		expect(decode).toHaveBeenCalledOnce();
		b.release();
		const c = s.acquire();
		await c.seed;
		expect(decode).toHaveBeenCalledTimes(2);
	});
});
