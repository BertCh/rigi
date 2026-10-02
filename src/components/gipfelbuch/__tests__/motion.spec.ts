// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import {
	type BeatSpec,
	type BeatState,
	beatReducer,
	beatScriptProblem,
	buildTimeline,
	cubicBezier,
	dwellOf,
	ease,
	MOTION,
	nextArmed,
	sampleTimeline,
	settledBeats,
	shownShare,
	spillTAt,
	stagger,
	transitionOf,
} from "../viz/motion";

const STORY: BeatSpec[] = [
	{ id: "guess", kind: "setup" },
	{ id: "measure", kind: "evidence" },
	{ id: "correct", kind: "change" },
	{ id: "snap", kind: "result" },
];

describe("easings", () => {
	it("start at 0, end at 1 and never overshoot", () => {
		for (const [name, f] of Object.entries(ease)) {
			expect(f(0), name).toBeCloseTo(0, 6);
			expect(f(1), name).toBeCloseTo(1, 6);
			let prev = 0;
			for (let i = 1; i <= 100; i++) {
				const v = f(i / 100);
				expect(v, name).toBeGreaterThanOrEqual(prev - 1e-9);
				expect(v, name).toBeLessThanOrEqual(1 + 1e-9);
				prev = v;
			}
		}
	});

	it("the CSS out curve matches 1-(1-t)^3 (RevealLoop's ease)", () => {
		const css = cubicBezier(0.33, 1, 0.68, 1);
		for (let i = 0; i <= 20; i++) {
			const t = i / 20;
			expect(css(t)).toBeCloseTo(ease.out(t), 2);
		}
	});

	it("a linear bezier is the identity", () => {
		const f = cubicBezier(1 / 3, 1 / 3, 2 / 3, 2 / 3);
		for (const t of [0.1, 0.37, 0.5, 0.92]) expect(f(t)).toBeCloseTo(t, 5);
	});
});

describe("tokens", () => {
	it("keep the values they unify", () => {
		expect(MOTION.settle).toBe(620); // GeoSpill SLIDE_MS
		expect(MOTION.sweep).toBe(4200); // RevealLoop SWEEP
		expect(MOTION.enter).toBe(1000); // Figure, FadeIn
		expect(MOTION.draw).toBe(900); // nb-draw
	});

	it("transitionOf and stagger build CSS from tokens", () => {
		expect(transitionOf(["opacity"], "fade")).toBe(
			"opacity 420ms cubic-bezier(0.33, 1, 0.68, 1)",
		);
		expect(transitionOf(["opacity", "transform"], 100, "linear", 50)).toBe(
			"opacity 100ms linear 50ms, transform 100ms linear 50ms",
		);
		expect([0, 1, 2].map((i) => stagger(i))).toEqual([0, 110, 220]);
		expect(stagger(-3)).toBe(0);
		expect(stagger(2, MOTION.staggerLabel, 300)).toBe(420);
	});
});

describe("beat timelines", () => {
	it("lay beats end to end, the result held 1.6 beats", () => {
		const tl = buildTimeline(STORY);
		expect(tl.beats.map((b) => b.start)).toEqual([0, 2800, 5600, 8400]);
		expect(tl.total).toBe(8400 + dwellOf("result"));
		expect(dwellOf("result")).toBe(4480);
		expect(buildTimeline([{ id: "a", kind: "setup", dwell: 500 }]).total).toBe(
			500,
		);
	});

	it("sample the beat, its progress, and the end or the loop", () => {
		const tl = buildTimeline(STORY);
		expect(sampleTimeline(tl, 0)).toMatchObject({ index: 0, progress: 0 });
		expect(sampleTimeline(tl, 4200)).toMatchObject({
			index: 1,
			kind: "evidence",
			progress: 0.5,
			done: false,
		});
		expect(sampleTimeline(tl, tl.total + 1)).toMatchObject({
			index: 3,
			kind: "result",
			progress: 1,
			done: true,
		});
		expect(sampleTimeline(tl, tl.total + 100, { loop: true })).toMatchObject({
			index: 0,
			done: false,
		});
		expect(sampleTimeline(tl, -50).index).toBe(0);
	});

	it("check the causal order", () => {
		expect(beatScriptProblem(STORY)).toBeNull();
		expect(
			beatScriptProblem([
				{ id: "a", kind: "setup" },
				{ id: "b", kind: "change" },
				{ id: "c", kind: "change" },
				{ id: "d", kind: "result" },
			]),
		).toBeNull();
		expect(beatScriptProblem([])).toMatch(/no beats/);
		expect(
			beatScriptProblem([
				{ id: "a", kind: "evidence" },
				{ id: "b", kind: "setup" },
				{ id: "c", kind: "result" },
			]),
		).toMatch(/comes after/);
		expect(beatScriptProblem([{ id: "a", kind: "change" }])).toMatch(
			/not a result/,
		);
	});

	it("move the spill at the change", () => {
		expect(STORY.map((b) => spillTAt(b.kind))).toEqual([0, 0, 1, 1]);
	});
});

describe("playback", () => {
	const run = (
		s: BeatState,
		types: ("start" | "advance" | "play" | "pause" | "replay")[],
		playback: "loop" | "once",
	) => types.reduce((st, type) => beatReducer(st, { type }, 4, playback), s);

	it("rests on the last beat until motion starts it from the first", () => {
		expect(settledBeats(4)).toEqual({
			index: 3,
			playing: false,
			manual: false,
		});
		expect(run(settledBeats(4), ["start"], "loop")).toEqual({
			index: 0,
			playing: true,
			manual: false,
		});
	});

	it("loops, or stops on the result once", () => {
		const loop = run(
			settledBeats(4),
			["start", "advance", "advance", "advance", "advance"],
			"loop",
		);
		expect(loop).toMatchObject({ index: 0, playing: true });
		const once = run(
			settledBeats(4),
			["start", "advance", "advance", "advance", "advance"],
			"once",
		);
		expect(once).toMatchObject({ index: 3, playing: false });
		expect(run(once, ["play"], "once")).toMatchObject({
			index: 0,
			playing: true,
		});
		expect(run(once, ["replay"], "once")).toMatchObject({ index: 0 });
	});

	it("ends autoplay when the reader steps, and clamps the step", () => {
		const s = run(settledBeats(4), ["start"], "loop");
		const set = beatReducer(s, { type: "set", index: 9 }, 4, "loop");
		expect(set).toEqual({ index: 3, playing: false, manual: true });
		expect(beatReducer(set, { type: "advance" }, 4, "loop")).toBe(set);
		expect(beatReducer(set, { type: "play" }, 4, "loop")).toMatchObject({
			index: 3,
			playing: true,
			manual: false,
		});
	});

	it("never plays a single beat", () => {
		expect(beatReducer(settledBeats(1), { type: "start" }, 1, "loop")).toEqual({
			index: 0,
			playing: false,
			manual: false,
		});
	});
});

describe("in-view gating", () => {
	it("measures the share against the frame or the viewport, whichever is smaller", () => {
		expect(shownShare(300, 400, 1000)).toBe(0.75);
		expect(shownShare(750, 2000, 1000)).toBe(0.75);
		expect(shownShare(10, 0, 1000)).toBe(0);
	});

	it("arms at 0.75, holds between, disarms below 0.2", () => {
		expect(nextArmed(false, 0.74)).toBe(false);
		expect(nextArmed(false, 0.75)).toBe(true);
		expect(nextArmed(true, 0.3)).toBe(true);
		expect(nextArmed(true, 0.19)).toBe(false);
		expect(nextArmed(false, 0.3)).toBe(false);
	});
});
