// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Pure helpers behind the photo story's film (PhotoStory.tsx): path and tick geometry, the beat to
// layer table, the heading needle's rule, the arming and commit decisions. No DOM, so they are specced
// (__tests__/story-geometry.spec.ts).

import { signedDegrees } from "../notebook/notes";
import type { PhotoLayer } from "./inks";
import type { GipfelbuchPeak, GipfelbuchPhotoData } from "./real";
import {
	beatSpan,
	type FilmBeatId,
	type FilmFrame,
	type FilmPlan,
	rowAt,
} from "./storyFilm";

type Point = [number, number];
type Rows = readonly (number | null)[];

/** What the margins' echo and the solved peak labels show in each beat (the strokes are the film's own). */
export const BEAT_LAYERS: Record<FilmBeatId, PhotoLayer[]> = {
	guess: ["prior"],
	measure: ["prior", "skyline"],
	correct: ["prior", "skyline", "solved"],
	snap: ["prior", "skyline", "solved", "peaks"],
	keep: ["prior", "skyline", "solved"],
};

/**
 * The moving DEM horizon as an SVG path over columns [x0 - margin, x1 + margin]; it breaks wherever two
 * consecutive points are more than `maxJump` px apart in x (a wrap or a gap in the profile).
 */
export function horizonPathAt(
	points: readonly Point[] | null,
	x0: number,
	x1: number,
	margin = 20,
	maxJump = 40,
): string {
	if (!points) return "";
	let d = "";
	let prev: number | null = null;
	for (const [x, y] of points) {
		if (!(x >= x0 - margin && x <= x1 + margin) || !Number.isFinite(y)) {
			prev = null;
			continue;
		}
		d += `${prev == null || Math.abs(x - prev) > maxJump ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
		prev = x;
	}
	return d;
}

/**
 * The horizon's row at column `x` for pose `t`: exactly the measured prior row at 0 and the solved row
 * at 1; between them the moving DEM horizon, or (no bake) a straight mix of the two measured rows.
 */
export function horizonRowAt(
	priorRows: Rows,
	solvedRows: Rows,
	points: readonly Point[] | null,
	column: number,
	t: number,
): number | null {
	const a = priorRows[column] ?? null;
	const b = solvedRows[column] ?? null;
	if (t <= 0) return a;
	if (t >= 1) return b;
	const live = points ? rowAt(points, column + 0.5) : null;
	if (live != null) return live;
	return a != null && b != null ? a + (b - a) * t : null;
}

/** A gap tick: from the horizon row `hy` toward the trace row `sy`, grown by `grow` (0..1). */
export function gapTick(hy: number, sy: number, grow: number) {
	const gap = sy - hy;
	return {
		y1: hy,
		y2: hy + gap * grow,
		gap,
		/** Red where the gap is 5 px or more, the solved ink where it has closed. */
		red: Math.abs(gap) >= 5,
		/** Stronger for a larger gap. */
		weight: 0.35 + 0.6 * Math.min(1, Math.abs(gap) / 40),
	};
}

/** A tick's opacity: its growth, the gap's weight, and the fade in the result beat (unless gaps is the focus). */
export function tickOpacity(
	grow: number,
	weight: number,
	verdict: number,
	keepGaps: boolean,
): number {
	return grow * weight * (keepGaps ? 1 : 1 - verdict);
}

/** A rider's opacity: the names that travel with the camera, then hand over to the solved labels. */
export function riderOpacity(
	accepted: boolean,
	t: number,
	pulse: number,
): number {
	if (accepted) return t > 0 ? 1 - pulse : 0;
	return t > 0 && t < 1 ? 1 : 0;
}

/** The heading needle on the spill's ruler: from the correct beat on, labelled only at the two measured poses. */
export function spillCursorFor(
	yawAt: (t: number) => number,
	beat: number,
	t: number,
	tap?: { az: number; name: string } | null,
): { az: number; label: string; layer: PhotoLayer } | null {
	if (beat < 2) return null;
	// focus "tap": while the camera has not turned yet, the needle sits on the tapped summit
	if (tap && beat === 2 && t === 0)
		return { az: tap.az, label: `tap: ${tap.name}`, layer: "solved" };
	const az = yawAt(t);
	return {
		az,
		label: t === 0 || t === 1 ? `${az.toFixed(1)}°` : "…",
		layer: "solved",
	};
}

/** Share of the figure (or of the viewport, for a taller figure) that is in view. */
export const viewShare = (
	intersectHeight: number,
	boxHeight: number,
	viewportHeight: number,
) => {
	const denom = Math.min(boxHeight, viewportHeight);
	return denom > 0 ? intersectHeight / denom : 0;
};

/** Grammar §1.5 (v0.2): a sequence arms at 45 % in view; below 20 % it pauses (and a finished film re-arms). */
export const ARM_SEQUENCE = 0.45;
export const ARM_RESET = 0.2;
/** Pointer rest (ms) on a finished photo before it replays (grammar `hoverReplay`). */
export const HOVER_REPLAY_MS = 350;

export const nextArmed = (
	armed: boolean,
	share: number,
	arm = ARM_SEQUENCE,
	reset = ARM_RESET,
) => (share >= arm ? true : share < reset ? false : armed);

/** React gets the pose at most every `minGap` ms while it changes, and always at the endpoints. */
export function shouldCommitT(
	last: number | null,
	next: number,
	lastAt: number,
	now: number,
	minGap = 33,
): boolean {
	if (next === last) return false;
	if (last == null || next === 0 || next === 1) return true;
	return now - lastAt >= minGap;
}

/** The stepper hairlines: 1 for past beats, the current beat's progress, 0 for future beats. */
export const hairlineScales = (
	frame: Pick<FilmFrame, "beat" | "progress">,
	n: number,
): number[] =>
	Array.from({ length: n }, (_, i) =>
		i < frame.beat ? 1 : i === frame.beat ? frame.progress : 0,
	);

/** The clock time under a drag at `fraction` (0..1) of the hairline row, one equal segment per beat. */
export function scrubMs(plan: FilmPlan, fraction: number): number {
	const n = plan.beats.length;
	const f = Math.max(0, Math.min(1, fraction)) * n;
	const i = Math.min(n - 1, Math.floor(f));
	const [start, end] = beatSpan(plan, i);
	return start + (f - i) * (end - start);
}

/** The beat an arrow key moves to (clamped). */
export const stepBeat = (i: number, dir: -1 | 1, n: number) =>
	Math.max(0, Math.min(n - 1, i + dir));

/** The tab label of a beat. */
export const beatLabel = (id: FilmBeatId, focus?: string): string =>
	id === "correct" && focus === "search" ? "search" : id;

/** The measured solved line's opacity: its fade-in (or, with no bake to move, the pose), dimmed once a refused solve is kept. */
export function solvedAlpha(
	frame: Pick<FilmFrame, "solvedLine" | "t" | "beat">,
	hasMoving: boolean,
	accepted: boolean,
	lastBeat: number,
): number {
	const base = hasMoving
		? frame.solvedLine
		: Math.max(frame.solvedLine, frame.t);
	return base * (!accepted && frame.beat === lastBeat ? 0.55 : 1);
}

// --- the per-page focus notes (pure text, from the photo JSON only) --------------

/** Non-null skyline rows in columns [x0, x1). */
export function countTraced(rows: Rows, x0: number, x1: number): number {
	let n = 0;
	for (let x = Math.max(0, Math.floor(x0)); x < Math.min(rows.length, x1); x++)
		if (rows[x] != null) n++;
	return n;
}

/** The note on the traced skyline: the trace page says how many columns and what the bars mean. */
export const tracedNoteText = (focus: string | undefined, columns: number) =>
	focus === "trace"
		? `traced ${columns} columns; tall bars = sure`
		: "traced skyline";

/** The note on the guessed pose: the phone's sensors on the prior page, its yaw and pitch elsewhere. */
export const poseNoteText = (
	d: Pick<GipfelbuchPhotoData, "prior" | "sensor">,
	focus?: string,
) =>
	focus === "prior"
		? `compass ${d.sensor.heading.toFixed(1)}°, tilt ${d.sensor.pitch.toFixed(1)}°, ${d.sensor.f35.toFixed(0)} mm`
		: `phone's guess: yaw ${d.prior.yaw.toFixed(1)}°, pitch ${d.prior.pitch.toFixed(1)}°`;

/** The eye-height note (focus "eye"): where the GPS altitude sits against the ground. */
export function eyeNoteText(d: Pick<GipfelbuchPhotoData, "gps">): string {
	const { alt, ground, eye } = d.gps;
	return ground - alt > 20
		? `GPS ${alt.toFixed(0)} m is ${(ground - alt).toFixed(0)} m under the ground → eye at ${eye.toFixed(0)} m`
		: `eye at GPS ${eye.toFixed(0)} m, above the ground (${ground.toFixed(0)} m)`;
}

/** The solved gap readout: one number normally, the whole residual (prior → solved) on the gaps page. */
export function solvedReadoutText(
	d: Pick<GipfelbuchPhotoData, "residual">,
	focus?: string,
): string {
	const { prior, solved } = d.residual;
	return focus === "gaps"
		? `median ${prior.median.toFixed(1)}→${solved.median.toFixed(1)} px · p90 ${prior.p90.toFixed(0)}→${solved.p90.toFixed(0)} · ≤5 px ${Math.round(prior.within5 * 100)}%→${Math.round(solved.within5 * 100)}%`
		: `gap ${solved.median.toFixed(1)} px`;
}

/** The turn's numbers: yaw, pitch, and one extra line on the pages that explain more of the turn. */
export function turnNumbers(
	d: Pick<GipfelbuchPhotoData, "solved">,
	focus?: string,
): { yaw: string; pitch: string; extra: string | null } {
	const { delta } = d.solved;
	return {
		yaw: `${signedDegrees(delta.yaw)} yaw`,
		pitch: `${signedDegrees(delta.pitch)} pitch`,
		extra:
			focus === "gaps"
				? `${signedDegrees(delta.roll)} roll · focal ×${delta.focal.toFixed(2)}`
				: focus === "prior"
					? `compass off by ${Math.abs(delta.yaw).toFixed(1)}°`
					: null,
	};
}

/** How far a summit moved between the guess and the solve, in working px (null if either is off). */
export function movedPx(p: Pick<GipfelbuchPeak, "prior" | "solved">) {
	return p.prior && p.solved
		? Math.round(Math.hypot(p.solved[0] - p.prior[0], p.solved[1] - p.prior[1]))
		: null;
}
