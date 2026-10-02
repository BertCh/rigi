// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// loadBasinDem's own arithmetic (curvature drop, azimuth interpolation, sector lengths) over a stubbed
// src/lib/gpu/eye: no DEM tiles, no GPU.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { EARTH_R, REFRACTION_K } from "#/lib/geodesy";
import { GRID_R } from "../basin";

type Hz = { step: number; elevation: Float32Array };
const state = vi.hoisted(() => ({
	loadEyeMosaics: vi.fn(),
	createEyeHorizonProvider: vi.fn(),
	release: vi.fn(),
	horizonsAtEyes: vi.fn(),
	ground: vi.fn(),
}));
vi.mock("#/lib/gpu/eye", () => ({
	loadEyeMosaics: state.loadEyeMosaics,
	createEyeHorizonProvider: state.createEyeHorizonProvider,
}));

import { loadBasinDem } from "../basin-dem";

const drop = (E: number, N: number) =>
	((1 - REFRACTION_K) * (E * E + N * N)) / (2 * EARTH_R);

beforeEach(() => {
	for (const f of Object.values(state)) f.mockReset();
	state.loadEyeMosaics.mockResolvedValue({ mosaics: true });
	state.createEyeHorizonProvider.mockReturnValue({
		ground: state.ground,
		horizonsAtEyes: state.horizonsAtEyes,
		release: state.release,
	});
});

describe("loadBasinDem", () => {
	it("loads the mosaics for the sector with the grid padding", async () => {
		await loadBasinDem(46.7, 7.8, { az0: 10, az1: 50 });
		expect(state.loadEyeMosaics).toHaveBeenCalledWith(46.7, 7.8, {
			sector: { az0: 10, az1: 50 },
			padMeters: GRID_R + 300,
			maxDistance: 100_000,
		});
	});

	it("aborts after loading when the signal fired", async () => {
		const ac = new AbortController();
		ac.abort();
		await expect(
			loadBasinDem(0, 0, { az0: 0, az1: 1 }, { signal: ac.signal }),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(state.createEyeHorizonProvider).not.toHaveBeenCalled();
	});

	it("ground() subtracts the curvature/refraction drop", async () => {
		state.ground.mockImplementation(() => 1000);
		const dem = await loadBasinDem(0, 0, { az0: 0, az1: 1 });
		expect(dem.ground(0, 0)).toBe(1000);
		const E = 3000;
		const N = 4000;
		expect(dem.ground(E, N)).toBeCloseTo(1000 - drop(E, N), 9);
		expect(drop(E, N)).toBeGreaterThan(0.5); // 5 km: ~0.34 m * ... sanity that it is not a no-op
	});

	it("horizons() lifts each eye by its drop and linearly interpolates the azimuth rows", async () => {
		const dem = await loadBasinDem(0, 0, { az0: 0, az1: 10 });
		// 1° provider step; elevation[i] = i degrees, 360 entries
		const h: Hz = {
			step: 1,
			elevation: Float32Array.from({ length: 360 }, (_, i) => i),
		};
		state.horizonsAtEyes.mockResolvedValue([h]);
		const eyes: [number, number, number][] = [[3000, 4000, 1500]];
		const out = await dem.horizons(eyes, 10, 12, 0.5);
		expect(state.horizonsAtEyes).toHaveBeenCalledWith([
			[3000, 4000, 1500 + drop(3000, 4000)],
		]);
		// arangeLen(10, 12.25, 0.5) = 5 samples: 10, 10.5, ..., 12
		expect(Array.from(out[0])).toEqual([10, 10.5, 11, 11.5, 12]);
		expect(out[0]).toBeInstanceOf(Float64Array);
	});

	it("wraps around north and does not interpolate across a no-data (<= -89) neighbour", async () => {
		const dem = await loadBasinDem(0, 0, { az0: 0, az1: 10 });
		const elevation = new Float32Array(360).fill(5);
		elevation[359] = 9;
		elevation[100] = -90;
		state.horizonsAtEyes.mockResolvedValue([{ step: 1, elevation }]);
		const wrap = await dem.horizons([[0, 0, 0]], 359.5, 359.5, 1);
		expect(wrap[0][0]).toBeCloseTo(7, 6); // (9 + 5) / 2 across 359 -> 0
		const hole = await dem.horizons([[0, 0, 0]], 99.5, 99.5, 1);
		expect(hole[0][0]).toBe(-90); // min of the pair, not a blend
	});

	it("returns one row per eye and release() frees the provider", async () => {
		const dem = await loadBasinDem(0, 0, { az0: 0, az1: 10 });
		const h: Hz = { step: 2, elevation: new Float32Array(180).fill(1) };
		state.horizonsAtEyes.mockResolvedValue([h, h, h]);
		const out = await dem.horizons(
			[
				[0, 0, 0],
				[1, 1, 1],
				[2, 2, 2],
			],
			0,
			4,
			2,
		);
		expect(out).toHaveLength(3);
		expect(out[0]).toHaveLength(3); // 0, 2, 4
		dem.release();
		expect(state.release).toHaveBeenCalledOnce();
	});
});
