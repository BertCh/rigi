// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import {
	beatSpan,
	FILM_EASE,
	FILM_MOTION,
	filmFrame,
	filmPlan,
	loopFrame,
	pickTickColumns,
	ridePoint,
	rowAt,
	settleMs,
} from "../viz/storyFilm";

const accepted = filmPlan({ accepted: true, names: 3, ticks: 5, pulses: 3 });
const refused = filmPlan({ accepted: false, names: 3, ticks: 5, pulses: 3 });

/** Samples a frame field every `step` ms over the whole plan. */
const sample = <T>(
	plan: typeof accepted,
	pick: (f: ReturnType<typeof filmFrame>) => T,
	step = 10,
) => {
	const out: { ms: number; v: T }[] = [];
	for (let ms = 0; ms <= plan.total; ms += step)
		out.push({ ms, v: pick(filmFrame(plan, ms)) });
	return out;
};

describe("film plan", () => {
	it("tells guess, measure, correct, then snap or keep, in grammar kinds", () => {
		expect(accepted.beats.map((b) => [b.id, b.kind])).toEqual([
			["guess", "setup"],
			["measure", "evidence"],
			["correct", "change"],
			["snap", "result"],
		]);
		expect(refused.beats.at(-1)?.id).toBe("keep");
		// beats are contiguous; the result holds beat × resultHold
		for (let i = 1; i < 4; i++)
			expect(accepted.beats[i].start).toBe(accepted.beats[i - 1].end);
		const last = accepted.beats[3];
		expect(last.end - last.start).toBe(
			Math.round(FILM_MOTION.beat * FILM_MOTION.resultHold),
		);
		expect(accepted.total).toBe(last.end);
	});

	it("gives the trace more time on the skyline page", () => {
		const trace = filmPlan({ accepted: true, focus: "trace" });
		expect(trace.beats[1].end - trace.beats[1].start).toBeGreaterThan(
			accepted.beats[1].end - accepted.beats[1].start,
		);
	});

	it("spans a beat from its start to its end, clamped", () => {
		expect(beatSpan(accepted, 2)).toEqual([
			accepted.beats[2].start,
			accepted.beats[2].end,
		]);
		expect(beatSpan(accepted, 9)).toEqual(beatSpan(accepted, 3));
	});
});

describe("film frame", () => {
	it("starts on the bare photo and ends on the whole story (accepted)", () => {
		const a = filmFrame(accepted, 0);
		expect(a.priorWipe).toBe(0);
		expect(a.t).toBe(0);
		expect(a.names.every((v) => v === 0)).toBe(true);
		const z = filmFrame(accepted, accepted.total);
		expect(z.t).toBe(1);
		expect(z.beat).toBe(3);
		expect(z.priorGhost).toBe(1);
		expect(z.strikes.every((v) => v === 1)).toBe(true);
		expect(z.pulses.every((v) => v === 1)).toBe(true);
		for (const k of [
			"priorWipe",
			"skylineWipe",
			"tracedNote",
			"solvedLine",
			"arc",
			"numbers",
			"ring",
			"verdict",
			"readoutSolved",
			"spillReveal",
		] as const)
			expect(z[k], k).toBe(1);
		expect(z.readoutPrior).toBe(0);
		expect(z.moving).toBe(0);
	});

	it("ends a refused story at the guess, nothing struck, the stamp shown", () => {
		const z = filmFrame(refused, refused.total);
		expect(z.t).toBe(0);
		expect(z.priorGhost).toBe(0);
		expect(z.strikes.every((v) => v === 0)).toBe(true);
		expect(z.verdict).toBe(1);
		expect(z.readoutPrior).toBe(1);
		expect(z.readoutSolved).toBe(0);
		// the turn did go out before it came back
		expect(Math.max(...sample(refused, (f) => f.t).map((s) => s.v))).toBe(1);
	});

	it("moves the pose only in the correct beat (and the keep beat), monotonically out", () => {
		const [, , correct] = accepted.beats;
		const ts = sample(accepted, (f) => f.t);
		for (const { ms, v } of ts) {
			if (ms < correct.start) expect(v).toBe(0);
			if (ms >= correct.end) expect(v).toBe(1);
		}
		for (let i = 1; i < ts.length; i++)
			expect(ts[i].v).toBeGreaterThanOrEqual(ts[i - 1].v - 1e-9);
	});

	it("never shows a gap number while the camera is between poses", () => {
		for (const plan of [accepted, refused])
			for (const { v } of sample(plan, (f) => f)) {
				if (v.t > 0.001 && v.t < 0.999) {
					expect(v.readoutPrior).toBe(0);
					expect(v.readoutSolved).toBe(0);
				}
			}
	});

	it("always draws one horizon line during the turn (moving hands over to solved)", () => {
		for (const { v } of sample(accepted, (f) => f)) {
			if (v.t > 0 && v.t < 1) expect(v.moving).toBe(1);
			if (v.t === 1) expect(v.moving + v.solvedLine).toBeCloseTo(1, 6);
		}
	});

	it("enters layers in causal order: guess, trace, ticks, turn, strikes", () => {
		const first = (pick: (f: ReturnType<typeof filmFrame>) => number) =>
			sample(accepted, pick, 5).find((s) => s.v > 0)?.ms ?? Infinity;
		const order = [
			first((f) => f.priorWipe),
			first((f) => f.names[0]),
			first((f) => f.skylineWipe),
			first((f) => f.ticks[0]),
			first((f) => f.t),
			first((f) => f.numbers),
			first((f) => f.strikes[0]),
			first((f) => f.ring),
			first((f) => f.verdict),
		];
		for (let i = 1; i < order.length; i++)
			expect(order[i]).toBeGreaterThan(order[i - 1]);
		// the margins come up on the guessed horizon's front, never before it
		for (const { v } of sample(accepted, (f) => f))
			expect(v.spillReveal).toBeLessThanOrEqual(v.priorWipe + 1e-9);
	});

	it("staggers siblings in index order", () => {
		const ms = accepted.beats[0].start + 1400;
		const f = filmFrame(accepted, ms);
		expect(f.names[0]).toBeGreaterThanOrEqual(f.names[1]);
		expect(f.names[1]).toBeGreaterThanOrEqual(f.names[2]);
	});

	it("keeps every value in 0..1", () => {
		for (const plan of [
			accepted,
			refused,
			filmPlan({ accepted: true, focus: "tap", names: 2, ticks: 3, pulses: 2 }),
		])
			for (const { v } of sample(plan, (f) => f, 29)) {
				for (const [k, x] of Object.entries(v)) {
					const xs = Array.isArray(x) ? x : [x];
					for (const n of xs) {
						if (k === "beat") continue;
						expect(n, k).toBeGreaterThanOrEqual(0);
						expect(n, k).toBeLessThanOrEqual(1);
					}
				}
			}
	});
});

