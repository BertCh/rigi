// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { filmFrame, filmPlan } from "../viz/storyFilm";
import {
	BEAT_LAYERS,
	beatLabel,
	gapTick,
	hairlineScales,
	horizonPathAt,
	horizonRowAt,
	nextArmed,
	riderOpacity,
	scrubMs,
	shouldCommitT,
	solvedAlpha,
	spillCursorFor,
	stepBeat,
	tickOpacity,
	viewShare,
} from "../viz/storyGeometry";

const plan = filmPlan({ accepted: true, names: 2, ticks: 3, pulses: 2 });

describe("horizonPathAt", () => {
	it("keeps points inside the frame plus the margin and breaks on x jumps over 40 px", () => {
		const pts: [number, number][] = [
			[-50, 1],
			[-10, 2],
			[10, 3],
			[100, 4],
			[110, 5],
			[900, 6],
		];
		expect(horizonPathAt(pts, 0, 800)).toBe(
			"M-10.0 2.0L10.0 3.0M100.0 4.0L110.0 5.0",
		);
	});
	it("is empty without points", () => {
		expect(horizonPathAt(null, 0, 800)).toBe("");
		expect(horizonPathAt([], 0, 800)).toBe("");
	});
});

describe("horizonRowAt", () => {
	const prior = [10, 20, null];
	const solved = [30, 40, 50];
	it("is exactly the measured rows at the ends", () => {
		expect(horizonRowAt(prior, solved, [[0, 99]], 1, 0)).toBe(20);
		expect(horizonRowAt(prior, solved, [[0, 99]], 1, 1)).toBe(40);
	});
	it("reads the moving horizon between, or mixes the measured rows without it", () => {
		expect(
			horizonRowAt(
				prior,
				solved,
				[
					[0, 0],
					[2, 100],
				],
				1,
				0.5,
			),
		).toBeCloseTo(75, 5);
		expect(horizonRowAt(prior, solved, null, 1, 0.5)).toBe(30);
		expect(horizonRowAt(prior, solved, null, 2, 0.5)).toBeNull();
	});
});

describe("gap ticks", () => {
	it("grows from the horizon toward the trace; red from 5 px", () => {
		const t = gapTick(100, 130, 0.5);
		expect(t.y1).toBe(100);
		expect(t.y2).toBe(115);
		expect(t.red).toBe(true);
		expect(gapTick(100, 103, 1).red).toBe(false);
		expect(gapTick(100, 103, 1).weight).toBeLessThan(
			gapTick(100, 160, 1).weight,
		);
		expect(gapTick(100, 160, 1).weight).toBeCloseTo(0.95, 5);
	});
	it("fades in the result beat unless the gaps are the focus", () => {
		expect(tickOpacity(1, 0.8, 1, false)).toBe(0);
		expect(tickOpacity(1, 0.8, 1, true)).toBeCloseTo(0.8, 5);
		expect(tickOpacity(0, 0.8, 0, false)).toBe(0);
	});
});

describe("riders", () => {
	it("an accepted rider shows while t > 0 and hands over as its pulse runs", () => {
		expect(riderOpacity(true, 0, 0)).toBe(0);
		expect(riderOpacity(true, 0.5, 0)).toBe(1);
		expect(riderOpacity(true, 1, 0.75)).toBeCloseTo(0.25, 5);
	});
	it("a refused rider shows only between the two poses", () => {
		expect(riderOpacity(false, 0, 0)).toBe(0);
		expect(riderOpacity(false, 0.4, 0)).toBe(1);
		expect(riderOpacity(false, 1, 0)).toBe(0);
	});
});

describe("beat to layers", () => {
	it("follows the story", () => {
		expect(BEAT_LAYERS.guess).toEqual(["prior"]);
		expect(BEAT_LAYERS.measure).toEqual(["prior", "skyline"]);
		expect(BEAT_LAYERS.snap).toContain("peaks");
		expect(BEAT_LAYERS.keep).not.toContain("peaks");
	});
	it("labels tab 3 search on the search page", () => {
		expect(beatLabel("correct", "search")).toBe("search");
		expect(beatLabel("correct")).toBe("correct");
		expect(beatLabel("keep", "search")).toBe("keep");
	});
});

