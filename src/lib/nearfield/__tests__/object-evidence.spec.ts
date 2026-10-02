// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import {
	buildObjectHeightGrid,
	ndsmHeightAt,
	prepareObjectPrior,
} from "../object-evidence";

const K = { fx: 1, fy: 1, cx: 0.5, cy: 0.5 };
// yaw 0 looks north (+n), pitch 0, roll 0
const pose = { yaw: 0, pitch: 0, roll: 0, vfov: 53.13 } as never;

describe("object evidence (nDSM adapter)", () => {
	it("samples the nDSM at the DEM hit point of each cell", () => {
		const seen: [number, number][] = [];
		const g = buildObjectHeightGrid({
			width: 3,
			height: 1,
			demGrid: Float32Array.from([100, Number.NaN, 100]),
			K,
			pose,
			eye: { x: 10, y: 20, z: 5 },
			heightAt: (e, n) => {
				seen.push([e, n]);
				return e > 10 ? 8 : Number.NaN;
			},
		});
		expect(seen).toHaveLength(2); // the NaN-range cell is never sampled
		// centre-ish cells look north: hit n is ahead of the eye (n > 20), e offsets by the ray's right component
		for (const [, n] of seen) expect(n).toBeGreaterThan(20);
		expect(Number.isNaN(g[0])).toBe(true); // left cell: e < 10, sampler says no data
		expect(Number.isNaN(g[1])).toBe(true);
		expect(g[2]).toBe(8);
	});

	it("turns the ray length back into a hit point (centre cell, 100 m north)", () => {
		let hit: [number, number] = [0, 0];
		buildObjectHeightGrid({
			width: 1,
			height: 1,
			demGrid: [100],
			K,
			pose,
			eye: { x: 0, y: 0, z: 0 },
			heightAt: (e, n) => {
				hit = [e, n];
				return 3;
			},
		});
		expect(hit[0]).toBeCloseTo(0, 6);
		expect(hit[1]).toBeCloseTo(100, 6);
	});

	it("ndsmHeightAt is dsm minus dtm in eye-relative coordinates, NaN propagates", () => {
		const calls: [string, number, number][] = [];
		const f = ndsmHeightAt(
			{} as never,
			(_g, which, e, n) => {
				calls.push([which, e, n]);
				return which === "dsm" ? 1010 : 1000;
			},
			{ x: 5, y: 6 },
		);
		expect(f(15, 16)).toBe(10);
		expect(calls[0]).toEqual(["dsm", 10, 10]);
		expect(
			ndsmHeightAt({} as never, () => Number.NaN, { x: 0, y: 0 })(1, 1),
		).toBeNaN();
	});

	it("prepareObjectPrior resolves null and never throws when the frame fails", async () => {
		const r = await prepareObjectPrior({
			width: 1,
			height: 1,
			demGrid: [100],
			K,
			pose,
			eye: { x: 0, y: 0, z: 0 },
			frame: {
				toGeo: () => {
					throw new Error("boom");
				},
			},
		});
		expect(r).toBeNull();
	});

	it("prepareObjectPrior resolves null outside Switzerland (no fetch)", async () => {
		const r = await prepareObjectPrior({
			width: 1,
			height: 1,
			demGrid: [100],
			K,
			pose,
			eye: { x: 0, y: 0, z: 0 },
			frame: { toGeo: () => ({ lat: 48.85, lon: 2.35 }) },
		});
		expect(r).toBeNull();
	});
});
