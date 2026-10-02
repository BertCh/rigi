// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import type { SceneLake } from "../compact";
import {
	floorRadius,
	insideLake,
	LAKE_FLOOR_DEFAULTS,
	lakeFloor,
	lakeFloorDetail,
	outlineDistance,
} from "../floor";

const square = (e0: number, n0: number, s: number): [number, number][] => [
	[e0, n0],
	[e0 + s, n0],
	[e0 + s, n0 + s],
	[e0, n0 + s],
];
const lake = (over: Partial<SceneLake> = {}): SceneLake => ({
	polygon: square(0, 0, 1000),
	levelM: 400,
	levelSource: "table",
	name: "L",
	...over,
});

describe("floorRadius", () => {
	it("clamps hAcc to [5, 100] and adds 30 m; defaults to 20", () => {
		expect(floorRadius(undefined)).toBe(50);
		expect(floorRadius(null)).toBe(50);
		expect(floorRadius(0)).toBe(50);
		expect(floorRadius(Number.NaN)).toBe(50);
		expect(floorRadius(1)).toBe(35);
		expect(floorRadius(500)).toBe(130);
		expect(floorRadius(40)).toBe(70);
	});
});

describe("insideLake / outlineDistance", () => {
	it("is even-odd with holes", () => {
		const l = lake({ holes: [square(400, 400, 200)] });
		expect(insideLake(l, 100, 100)).toBe(true);
		expect(insideLake(l, 500, 500)).toBe(false); // island
		expect(insideLake(l, -10, 500)).toBe(false);
	});
	it("measures the unsigned distance to the nearest ring, inside or outside", () => {
		const l = lake();
		expect(outlineDistance(l, 500, 100)).toBeCloseTo(100, 9);
		expect(outlineDistance(l, 500, -30)).toBeCloseTo(30, 9);
		expect(outlineDistance(l, -30, -40)).toBeCloseTo(50, 9); // corner
		const h = lake({ holes: [square(400, 400, 200)] });
		expect(outlineDistance(h, 500, 500)).toBeCloseTo(100, 9);
	});
	it("handles degenerate edges", () => {
		const l = lake({
			polygon: [
				[0, 0],
				[0, 0],
				[10, 0],
			],
		});
		expect(outlineDistance(l, 0, 5)).toBeCloseTo(5, 9);
	});
});

describe("lakeFloorDetail", () => {
	it("floors the eye at level + margin when the fix is inside the lake", () => {
		const d = lakeFloorDetail([lake()], [500, 500]);
		expect(d?.floorM).toBeCloseTo(400 + LAKE_FLOOR_DEFAULTS.marginM, 12);
		expect(d?.inside).toBe(true);
		expect(lakeFloor([lake()], [500, 500])).toBeCloseTo(400.3, 12);
	});
	it("returns null for a fix on land away from the shore", () => {
		expect(lakeFloor([lake()], [5000, 5000], { demAtFix: 400 })).toBeNull();
	});
	it("applies the near-shore rule only with a DEM at the fix that is not far below the lake", () => {
		const fix: [number, number] = [-20, 500]; // 20 m outside, radius 50
		expect(lakeFloor([lake()], fix)).toBeNull();
		expect(lakeFloor([lake()], fix, { demAtFix: 401 })).not.toBeNull();
		expect(lakeFloor([lake()], fix, { demAtFix: 410 })).not.toBeNull(); // ground above the lake is fine
		expect(lakeFloor([lake()], fix, { demAtFix: 396 })).toBeNull(); // ground 4 m below the lake > maxDrop 3: a barrier
		expect(lakeFloor([lake()], fix, { demAtFix: Number.NaN })).toBeNull();
		expect(lakeFloor([lake()], [-80, 500], { demAtFix: 401 })).toBeNull(); // beyond radius
		expect(
			lakeFloor([lake()], [-80, 500], { demAtFix: 401, radiusM: 100 }),
		).not.toBeNull();
	});
	it("skips reservoirs, basins, NaN levels and degenerate polygons", () => {
		expect(lakeFloor([lake({ water: "reservoir" })], [500, 500])).toBeNull();
		expect(lakeFloor([lake({ water: "basin" })], [500, 500])).toBeNull();
		expect(lakeFloor([lake({ levelM: Number.NaN })], [500, 500])).toBeNull();
		expect(
			lakeFloor(
				[
					lake({
						polygon: [
							[0, 0],
							[1, 1],
						],
					}),
				],
				[0.2, 0.1],
			),
		).toBeNull();
		expect(lakeFloor([], [0, 0])).toBeNull();
	});
	it("picks the highest floor among overlapping lakes and honours custom margin", () => {
		const hi = lake({ levelM: 450, name: "hi" });
		const lo = lake({ levelM: 400, name: "lo" });
		const d = lakeFloorDetail([lo, hi], [500, 500], { marginM: 1 });
		expect(d?.lake).toBe("hi");
		expect(d?.floorM).toBe(451);
	});
});
