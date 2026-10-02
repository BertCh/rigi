// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { GipfelbuchPhotoData } from "../viz/real";
import { filmFrame, filmPlan } from "../viz/storyFilm";
import {
	BEAT_LAYERS,
	beatLabel,
	countTraced,
	eyeNoteText,
	gapTick,
	hairlineScales,
	horizonPathAt,
	horizonRowAt,
	movedPx,
	nextArmed,
	poseNoteText,
	riderOpacity,
	scrubMs,
	shouldCommitT,
	solvedAlpha,
	solvedReadoutText,
	spillCursorFor,
	stepBeat,
	tickOpacity,
	tracedNoteText,
	turnNumbers,
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

const DEMO = path.resolve(__dirname, "../../../../public/demo/gipfelbuch");
const read = (id: string) =>
	JSON.parse(
		fs.readFileSync(path.join(DEMO, `${id}.json`), "utf8"),
	) as GipfelbuchPhotoData;
const demo09 = read("demo-09");
const demo01 = read("demo-01");

describe("per-page focus notes", () => {
	it("eye: the GPS altitude under the ground, then the eye height the solve keeps", () => {
		expect(eyeNoteText(demo09)).toBe(
			"GPS 1183 m is 730 m under the ground → eye at 1915 m",
		);
		// a photo with GPS at the ground says it is above it
		expect(eyeNoteText(demo01)).toBe(
			"eye at GPS 1919 m, above the ground (1886 m)",
		);
	});

	it("gaps: the readout and the turn's extra numbers come from the residual and delta", () => {
		expect(solvedReadoutText(demo01, "gaps")).toBe(
			"median 5.2→2.7 px · p90 13→8 · ≤5 px 47%→74%",
		);
		expect(solvedReadoutText(demo01)).toBe("gap 2.7 px");
		expect(turnNumbers(demo01, "gaps").extra).toBe("−0.5° roll · focal ×1.02");
		expect(turnNumbers(demo01).extra).toBeNull();
	});

	it("prior: the sensors, and how far the compass was off", () => {
		expect(poseNoteText(demo01, "prior")).toBe(
			"compass 251.4°, tilt -3.1°, 26 mm",
		);
		expect(poseNoteText(demo01)).toMatch(/^phone's guess: yaw /);
		expect(turnNumbers(demo01, "prior").extra).toBe("compass off by 9.3°");
	});

	it("trace: counts the traced columns inside the crop", () => {
		const rows = [null, 5, 6, null, 7];
		expect(countTraced(rows, 0, 5)).toBe(3);
		expect(countTraced(rows, 2, 4)).toBe(1);
		expect(tracedNoteText("trace", 3)).toBe(
			"traced 3 columns; tall bars = sure",
		);
		expect(tracedNoteText("gaps", 3)).toBe("traced skyline");
	});

	it("snap: how far a summit moved", () => {
		expect(movedPx({ prior: [0, 0], solved: [3, 4] })).toBe(5);
		expect(movedPx({ prior: null, solved: [3, 4] })).toBeNull();
	});

	it("tap: the needle sits on the tapped summit until the camera turns", () => {
		const tap = { az: 123, name: "Niesen" };
		const yawAt = (t: number) => 10 + 20 * t;
		expect(spillCursorFor(yawAt, 2, 0, tap)).toEqual({
			az: 123,
			label: "tap: Niesen",
			layer: "solved",
		});
		expect(spillCursorFor(yawAt, 2, 0.5, tap)?.label).toBe("…");
		expect(spillCursorFor(yawAt, 3, 0, tap)?.az).toBe(10);
		expect(spillCursorFor(yawAt, 1, 0, tap)).toBeNull();
	});
});
