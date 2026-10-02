// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { DEG, EARTH_R } from "../../../geodesy";
import {
	compactLakes,
	FLOWING,
	simplifyIdx,
	toSceneLakes,
	type WaterElement,
} from "../compact";

describe("simplifyIdx (Douglas-Peucker)", () => {
	it("keeps endpoints and drops collinear points", () => {
		const pts: [number, number][] = [
			[0, 0],
			[1, 0],
			[2, 0],
			[3, 0],
		];
		expect(simplifyIdx(pts, 0.1)).toEqual([0, 3]);
	});
	it("keeps a vertex that deviates more than the tolerance, drops it otherwise", () => {
		const pts: [number, number][] = [
			[0, 0],
			[5, 2],
			[10, 0],
		];
		expect(simplifyIdx(pts, 1)).toEqual([0, 1, 2]);
		expect(simplifyIdx(pts, 2.5)).toEqual([0, 2]);
	});
	it("handles tiny inputs and a closed (zero-length chord) ring", () => {
		expect(simplifyIdx([], 1)).toEqual([]);
		expect(simplifyIdx([[0, 0]], 1)).toEqual([0]);
		expect(
			simplifyIdx(
				[
					[0, 0],
					[1, 1],
				],
				1,
			),
		).toEqual([0, 1]);
		const ring: [number, number][] = [
			[0, 0],
			[10, 0],
			[10, 10],
			[0, 10],
			[0, 0],
		];
		expect(simplifyIdx(ring, 1)).toContain(2); // the far corner survives
	});
	it("never moves a kept point farther than tol from the original polyline", () => {
		const pts: [number, number][] = Array.from({ length: 200 }, (_, i) => [
			i,
			3 * Math.sin(i / 7),
		]);
		const keep = simplifyIdx(pts, 0.5);
		expect(keep[0]).toBe(0);
		expect(keep[keep.length - 1]).toBe(199);
		for (let i = 0; i < 200; i++) {
			// distance to the simplified polyline
			let best = Number.POSITIVE_INFINITY;
			for (let k = 0; k + 1 < keep.length; k++) {
				const [ax, ay] = pts[keep[k]];
				const [bx, by] = pts[keep[k + 1]];
				const dx = bx - ax;
				const dy = by - ay;
				const t = Math.max(
					0,
					Math.min(
						1,
						((pts[i][0] - ax) * dx + (pts[i][1] - ay) * dy) /
							(dx * dx + dy * dy),
					),
				);
				best = Math.min(
					best,
					Math.hypot(pts[i][0] - ax - t * dx, pts[i][1] - ay - t * dy),
				);
			}
			expect(best).toBeLessThanOrEqual(0.5 + 1e-9);
		}
	});
});

/** A square lake of `sideM` metres with its SW corner at (lat, lon), closed way geometry. */
function squareWay(lat: number, lon: number, sideM: number) {
	const dLat = sideM / EARTH_R / DEG;
	const dLon = sideM / (EARTH_R * Math.cos(lat * DEG)) / DEG;
	return [
		{ lat, lon },
		{ lat, lon: lon + dLon },
		{ lat: lat + dLat, lon: lon + dLon },
		{ lat: lat + dLat, lon },
		{ lat, lon },
	];
}

describe("compactLakes", () => {
	const lake = (over: Partial<WaterElement> = {}): WaterElement => ({
		type: "way",
		id: 1,
		tags: { natural: "water", name: "Testsee", ele: "558" },
		geometry: squareWay(46.7, 7.8, 1000),
		...over,
	});
	it("compacts a square lake to its four corners with name, ele and area", () => {
		const [l] = compactLakes([lake()]);
		expect(l.id).toBe("way/1");
		expect(l.name).toBe("Testsee");
		expect(l.ele).toBe(558);
		expect(l.outer).toHaveLength(8); // 4 vertices, ring not repeated
		expect(l.areaM2).toBeGreaterThan(0.98e6);
		expect(l.areaM2).toBeLessThan(1.02e6);
		expect(l.holes).toBeUndefined();
	});
	it("rounds coordinates to 1e-6 degrees", () => {
		const el = lake({ geometry: squareWay(46.7000004999, 7.8000004999, 1000) });
		for (const v of compactLakes([el])[0].outer)
			expect(Math.abs(v * 1e6 - Math.round(v * 1e6))).toBeLessThan(1e-6);
	});
	it("drops non-water, flowing water, duplicates and lakes under the area floor", () => {
		const out = compactLakes([
			lake({ id: 1 }),
			lake({ id: 1 }), // duplicate
			lake({ id: 2, tags: { natural: "wood" } }),
			lake({ id: 3, tags: { natural: "water", water: "river" } }),
			lake({ id: 4, geometry: squareWay(46.7, 7.8, 50) }), // 2500 m2
		]);
		expect(out.map((l) => l.id)).toEqual(["way/1"]);
		expect(FLOWING.has("river")).toBe(true);
		expect(FLOWING.has("lake")).toBe(false);
	});
	it("keeps reservoirs (tagged) but skips elements without geometry", () => {
		const out = compactLakes([
			lake({ id: 5, tags: { natural: "water", water: "reservoir" } }),
			lake({ id: 6, geometry: undefined }),
		]);
		expect(out).toHaveLength(1);
		expect(out[0].water).toBe("reservoir");
	});
	it("builds relations: largest outer ring + inner island as a hole", () => {
		const rel: WaterElement = {
			type: "relation",
			id: 7,
			tags: { natural: "water" },
			members: [
				{ role: "outer", geometry: squareWay(46.7, 7.8, 2000) },
				{ role: "inner", geometry: squareWay(46.705, 7.805, 300) },
			],
		};
		const [l] = compactLakes([rel]);
		expect(l.holes).toHaveLength(1);
		expect(l.holes?.[0]).toHaveLength(8);
		expect(l.ele).toBeNull();
	});
	it("returns [] for no elements", () => {
		expect(compactLakes([])).toEqual([]);
	});
});

describe("toSceneLakes", () => {
	const [geo] = compactLakes([
		{
			type: "way",
			id: 9,
			tags: { natural: "water", name: "X", water: "lake" },
			geometry: squareWay(46.7, 7.8, 1000),
		},
	]);
	const toEN = (lat: number, lon: number): [number, number] => [
		(lon - 7.8) * 1000,
		(lat - 46.7) * 1000,
	];
	it("projects rings and carries the level and its source", () => {
		const [s] = toSceneLakes([geo], toEN, () => ({
			levelM: 123,
			source: "table",
		}));
		expect(s.polygon).toHaveLength(4);
		expect(s.levelM).toBe(123);
		expect(s.levelSource).toBe("table");
		expect(s.name).toBe("X");
		expect(s.water).toBe("lake");
		expect(s.id).toBe("way/9");
	});
	it("marks lakes without a level NaN / none", () => {
		const [s] = toSceneLakes([geo], toEN);
		expect(s.levelM).toBeNaN();
		expect(s.levelSource).toBe("none");
	});
});