describe("loop", () => {
	it("plays, holds, fades the overlay over replayFade, and starts again", () => {
		expect(loopFrame(accepted, 100)).toEqual(filmFrame(accepted, 100));
		const mid = loopFrame(
			accepted,
			accepted.total + FILM_MOTION.replayFade / 2,
		);
		expect(mid.overlay).toBeCloseTo(0.5, 6);
		expect(mid.t).toBe(1);
		const again = loopFrame(
			accepted,
			accepted.total + FILM_MOTION.replayFade + 100,
		);
		expect(again).toEqual(filmFrame(accepted, 100));
	});
});

describe("easing", () => {
	it("starts at 0, ends at 1 and is monotone", () => {
		for (const e of Object.values(FILM_EASE)) {
			expect(e(0)).toBeCloseTo(0, 5);
			expect(e(1)).toBeCloseTo(1, 5);
			let prev = -1;
			for (let u = 0; u <= 1; u += 0.01) {
				const y = e(u);
				expect(y).toBeGreaterThanOrEqual(prev - 1e-9);
				prev = y;
			}
		}
		// inOut is symmetric about the middle
		expect(FILM_EASE.inOut(0.5)).toBeCloseTo(0.5, 3);
	});
});

describe("geometry helpers", () => {
	it("reads a polyline's y at x by linear interpolation", () => {
		const pts: [number, number][] = [
			[0, 10],
			[10, 20],
			[20, 0],
		];
		expect(rowAt(pts, 5)).toBeCloseTo(15, 9);
		expect(rowAt(pts, 15)).toBeCloseTo(10, 9);
		expect(rowAt(pts, 30)).toBeNull();
	});

	it("picks confident tick columns spread across the frame", () => {
		const W = 100;
		const rows = Array.from({ length: W }, (_, x) => (x % 7 === 0 ? null : 50));
		const weight = Array.from({ length: W }, (_, x) => (x % 10) / 10);
		const prior = Array.from({ length: W }, () => 40);
		const cols = pickTickColumns(rows, weight, prior, 5);
		expect(cols).toHaveLength(5);
		for (let i = 1; i < cols.length; i++)
			expect(cols[i]).toBeGreaterThan(cols[i - 1]);
		for (const x of cols) {
			expect(rows[x]).not.toBeNull();
			expect(weight[x]).toBeGreaterThanOrEqual(0.4);
		}
	});

	it("rides a summit exactly from its measured guess to its measured solve", () => {
		const project = (t: number): [number, number] => [100 + 50 * t, 40 - 4 * t];
		const prior: [number, number] = [101, 40.4];
		const solved: [number, number] = [149, 36.2];
		expect(ridePoint(project, prior, solved, 0)).toEqual(prior);
		const end = ridePoint(project, prior, solved, 1);
		expect(end[0]).toBeCloseTo(solved[0], 9);
		expect(end[1]).toBeCloseTo(solved[1], 9);
		const mid = ridePoint(project, prior, solved, 0.5);
		expect(mid[0]).toBeCloseTo(125, 9);
	});
});

describe("stepper stops", () => {
	it.each([
		["accepted", accepted],
		["refused", refused],
	])("%s: one ms before a beat's end is still that beat, settled", (_, plan) => {
		plan.beats.forEach((_b, i) => {
			const ms = settleMs(plan, i);
			expect(ms).toBe(beatSpan(plan, i)[1] - 1);
			expect(filmFrame(plan, ms).beat).toBe(i);
		});
		// the end itself reports the next beat; the plan's total stays on the last
		expect(filmFrame(accepted, beatSpan(accepted, 0)[1]).beat).toBe(1);
		expect(filmFrame(accepted, accepted.total).beat).toBe(3);
	});

	it("the correct beat settles with the camera turned and its numbers shown", () => {
		const f = filmFrame(accepted, settleMs(accepted, 2));
		expect(f.t).toBeCloseTo(1, 3);
		expect(f.numbers).toBeCloseTo(1, 3);
	});
});
