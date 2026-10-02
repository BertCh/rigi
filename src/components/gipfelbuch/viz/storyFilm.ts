// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The photo story as a film: one clock (ms) → one frame of 0..1 values that PhotoStory writes onto the
// DOM. Pure, so the script is specced (__tests__/story-film.spec.ts) and the static frame is just
// `filmFrame(plan, plan.total)`. Beats follow the explainer grammar
// (reports/gipfelbuch-explainers-2026-10-02/grammar.md §1.3): guess = setup, measure = evidence,
// correct = change (the camera turns), snap = result; a refused solve ends on "keep", a result that
// turns the camera back to the guess. Pose t: 0 = the phone's guess, 1 = the solved pose; values in
// between are a visual tween between the two measured poses, never a number shown to the reader.

/** Grammar §1.1 durations (ms), mirrored until viz/motion.ts lands; each names its token. */
export const FILM_MOTION = {
	lead: 80, // grammar: MOTION.lead
	fade: 420, // grammar: MOTION.fade
	replayFade: 450, // grammar: MOTION.replayFade
	settle: 620, // grammar: MOTION.settle
	draw: 900, // grammar: MOTION.draw
	trace: 1300, // grammar: MOTION.trace (the eye's pass over the skyline, linear)
	mark: 280, // grammar: MOTION.mark (a hand mark: a strike)
	beat: 2800, // grammar: MOTION.beat
	stagger: 110, // grammar: MOTION.stagger
	staggerLabel: 60, // grammar: MOTION.staggerLabel
	resultHold: 1.6, // grammar: MOTION.resultHold (a factor of beat)
	/** The camera turn: a programmed scrub between two poses (proposed to pod G as MOTION.turn). */
	turn: 1600,
} as const;

const M = FILM_MOTION;

/** Grammar §1.2 easings as functions of u ∈ [0, 1]. */
const clamp01 = (u: number) => (u <= 0 ? 0 : u >= 1 ? 1 : u);
/** cubic-bezier(x1, y1, x2, y2) solved for y at x (Newton, then bisection). */
function bezier(x1: number, y1: number, x2: number, y2: number) {
	const cx = 3 * x1;
	const bx = 3 * (x2 - x1) - cx;
	const ax = 1 - cx - bx;
	const cy = 3 * y1;
	const by = 3 * (y2 - y1) - cy;
	const ay = 1 - cy - by;
	const sx = (s: number) => ((ax * s + bx) * s + cx) * s;
	const sy = (s: number) => ((ay * s + by) * s + cy) * s;
	const dx = (s: number) => (3 * ax * s + 2 * bx) * s + cx;
	return (u: number) => {
		const x = clamp01(u);
		let s = x;
		for (let i = 0; i < 6; i++) {
			const e = sx(s) - x;
			const d = dx(s);
			if (Math.abs(e) < 1e-6) return sy(s);
			if (Math.abs(d) < 1e-6) break;
			s -= e / d;
		}
		let lo = 0;
		let hi = 1;
		s = x;
		for (let i = 0; i < 30; i++) {
			if (sx(s) < x) lo = s;
			else hi = s;
			s = (lo + hi) / 2;
		}
		return sy(s);
	};
}
export const FILM_EASE = {
	out: (u: number) => 1 - (1 - clamp01(u)) ** 3, // grammar: EASE.out
	draw: bezier(0.55, 0.1, 0.3, 1), // grammar: EASE.draw
	inOut: bezier(0.65, 0, 0.35, 1), // grammar: EASE.inOut
	linear: clamp01,
};

/** 0..1 progress of an event that starts at `at` (ms) and lasts `dur`, eased. */
const ramp = (
	ms: number,
	at: number,
	dur: number,
	ease: (u: number) => number = FILM_EASE.out,
) => (dur <= 0 ? (ms >= at ? 1 : 0) : ease((ms - at) / dur));

export type StoryFocus =
	| "trace"
	| "gaps"
	| "snap"
	| "eye"
	| "prior"
	| "tap"
	| "search";
