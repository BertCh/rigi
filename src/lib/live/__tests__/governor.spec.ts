// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { FrameGovernor } from "../governor";

/** Feed `seconds` of frames at a constant cost, one frame per 33 ms; returns the clock. */
function run(
	governor: FrameGovernor,
	start: number,
	seconds: number,
	frameMs: number,
): number {
	let now = start;
	const end = start + seconds * 1000;
	while (now < end) {
		now += 33;
		governor.record(frameMs, now);
	}
	return now;
}

describe("FrameGovernor", () => {
	it("holds the maximum pixel ratio while inside the budget", () => {
		const g = new FrameGovernor({ targetFps: 30, maxPixelRatio: 2 });
		run(g, 0, 10, 25);
		expect(g.state.maxPixelRatio).toBe(2);
		expect(g.state.thermal).toBe(false);
	});

	it("steps the pixel ratio down on sustained over-budget frames, never below the minimum", () => {
		const g = new FrameGovernor({
			targetFps: 30,
			maxPixelRatio: 2,
			minPixelRatio: 1,
		});
		run(g, 0, 4, 50);
		expect(g.state.maxPixelRatio).toBeLessThan(2);
		run(g, 4000, 20, 50);
		expect(g.state.maxPixelRatio).toBe(1);
	});

	it("ignores a single slow window", () => {
		const g = new FrameGovernor({ targetFps: 30, maxPixelRatio: 2 });
		let now = run(g, 0, 0.6, 80);
		now = run(g, now, 5, 20);
		expect(g.state.maxPixelRatio).toBe(2);
	});

	it("backs off the target fps once the minimum pixel ratio still misses the budget", () => {
		const g = new FrameGovernor({
			targetFps: 30,
			maxPixelRatio: 1,
			minPixelRatio: 1,
			thermalMs: 3000,
		});
		run(g, 0, 2, 45);
		expect(g.state.targetFps).toBe(30);
		run(g, 2000, 5, 45);
		expect(g.state.targetFps).toBe(24);
		expect(g.state.thermal).toBe(true);
		expect(g.state.budgetMs).toBeCloseTo(1000 / 24, 6);
	});

	it("recovers: pixel ratio first, then the fps notch", () => {
		const g = new FrameGovernor({
			targetFps: 30,
			maxPixelRatio: 2,
			minPixelRatio: 1,
			thermalMs: 2000,
		});
		let now = run(g, 0, 20, 80);
		expect(g.state.maxPixelRatio).toBe(1);
		expect(g.state.thermal).toBe(true);
		now = run(g, now, 120, 8);
		expect(g.state.maxPixelRatio).toBe(2);
		expect(g.state.thermal).toBe(false);
		expect(g.state.targetFps).toBe(30);
	});

	it("never offers an fps notch above the configured target", () => {
		const g = new FrameGovernor({
			targetFps: 20,
			maxPixelRatio: 1,
			minPixelRatio: 1,
			thermalMs: 1000,
		});
		run(g, 0, 60, 200);
		expect(g.state.targetFps).toBe(15);
	});

	it("reports a change exactly when it steps", () => {
		const g = new FrameGovernor({ targetFps: 30, maxPixelRatio: 2 });
		let changes = 0;
		let now = 0;
		while (now < 3000) {
			now += 33;
			if (g.record(60, now)) changes++;
		}
		expect(changes).toBeGreaterThan(0);
		expect(changes).toBeLessThanOrEqual(3);
	});

	it("rate-limits to the target: a 60 Hz loop renders every other vsync at 30 fps", () => {
		const g = new FrameGovernor({ targetFps: 30, maxPixelRatio: 1 });
		let rendered = 0;
		for (let i = 0; i < 120; i++) {
			const now = i * (1000 / 60);
			if (g.shouldRender(now)) {
				g.markRendered(now);
				rendered++;
			}
		}
		expect(rendered).toBe(60);
	});

	it("reset returns to the configured state", () => {
		const g = new FrameGovernor({ targetFps: 30, maxPixelRatio: 2 });
		run(g, 0, 10, 90);
		g.reset();
		expect(g.state.maxPixelRatio).toBe(2);
		expect(g.state.targetFps).toBe(30);
	});
});
