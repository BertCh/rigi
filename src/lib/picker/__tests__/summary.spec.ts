// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import type { PickerLogEntry } from "../schema";
import { formatSummary, summarizeLog } from "../summary";

const pose = { yaw: 1, pitch: 2, roll: 0, vfov: 40 };
let clock = 0;
const base = (photoId: string, session = "s1") => ({
	t: `2026-10-02T00:00:${String(clock++).padStart(2, "0")}Z`,
	photoId,
	renderer: "webgpu" as const,
	alignState: null,
	verify: null,
	session,
});
const shown = (id: string, shownIndex: number, s?: string): PickerLogEntry => ({
	kind: "shown",
	candidates: [],
	shownIndex,
	...base(id, s),
});
const pickRank = (
	id: string,
	rank: number,
	source = "autoAlign",
): PickerLogEntry =>
	({
		kind: "pick",
		rank,
		source,
		before: pose,
		after: pose,
		...base(id),
	}) as PickerLogEntry;
const dismiss = (id: string): PickerLogEntry => ({
	kind: "dismiss",
	...base(id),
});
const solve = (id: string, px: number[]): PickerLogEntry => ({
	kind: "tap-solve",
	taps: [],
	before: pose,
	results: px.map((tapPx) => ({
		pose,
		tapPx,
		skyline: null,
		from: "shown",
		fromRank: 0,
	})),
	...base(id),
});

describe("summarizeLog", () => {
	it("is all zeros for an empty log", () => {
		const s = summarizeLog([]);
		expect(s.events).toBe(0);
		expect(s.episodes).toBe(0);
		expect(s.firstT).toBeNull();
		expect(s.tapSolves.medianBestPx).toBeNull();
		expect(formatSummary(s)).toContain("not ground truth");
	});

	it("classifies episodes and the pick-rank histogram", () => {
		const s = summarizeLog([
			shown("a", 0), // kept: picked the candidate that equals the shown pose
			pickRank("a", 0),
			shown("b", 0), // different rank
			pickRank("b", 2),
			shown("c", -1), // kept via the explicit shown chip
			pickRank("c", -1, "shown"),
			shown("d", 1), // dismissed
			dismiss("d"),
			shown("e", 1), // left open
			shown("f", 0, "s2"), // tap pick, other session
			{ ...solve("f", [3, 40]), session: "s2" },
			{ ...pickRank("f", 0, "tap"), session: "s2" },
		]);
		expect(s.sessions).toBe(2);
		expect(s.photos).toBe(6);
		expect(s.episodes).toBe(6);
		expect(s.outcomes).toEqual({
			keptShown: 2,
			differentRank: 1,
			tapPeak: 1,
			dismissed: 1,
			noDecision: 1,
		});
		expect(s.pickRanks).toEqual({ "0": 1, "2": 1, shown: 1 });
		expect(s.episodesWithTap).toBe(1);
		expect(s.tapSolves).toMatchObject({
			count: 1,
			consistent: 1,
			picked: 1,
			medianBestPx: 3,
		});
	});

	it("reopening on the same photo starts a new episode; a late dismiss keeps a pick", () => {
		const s = summarizeLog([
			shown("a", 0),
			dismiss("a"),
			shown("a", 0),
			pickRank("a", 1),
			dismiss("a"),
		]);
		expect(s.episodes).toBe(2);
		expect(s.outcomes.dismissed).toBe(1);
		expect(s.outcomes.differentRank).toBe(1);
	});

	it("counts poor / empty tap solves and orphan events", () => {
		const s = summarizeLog([
			solve("a", []),
			solve("a", [30, 50]),
			solve("a", [5]),
			pickRank("zz", 1),
			dismiss("zz"),
		]);
		expect(s.tapSolves).toMatchObject({
			count: 3,
			consistent: 1,
			poorOrEmpty: 2,
		});
		expect(s.orphanEvents).toBe(2);
		expect(s.tapSolves.medianBestPx).toBe(17.5);
	});
});