export type FilmBeatId = "guess" | "measure" | "correct" | "snap" | "keep";
export type FilmBeatKind = "setup" | "evidence" | "change" | "result";
export interface FilmBeat {
	id: FilmBeatId;
	kind: FilmBeatKind;
	start: number;
	end: number;
}
export interface FilmPlan {
	beats: FilmBeat[];
	/** The settled frame's time (ms); the static, print and webdriver frame. */
	total: number;
	accepted: boolean;
	focus?: StoryFocus;
	/** How many guessed names, gap ticks and snap pulses the figure draws. */
	names: number;
	ticks: number;
	pulses: number;
}

/** Beat dwell (ms) of each beat for a story. */
function dwell(id: FilmBeatId, focus?: StoryFocus): number {
	switch (id) {
		case "measure":
			// the trace is the point of the skyline page: the eye's pass gets more time
			return M.beat + (focus === "trace" ? 800 : 0);
		case "correct":
			return M.beat;
		case "snap":
		case "keep":
			return Math.round(M.beat * M.resultHold);
		default:
			return M.beat;
	}
}

const KIND: Record<FilmBeatId, FilmBeatKind> = {
	guess: "setup",
	measure: "evidence",
	correct: "change",
	snap: "result",
	keep: "result",
};

/** The beat table for one photo: four beats, the last is "keep" when the app refused the solve. */
export function filmPlan(opts: {
	accepted: boolean;
	focus?: StoryFocus;
	names?: number;
	ticks?: number;
	pulses?: number;
}): FilmPlan {
	const ids: FilmBeatId[] = [
		"guess",
		"measure",
		"correct",
		opts.accepted ? "snap" : "keep",
	];
	let at = 0;
	const beats = ids.map((id) => {
		const b = {
			id,
			kind: KIND[id],
			start: at,
			end: at + dwell(id, opts.focus),
		};
		at = b.end;
		return b;
	});
	return {
		beats,
		total: at,
		accepted: opts.accepted,
		focus: opts.focus,
		names: opts.names ?? 0,
		ticks: opts.ticks ?? 0,
		pulses: opts.pulses ?? 0,
	};
}

/** Everything the figure draws at one instant, each in 0..1 unless noted. */
export interface FilmFrame {
	/** Beat index and progress within it. */
	beat: number;
	progress: number;
	/** Pose: 0 guess .. 1 solved. */
	t: number;
	/** The margins' reveal (GeoSpill opacity), on the guessed horizon's front. */
	spillReveal: number;
	/** Left-to-right wipe of the prior horizon and of the traced skyline (fraction of the width). */
	priorWipe: number;
	skylineWipe: number;
	/** Trace-confidence bars (focus "trace"). */
	weight: number;
	/** 0 = the guess drawn full, 1 = a ghost (opacity 0.35). */
	priorGhost: number;
	/** Each guessed name's entrance. */
	names: number[];
	poseNote: number;
	tracedNote: number;
	/** Each gap tick's growth from the horizon to the trace. */
	ticks: number[];
	/** The gap readout at the guess (shown at t = 0) and at the solve (t = 1). */
	readoutPrior: number;
	readoutSolved: number;
	/** The DEM horizon at pose t (shown while the camera moves). */
	moving: number;
	/** The measured solved line. */
	solvedLine: number;
	/** The correction arc's pen (follows t on the way out). */
	arc: number;
	numbers: number;
	/** The red strike over each guessed name (accepted only). */
	strikes: number[];
	/** Each summit's snap ring, 0 = not started, 1 = decayed. */
	pulses: number[];
	/** The anchor summit's ring. */
	ring: number;
	/** The verdict note (accepted) or the refused stamp. */
	verdict: number;
	/** The tap ring (focus "tap"). */
	tap: number;
	/** The whole overlay's opacity (dips during a loop's replay fade). */
	overlay: number;
}

