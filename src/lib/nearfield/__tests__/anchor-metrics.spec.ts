// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import {
	fractionBelow,
	medianOfPhotos,
	terrainResiduals,
} from "../anchor-metrics";

/** n cells at DEM `d` with placed = d * ratio. */
const cells = (n: number, d: number, ratio: number) => ({
	dem: new Float32Array(n).fill(d),
	placed: new Float32Array(n).fill(d * ratio),
});

describe("terrainResiduals", () => {
	it("is |log(placed/DEM)| medians per band, and 15-500 overall", () => {
		const a = cells(200, 30, Math.exp(0.2));
		const b = cells(200, 100, Math.exp(-0.1));
		const c = cells(200, 300, 1);
		const dem = Float32Array.from([...a.dem, ...b.dem, ...c.dem]);
		const placed = Float32Array.from([...a.placed, ...b.placed, ...c.placed]);
		const r = terrainResiduals(placed, dem);
		expect(r.bands[0]).toBeCloseTo(0.2, 5);
		expect(r.bands[1]).toBeCloseTo(0.1, 5);
		expect(r.bands[2]).toBeCloseTo(0, 5);
		expect(r.all).toBeCloseTo(0.1, 5);
	});

	it("skips excluded, out-of-window and non-finite cells and needs 150 pixels", () => {
		const n = 400;
		const dem = new Float32Array(n).fill(40);
		const placed = new Float32Array(n).fill(40 * Math.E);
		const excluded = new Uint8Array(n);
		for (let k = 0; k < 200; k++) excluded[k] = 1;
		expect(terrainResiduals(placed, dem, excluded).all).toBeCloseTo(1, 5);
		for (let k = 0; k < 300; k++) excluded[k] = 1;
		expect(terrainResiduals(placed, dem, excluded).all).toBeNull();
		dem.fill(10); // below 15 m: not terrain for the metric
		expect(terrainResiduals(placed, dem).all).toBeNull();
		dem.fill(40);
		placed.fill(Number.NaN);
		expect(terrainResiduals(placed, dem).all).toBeNull();
	});
});

describe("photo aggregates", () => {
	it("ignores nulls", () => {
		expect(medianOfPhotos([0.1, null, 0.3, 0.2])).toBeCloseTo(0.2, 9);
		expect(medianOfPhotos([null])).toBeNaN();
		expect(fractionBelow([0.05, 0.2, null, 0.09, 0.4], 0.1)).toBe(0.5);
		expect(fractionBelow([], 0.1)).toBeNaN();
	});
});
