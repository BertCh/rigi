// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it, vi } from "vitest";

const loadNearDem = vi.fn();
vi.mock("#/lib/nearfield/near-dem", () => ({
	loadNearDem: (...a: unknown[]) => loadNearDem(...a),
}));

import { nearGround } from "../ground";

describe("nearGround", () => {
	it("wraps the shared near DEM's heightAt as a fix-centred ground", async () => {
		loadNearDem.mockResolvedValueOnce({
			heightAt: (lat: number) => 1000 + (lat - 46) * 1000,
		});
		const g = await nearGround(46, 7, { radiusM: 100 });
		expect(g(0, 0)).toBeCloseTo(1000, 6);
		expect(g(0, 111.19)).toBeGreaterThan(1000.09);
		expect(loadNearDem).toHaveBeenCalledWith(46, 7, null, { radiusM: 100 });
	});

	it("is NaN everywhere when there is no DEM or the loader throws", async () => {
		loadNearDem.mockResolvedValueOnce(null);
		expect(Number.isNaN((await nearGround(46, 7))(1, 2))).toBe(true);
		loadNearDem.mockRejectedValueOnce(new Error("boom"));
		expect(Number.isNaN((await nearGround(46, 7))(0, 0))).toBe(true);
	});
});