/** The frame at `ms` (clamped to the plan); `filmFrame(plan, plan.total)` is the static frame. */
export function filmFrame(plan: FilmPlan, ms: number): FilmFrame {
	const t = Math.max(0, Math.min(plan.total, ms));
	const [guess, measure, correct, last] = plan.beats;
	let beat = plan.beats.findIndex((b) => t < b.end);
	if (beat < 0) beat = plan.beats.length - 1;
	const b = plan.beats[beat];
	const progress = clamp01((t - b.start) / (b.end - b.start));

	// 1. guess (setup): the guessed horizon is drawn by hand, the margins come up on the same front,
	// then the guessed names, then the pose note
	const g0 = guess.start + M.lead;
	const priorWipe = ramp(t, g0, M.draw, FILM_EASE.draw);
	const nameAt = g0 + M.draw * 0.6;
	const names = Array.from({ length: plan.names }, (_, i) =>
		ramp(t, nameAt + i * M.staggerLabel, M.fade),
	);
	const poseNote = ramp(
		t,
		nameAt + plan.names * M.staggerLabel + M.fade * 0.5,
		M.fade,
	);

	// 2. measure (evidence): the eye's trace, then the gap at each column, then its median
	const m0 = measure.start + M.lead;
	const traceMs = plan.focus === "trace" ? M.trace + 800 : M.trace;
	const skylineWipe = ramp(t, m0, traceMs, FILM_EASE.linear);
	const tracedNote = ramp(t, m0 + traceMs, M.fade);
	const weight = plan.focus === "trace" ? ramp(t, m0 + traceMs, M.settle) : 0;
	const tickAt = m0 + traceMs + M.fade * 0.5;
	const ticks = Array.from({ length: plan.ticks }, (_, i) =>
		ramp(t, tickAt + i * M.staggerLabel, M.fade),
	);
	const readoutAt = tickAt + plan.ticks * M.staggerLabel + M.fade * 0.5;

	// 3. correct (change): the guess becomes a ghost, the camera turns (one programmed scrub), the arc's
	// pen follows the anchor, then the turn's numbers and the measured solved line
	const c0 = correct.start + M.lead;
	const tapMs = plan.focus === "tap" ? M.settle : 0;
	const turnAt = c0 + M.fade * 0.5 + tapMs;
	const out = ramp(t, turnAt, M.turn, FILM_EASE.inOut);
	const turned = turnAt + M.turn;
	const tap = plan.focus === "tap" ? ramp(t, c0, M.settle) : 0;
	const priorGhost = ramp(t, c0, M.fade);
	const numbers = ramp(t, turned, M.fade);
	const solvedLine = ramp(t, turned, M.fade);

	// 4. the result: accepted → strikes, snap rings, the anchor ring and the verdict; refused → the
	// stamp, then the camera turns back to the guess (the app keeps the phone's pose)
	const r0 = last.start + M.lead;
	let pose = out;
	let strikes = Array.from({ length: plan.names }, () => 0);
	let pulses = Array.from({ length: plan.pulses }, () => 0);
	let ring = 0;
	let verdict = 0;
	let back = 0;
	if (plan.accepted) {
		strikes = strikes.map((_, i) =>
			ramp(t, r0 + i * M.stagger, M.mark, FILM_EASE.draw),
		);
		const pulseAt = r0 + M.fade * 0.5;
		pulses = pulses.map((_, i) => ramp(t, pulseAt + i * M.stagger, M.settle));
		const ringAt = pulseAt + plan.pulses * M.stagger + M.settle * 0.5;
		ring = ramp(t, ringAt, M.draw, FILM_EASE.draw);
		verdict = ramp(t, ringAt + M.draw * 0.6, M.fade);
	} else {
		verdict = ramp(t, r0, M.fade);
		back = ramp(t, r0 + M.fade + M.settle * 0.5, M.turn, FILM_EASE.inOut);
		pose = out * (1 - back);
	}
	// a number is shown only where it is measured: the guess's gap at t = 0, the solve's at t = 1
	const readoutPrior = plan.accepted
		? ramp(t, readoutAt, M.fade) * (1 - ramp(t, c0, M.fade * 0.5))
		: ramp(t, readoutAt, M.fade) *
			(1 -
				ramp(t, c0, M.fade * 0.5) +
				ramp(t, r0 + M.fade + M.settle * 0.5 + M.turn, M.fade));
	const readoutSolved =
		ramp(t, turned + M.fade * 0.5, M.fade) *
		(plan.accepted ? 1 : 1 - ramp(t, r0 + M.fade, M.fade * 0.5));
	// the moving horizon hands over to the measured solved line as that fades in (no empty frame), and
	// in a refused story carries the turn back until the guess is drawn full again
	const moving =
		t < turnAt ? 0 : back > 0 ? (back < 1 ? 1 : 0) : 1 - solvedLine;
	return {
		beat,
		progress,
		t: pose,
		spillReveal: priorWipe,
		priorWipe,
		skylineWipe,
		weight,
		priorGhost: plan.accepted ? priorGhost : priorGhost * (1 - back),
		names,
		poseNote,
		tracedNote,
		ticks,
		readoutPrior: clamp01(readoutPrior),
		readoutSolved: clamp01(readoutSolved),
		moving,
		solvedLine,
		arc: out,
		numbers,
		strikes,
		pulses,
		ring,
		verdict,
		tap,
		overlay: 1,
	};
}

