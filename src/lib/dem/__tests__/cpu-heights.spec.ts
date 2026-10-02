// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it, vi } from "vitest";
import {
	type CpuHeightsTile,
	cpuHeightsCounters,
	getCpuHeights,
	hasCpuHeights,
	heightStats,
} from "../cpu-heights";

describe("getCpuHeights", () => {
	it("returns eager heights without touching counters", () => {
		const heights = new Float32Array([1, 2, 3, 4]);
		const before = cpuHeightsCounters.materialized;
		expect(getCpuHeights({ heights })).toBe(heights);
		expect(cpuHeightsCounters.materialized).toBe(before);
	});
	it("materialises a lazy tile once, stores it and releases the source", () => {
		const out = new Float32Array([5, 6]);
		const materialize = vi.fn(() => out);
		const release = vi.fn();
		const tile: CpuHeightsTile = { lazyHeights: { materialize, release } };
		const before = cpuHeightsCounters.materialized;
		expect(hasCpuHeights(tile)).toBe(false);
		expect(getCpuHeights(tile)).toBe(out);
		expect(getCpuHeights(tile)).toBe(out);
		expect(materialize).toHaveBeenCalledTimes(1);
		expect(release).toHaveBeenCalledTimes(1);
		expect(tile.lazyHeights).toBeUndefined();
		expect(tile.heights).toBe(out);
		expect(hasCpuHeights(tile)).toBe(true);
		expect(cpuHeightsCounters.materialized).toBe(before + 1);
	});
	it("works when the lazy source has no release hook", () => {
		const tile: CpuHeightsTile = {
			lazyHeights: { materialize: () => new Float32Array(1) },
		};
		expect(() => getCpuHeights(tile)).not.toThrow();
	});
	it("throws for a tile with neither heights nor a source", () => {
		expect(() => getCpuHeights({})).toThrow(/neither/);
	});
});

describe("heightStats", () => {
	it("finds min and max over all samples", () => {
		const s = heightStats(new Float32Array([3, -2, 9, 4]));
		expect(s.lo).toBe(-2);
		expect(s.hi).toBe(9);
	});
	it("the stride-7 stats only read samples 0, 7, 14, ...", () => {
		const h = new Float32Array(30).fill(10);
		h[1] = -50; // not a stride-7 sample
		h[7] = 20;
		h[14] = 5;
		h[22] = 99; // not a stride-7 sample
		const s = heightStats(h);
		expect(s.lo).toBe(-50);
		expect(s.hi).toBe(99);
		expect(s.lo7).toBe(5);
		expect(s.hi7).toBe(20);
	});
	it("a single sample gives equal lo/hi", () => {
		expect(heightStats(new Float32Array([7]))).toEqual({
			lo: 7,
			hi: 7,
			lo7: 7,
			hi7: 7,
		});
	});
	it("an empty array yields the +/-Infinity identities", () => {
		const s = heightStats(new Float32Array(0));
		expect(s.lo).toBe(Number.POSITIVE_INFINITY);
		expect(s.hi).toBe(Number.NEGATIVE_INFINITY);
	});
});