describe("the heading needle", () => {
	const yaw = (t: number) => 100 + 20 * t;
	it("is absent before the correct beat", () => {
		expect(spillCursorFor(yaw, 1, 0)).toBeNull();
	});
	it("reads a bearing only at the measured poses", () => {
		expect(spillCursorFor(yaw, 2, 0)?.label).toBe("100.0°");
		expect(spillCursorFor(yaw, 3, 1)?.label).toBe("120.0°");
		expect(spillCursorFor(yaw, 2, 0.4)?.label).toBe("…");
		expect(spillCursorFor(yaw, 2, 0.4)?.az).toBeCloseTo(108, 5);
	});
});

describe("arming and committing", () => {
	it("arms at 45 %, pauses under 20 %, keeps the state between", () => {
		expect(nextArmed(false, 0.45)).toBe(true);
		expect(nextArmed(false, 0.44)).toBe(false);
		expect(nextArmed(true, 0.3)).toBe(true);
		expect(nextArmed(false, 0.3)).toBe(false);
		expect(nextArmed(true, 0.19)).toBe(false);
	});
	it("measures the share against the viewport for a tall figure", () => {
		expect(viewShare(400, 1600, 800)).toBe(0.5);
		expect(viewShare(300, 300, 800)).toBe(1);
		expect(viewShare(10, 0, 800)).toBe(0);
	});
	it("commits t at most every 33 ms and always at 0 and 1", () => {
		expect(shouldCommitT(0.5, 0.5, 0, 100)).toBe(false);
		expect(shouldCommitT(0.5, 0.6, 0, 20)).toBe(false);
		expect(shouldCommitT(0.5, 0.6, 0, 40)).toBe(true);
		expect(shouldCommitT(0.99, 1, 0, 1)).toBe(true);
		expect(shouldCommitT(0.01, 0, 0, 1)).toBe(true);
		expect(shouldCommitT(null, 0.3, 0, 1)).toBe(true);
	});
});

describe("stepper", () => {
	it("fills past hairlines, scales the current one, leaves the rest empty", () => {
		expect(hairlineScales({ beat: 1, progress: 0.4 }, 4)).toEqual([
			1, 0.4, 0, 0,
		]);
		expect(hairlineScales(filmFrame(plan, plan.total), 4)).toEqual([
			1, 1, 1, 1,
		]);
	});
	it("scrubs one equal segment per beat", () => {
		expect(scrubMs(plan, 0)).toBe(0);
		expect(scrubMs(plan, 1)).toBe(plan.total);
		const [s, e] = [plan.beats[2].start, plan.beats[2].end];
		expect(scrubMs(plan, 0.5)).toBeCloseTo(s, 5);
		expect(scrubMs(plan, 0.625)).toBeCloseTo((s + e) / 2, 5);
		expect(scrubMs(plan, -3)).toBe(0);
	});
	it("steps the beat and clamps", () => {
		expect(stepBeat(0, -1, 4)).toBe(0);
		expect(stepBeat(1, 1, 4)).toBe(2);
		expect(stepBeat(3, 1, 4)).toBe(3);
	});
});

describe("solvedAlpha", () => {
	it("follows its fade with a moving line, the pose without one, dimmed when a refusal is kept", () => {
		expect(solvedAlpha({ solvedLine: 0, t: 0.6, beat: 2 }, true, true, 3)).toBe(
			0,
		);
		expect(
			solvedAlpha({ solvedLine: 0, t: 0.6, beat: 2 }, false, true, 3),
		).toBe(0.6);
		expect(
			solvedAlpha({ solvedLine: 1, t: 0, beat: 3 }, true, false, 3),
		).toBeCloseTo(0.55, 5);
	});
});