/**
 * The film under a looping clock: `ms` runs on forever; each cycle plays the plan, holds its result
 * (the plan's last beat already includes the grammar's result hold), then fades the overlay out over
 * `replayFade` and starts again (grammar §1.6 `playback: "loop"`).
 */
export function loopFrame(plan: FilmPlan, ms: number): FilmFrame {
	const cycle = plan.total + M.replayFade;
	const local = ((ms % cycle) + cycle) % cycle;
	if (local < plan.total) return filmFrame(plan, local);
	const f = filmFrame(plan, plan.total);
	return { ...f, overlay: 1 - (local - plan.total) / M.replayFade };
}

/** The clock time at which beat `i` starts, and where it settles (its end, clamped to the total). */
export function beatSpan(plan: FilmPlan, i: number): [number, number] {
	const b = plan.beats[Math.max(0, Math.min(plan.beats.length - 1, i))];
	return [b.start, b.end];
}

/**
 * Where a stepper stop settles beat `i`: one ms before its end, because the beat lookup is strict
 * (`t < end`), so `end` itself already reports the next beat. `plan.total` stays the static frame.
 */
export function settleMs(plan: FilmPlan, i: number): number {
	const [start, end] = beatSpan(plan, i);
	return Math.max(start, end - 1);
}

/** The y of a polyline (sorted by x or not) at column `x`, by linear interpolation; null off its ends. */
export function rowAt(
	points: readonly [number, number][],
	x: number,
): number | null {
	let best: number | null = null;
	let bestGap = Number.POSITIVE_INFINITY;
	for (let i = 1; i < points.length; i++) {
		const [ax, ay] = points[i - 1];
		const [bx, by] = points[i];
		const lo = Math.min(ax, bx);
		const hi = Math.max(ax, bx);
		if (x < lo || x > hi) continue;
		const gap = hi - lo;
		// across a wrap or a break the segment is wide; prefer the tightest bracket
		if (gap >= bestGap) continue;
		best = gap === 0 ? ay : ay + ((by - ay) * (x - ax)) / (bx - ax);
		bestGap = gap;
	}
	return best;
}

/**
 * Picks `n` columns for gap ticks: confident trace columns (weight ≥ `minWeight`) where both the
 * trace and the guessed horizon exist, spread evenly across the frame's width `[x0, x1)`.
 */
export function pickTickColumns(
	rows: readonly (number | null)[],
	weight: readonly number[],
	prior: readonly (number | null)[],
	n: number,
	x0 = 0,
	x1 = rows.length,
	minWeight = 0.4,
): number[] {
	const out: number[] = [];
	if (n <= 0) return out;
	const span = (x1 - x0) / n;
	for (let k = 0; k < n; k++) {
		const a = Math.round(x0 + k * span);
		const b = Math.round(x0 + (k + 1) * span);
		let best = -1;
		for (let x = a; x < b; x++) {
			if (rows[x] == null || prior[x] == null || (weight[x] ?? 0) < minWeight)
				continue;
			if (best < 0 || weight[x] > weight[best]) best = x;
		}
		if (best >= 0) out.push(best);
	}
	return out;
}

/**
 * A summit's on-photo position at pose t: the projection at t, corrected so it is exactly the
 * measured prior mark at t = 0 and the measured solved mark at t = 1 (the projector and the bake
 * agree within a pixel; this removes even that).
 */
export function ridePoint(
	project: (t: number) => [number, number],
	prior: [number, number],
	solved: [number, number],
	t: number,
): [number, number] {
	const p = project(t);
	const p0 = project(0);
	const p1 = project(1);
	return [
		p[0] + (1 - t) * (prior[0] - p0[0]) + t * (solved[0] - p1[0]),
		p[1] + (1 - t) * (prior[1] - p0[1]) + t * (solved[1] - p1[1]),
	];
}
