// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import {
	horizonDistance,
	horizonEl,
	horizonRowAt,
	horizonSpan,
	peak,
	peaksBetween,
	projectScene,
	SCENE,
	sectionHeight,
	summitOnSkyline,
} from "../viz/scene";

describe("scene: the real ground (demo-09)", () => {
	it("is the landing's how-it-works photo with a real compass error", () => {
		expect(SCENE.id).toBe("demo-09");
		// the phone's compass was about 18.5° off; the solve turned it back
		expect(SCENE.prior.yaw - SCENE.solved.yaw).toBeGreaterThan(15);
		expect(SCENE.peaks.map((p) => p.name)).toEqual(
			expect.arrayContaining(["Eiger", "Mönch", "Jungfrau"]),
		);
	});

	it("interpolates the horizon inside the bake and returns null outside", () => {
		const [a0, a1] = horizonSpan();
		expect(a1 - a0).toBeGreaterThan(160);
		expect(horizonEl(a0 - 1)).toBeNull();
		expect(horizonEl(a1 + 1)).toBeNull();
		const h = SCENE.horizon;
		expect(horizonEl(h.az0 + h.step * 10)).toBeCloseTo(h.el[10], 6);
		const mid = horizonEl(h.az0 + h.step * 10.5) as number;
		expect(mid).toBeCloseTo((h.el[10] + h.el[11]) / 2, 6);
	});

	it("sits each skyline summit on the drawn horizon, and keeps a foreground one below it", () => {
		const onLine = SCENE.peaks.map(
			(p) => [p.name, summitOnSkyline(p)] as const,
		);
		for (const [, s] of onLine)
			if (s.onSkyline) expect(s.el).toBeCloseTo(horizonEl(s.az) as number, 9);
		const named = Object.fromEntries(onLine);
		expect(named.Eiger.onSkyline).toBe(true);
		expect(named.Jungfrau.onSkyline).toBe(true);
		// Galtbachhoren is a foreground summit, 3° under the Bernese skyline
		expect(named.Galtbachhoren.onSkyline).toBe(false);
	});

	it("has distances across the view and a terrain section", () => {
		const d = horizonDistance(SCENE.solved.yaw);
		expect(d).toBeGreaterThan(1000);
		expect(sectionHeight(0)).toBeCloseTo(SCENE.eye.ground, -1);
		expect(sectionHeight(1e9)).toBe(
			SCENE.section.points[SCENE.section.points.length - 1][1],
		);
	});

	it("finds summits by bearing range and by name", () => {
		const names = peaksBetween(125, 136).map((p) => p.name);
		expect(names).toEqual(
			expect.arrayContaining(["Finsteraarhorn", "Eiger", "Mönch"]),
		);
		expect(peak("Eiger").ele).toBe(3970);
		expect(() => peak("Matterhorn")).toThrow(/no summit/);
	});

	it("projects through a pose: the yaw bearing on the level horizon sits at the frame centre", () => {
		const pose = { ...SCENE.solved, pitch: 0, roll: 0 };
		const [x, y] = projectScene(pose, 640, 480, pose.yaw, 0);
		expect(x).toBeCloseTo(320, 6);
		expect(y).toBeCloseTo(240, 6);
		const row = horizonRowAt(pose, 640, 480);
		const el = horizonEl(pose.yaw) as number;
		expect(row(0.5)).toBeCloseTo(
			projectScene(pose, 640, 480, pose.yaw, el)[1] / 480,
			6,
		);
	});
});
