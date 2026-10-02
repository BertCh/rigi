// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import type { EyeHorizon } from "../../pose6dof/eye";
import { horizonPeaks, profilePeaks, skylinePeaks } from "../peaks";

/** Sum of Gaussian bumps sampled at integer indices. */
const bumps = (
	n: number,
	peaks: [centre: number, height: number, width: number][],
	base = 0,
) =>
	Float64Array.from({ length: n }, (_, i) =>
		peaks.reduce(
			(s, [c, h, w]) => s + h * Math.exp(-((i - c) ** 2) / (2 * w * w)),
			base,
		),
	);

describe("profilePeaks", () => {
	it("finds Gaussian summits at sub-sample accuracy with their prominence", () => {
		const v = bumps(200, [
			[50.3, 10, 6],
			[120.7, 6, 6],
		]);
		const p = profilePeaks(v, { minProm: 2, window: 30 });
		expect(p).toHaveLength(2);
		expect(p[0].i).toBeCloseTo(50.3, 1);
		expect(p[1].i).toBeCloseTo(120.7, 1);
		expect(p[0].value).toBeCloseTo(10, 0);
		expect(p[0].prom).toBeGreaterThan(9);
	});
	it("returns results sorted by index", () => {
		const v = bumps(200, [
			[150, 5, 5],
			[40, 9, 5],
		]);
		const p = profilePeaks(v, { minProm: 1, window: 25 });
		expect(p.map((q) => Math.round(q.i))).toEqual([40, 150]);
	});
	it("rejects peaks below the prominence threshold", () => {
		const v = bumps(100, [[50, 1, 4]]);
		expect(profilePeaks(v, { minProm: 2, window: 20 })).toEqual([]);
		expect(profilePeaks(v, { minProm: 0.5, window: 20 })).toHaveLength(1);
	});
	it("rejects peaks cut by the frame edge (minSide) or by gaps", () => {
		const edge = bumps(100, [[2, 10, 3]]);
		expect(profilePeaks(edge, { minProm: 1, window: 20 })).toEqual([]);
		const gap = bumps(100, [[50, 10, 4]]);
		for (let i = 53; i < 100; i++) gap[i] = Number.NaN; // right side only 2 valid samples
		expect(profilePeaks(gap, { minProm: 1, window: 20 })).toEqual([]);
	});
	it("takes the first sample of a plateau and returns nothing for flat, tiny or empty input", () => {
		const plateau = new Float64Array(60).fill(0);
		for (let i = 25; i <= 30; i++) plateau[i] = 5;
		const p = profilePeaks(plateau, { minProm: 1, window: 15 });
		expect(p).toHaveLength(1);
		// parabolic refinement may shift by up to half a sample
		expect(p[0].i).toBeGreaterThanOrEqual(24.5);
		expect(p[0].i).toBeLessThanOrEqual(26);
		expect(
			profilePeaks(new Float64Array(50), { minProm: 0.1, window: 10 }),
		).toEqual([]);
		expect(profilePeaks([], { minProm: 0, window: 5 })).toEqual([]);
		expect(profilePeaks([1, 2], { minProm: 0, window: 5 })).toEqual([]);
	});
	it("applies non-maximum suppression and keeps the more prominent twin", () => {
		const v = bumps(100, [
			[48, 10, 3],
			[52, 8, 3],
		]);
		const nms = profilePeaks(v, { minProm: 0.5, window: 20, nms: 10 });
		expect(nms.length).toBeLessThanOrEqual(1);
	});
	it("is invariant to a constant offset", () => {
		const v = bumps(120, [[60, 7, 5]]);
		const a = profilePeaks(v, { minProm: 1, window: 25 });
		const b = profilePeaks(
			v.map((x) => x + 1000),
			{ minProm: 1, window: 25 },
		);
		expect(b).toHaveLength(a.length);
		expect(b[0].i).toBeCloseTo(a[0].i, 9);
		expect(b[0].prom).toBeCloseTo(a[0].prom, 9);
	});
});

describe("horizonPeaks", () => {
	const step = 0.05;
	const n = 7200;
	const elevation = Float64Array.from({ length: n }, (_, k) => {
		const az = k * step;
		const d = (c: number) => Math.min(Math.abs(az - c), 360 - Math.abs(az - c));
		return (
			2 + 6 * Math.exp(-(d(10) ** 2) / 2) + 4 * Math.exp(-(d(355) ** 2) / 2)
		);
	});
	const hz: EyeHorizon = { step, elevation };
	it("recovers peak azimuths and elevations", () => {
		const p = horizonPeaks(hz, 0, 40, { minPromDeg: 1, windowDeg: 6 });
		expect(p).toHaveLength(1);
		expect(p[0].az).toBeCloseTo(10, 1);
		expect(p[0].el).toBeCloseTo(8, 1);
		expect(p[0].d).toBeNaN();
	});
	it("handles sectors wrapping past 360 and normalises az into [0, 360)", () => {
		const p = horizonPeaks(hz, 340, 380, { minPromDeg: 1, windowDeg: 6 });
		expect(p.map((q) => Math.round(q.az)).sort((a, b) => a - b)).toEqual([
			10, 355,
		]);
		for (const q of p) {
			expect(q.az).toBeGreaterThanOrEqual(0);
			expect(q.az).toBeLessThan(360);
		}
	});
	it("treats no-data bins (-90) as gaps and reads distance when present", () => {
		const e2 = Float64Array.from(elevation);
		for (let k = Math.round(10.2 / step); k < Math.round(12 / step); k++)
			e2[k] = -90;
		const dist = new Float64Array(n).fill(1234);
		const p = horizonPeaks({ step, elevation: e2, distance: dist }, 0, 40, {
			minPromDeg: 1,
			windowDeg: 6,
		});
		for (const q of p) expect(q.d).toBe(1234);
		// the right flank is mostly missing so the summit near 10 deg is cut: no valid side
		expect(p.every((q) => Math.abs(q.az - 10) > 0.5)).toBe(true);
	});
});

describe("skylinePeaks", () => {
	it("finds a peak (smallest y) with its image position", () => {
		const samples = [];
		for (let x = 0; x <= 400; x += 4)
			samples.push({
				x,
				y: 500 - 80 * Math.exp(-((x - 200) ** 2) / (2 * 20 ** 2)),
			});
		const p = skylinePeaks(samples, 4, { minPromPx: 20, windowPx: 100 });
		expect(p).toHaveLength(1);
		expect(p[0].x).toBeCloseTo(200, 0);
		expect(p[0].y).toBeCloseTo(420, 0);
		expect(p[0].prom).toBeGreaterThan(70);
	});
	it("returns [] for no samples and ignores a flat skyline", () => {
		expect(skylinePeaks([], 4, { minPromPx: 5, windowPx: 40 })).toEqual([]);
		const flat = Array.from({ length: 50 }, (_, i) => ({ x: i * 4, y: 300 }));
		expect(skylinePeaks(flat, 4, { minPromPx: 5, windowPx: 40 })).toEqual([]);
	});
	it("a missing column breaks the prominence walk", () => {
		const samples = [];
		for (let x = 0; x <= 400; x += 4) {
			if (x >= 208 && x <= 232) continue;
			samples.push({
				x,
				y: 500 - 80 * Math.exp(-((x - 200) ** 2) / (2 * 20 ** 2)),
			});
		}
		const p = skylinePeaks(samples, 4, { minPromPx: 20, windowPx: 100 });
		expect(p.filter((q) => Math.abs(q.x - 200) < 6)).toHaveLength(0);
	});
});
