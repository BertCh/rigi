// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { type Pose, projectPoint } from "#/lib/camera";
import type { NearbyPeak } from "../candidates";
import {
	MENU_ROW_PX,
	menuSize,
	peakKey,
	placeMenu,
	rankPeaksByFit,
	removeTap,
	upsertTap,
} from "../taps";

type T = {
	name: string;
	world: [number, number, number];
	u: number;
	v: number;
};
const tap = (name: string, x: number, u = 0.5): T => ({
	name,
	world: [x, 8000, 900],
	u,
	v: 0.4,
});

describe("tap identity", () => {
	it("two peaks with the same name are two taps (name-keyed filter lost one)", () => {
		const a = tap("Schwarzhorn", 1000);
		const b = tap("Schwarzhorn", -4000);
		// the old rule: taps.filter((t) => t.name !== pk.name)
		expect([a].filter((t) => t.name !== b.name)).toHaveLength(0);
		expect(upsertTap([a], b)).toEqual([a, b]);
	});
	it("re-tapping the same summit replaces it, whatever its name", () => {
		const a = tap("Rothorn", 1000, 0.2);
		const again = { ...tap("Rothorn", 1000.2, 0.3) };
		expect(upsertTap([a], again)).toEqual([again]);
		expect(peakKey(a.world)).toBe(peakKey(again.world));
	});
	it("removeTap removes only that position", () => {
		const a = tap("Rothorn", 1000);
		const b = tap("Rothorn", 2000);
		expect(removeTap([a, b], a.world)).toEqual([b]);
	});
});

describe("rankPeaksByFit", () => {
	const eye: [number, number, number] = [0, 0, 1000];
	const pose: Pose = { yaw: 0, pitch: 0, roll: 0, vfov: 40 };
	const aspect = 1.5;
	const peak = (name: string, world: [number, number, number]): NearbyPeak => ({
		name,
		ele: null,
		prominence: null,
		world,
		sepDeg: 1,
		distKm: 5,
	});
	// yaw 0 looks along +y? derive pixels from the camera instead of assuming
	const A: [number, number, number] = [-2000, 10000, 1500];
	const B: [number, number, number] = [2500, 10000, 1800];
	const wrong: [number, number, number] = [-9000, 3000, 2600];
	const uvOf = (w: [number, number, number]) => {
		const q = projectPoint(pose, aspect, eye, w);
		if (!q) throw new Error("behind");
		return { u: q.u, v: q.v };
	};
	const range: [number, number] = [20, 70];

	it("with no taps keeps the order", () => {
		const offered = [peak("x", wrong), peak("y", B)];
		const r = rankPeaksByFit(
			offered,
			[],
			{ u: 0.5, v: 0.5 },
			eye,
			aspect,
			range,
		);
		expect(r.map((p) => p.name)).toEqual(["x", "y"]);
		expect(r.every((p) => !p.misfit && p.fitDeg === 0)).toBe(true);
	});
	it("puts the fitting name before the nearer misfit and flags it", () => {
		const first = { world: A, ...uvOf(A) };
		const second = uvOf(B);
		const offered = [peak("wrong", wrong), peak("right", B)];
		const r = rankPeaksByFit(offered, [first], second, eye, aspect, range);
		expect(r[0].name).toBe("right");
		expect(r[0].misfit).toBe(false);
		expect(r[1].name).toBe("wrong");
		expect(r[1].misfit).toBe(true);
		expect(r[1].fitDeg).toBeGreaterThan(r[0].fitDeg);
	});
	it("drops summits that are already tapped", () => {
		const first = { world: A, ...uvOf(A) };
		const r = rankPeaksByFit(
			[peak("again", A), peak("right", B)],
			[first],
			uvOf(B),
			eye,
			aspect,
			range,
		);
		expect(r.map((p) => p.name)).toEqual(["right"]);
	});
});

describe("placeMenu", () => {
	const bounds = { left: 0, top: 0, right: 390, bottom: 700 };
	const size = menuSize(5);
	it("rows are touch sized", () => {
		expect(MENU_ROW_PX).toBeGreaterThanOrEqual(44);
		expect(size.h).toBeGreaterThanOrEqual(6 * 44);
	});
	it("opens below-right when it fits", () => {
		expect(placeMenu({ x: 20, y: 20 }, size, bounds)).toEqual({
			left: 28,
			top: 28,
		});
	});
	it("flips and stays inside near the right and bottom edge", () => {
		const p = placeMenu({ x: 380, y: 690 }, size, bounds);
		expect(p.left + size.w).toBeLessThanOrEqual(bounds.right);
		expect(p.top + size.h).toBeLessThanOrEqual(bounds.bottom);
		expect(p.left).toBeGreaterThanOrEqual(0);
		expect(p.top).toBeGreaterThanOrEqual(0);
	});
	it("pins to the top-left when bounds are smaller than the menu", () => {
		expect(
			placeMenu({ x: 50, y: 50 }, size, {
				left: 10,
				top: 5,
				right: 100,
				bottom: 100,
			}),
		).toEqual({ left: 10, top: 5 });
	});
});
