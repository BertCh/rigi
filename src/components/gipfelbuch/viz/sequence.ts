// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { type RefObject, useEffect, useLayoutEffect, useState } from "react";
import { revealsImmediately } from "./hooks";

// Sequence explainers (Compare, Stages, Steps, Details): the timing and the static-state rules, as pure
// functions where they can be, so they can be specced. Spec: reports/gipfelbuch-explainers-2026-10-02/C-sequences.md.
// The durations are the grammar's motion tokens (grammar.md §1.1); they move to viz/motion.ts when it lands.

/** Pause before the first beat (grammar `MOTION.lead`). */
export const SEQUENCE_LEAD_MS = 80;
/** Dwell of the Compare setup beat (the guess alone): half of `MOTION.beat`. */
export const COMPARE_SETUP_MS = 1400;
/** The Compare change beat: a programmed scrub from the guess to the split (`MOTION.beat`). */
export const COMPARE_SCRUB_MS = 2800;
/**
 * The longest the wipe goes without handing its position to React (story time, side map, spill): one
 * frame at the grammar's 30 fps cap (`MOTION.fps`), so the margins follow smoothly without a React
 * render on every pointer move.
 */
export const COMPARE_COMMIT_MS = 33;
/** A key press moves the wipe by this share of the frame. */
export const COMPARE_KEY_STEP = 0.05;

/** Grammar `EASE.inOut` (a programmed scrub between two states): cubic in-out, symmetric about 0.5. */
export function easeInOut(t: number): number {
	const u = Math.min(1, Math.max(0, t));
	return u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2;
}

/**
 * The Compare intro script `ms` after it started: the setup beat shows the guess alone (x = 1, all
 * "before"), then the change beat scrubs to `start`, where the result rests. `done` once it rests.
 */
export function compareIntroX(
	ms: number,
	start: number,
): { x: number; done: boolean } {
	const scrubFrom = SEQUENCE_LEAD_MS + COMPARE_SETUP_MS;
	if (ms <= scrubFrom) return { x: 1, done: false };
	const t = (ms - scrubFrom) / COMPARE_SCRUB_MS;
	if (t >= 1) return { x: start, done: true };
	return { x: 1 + (start - 1) * easeInOut(t), done: false };
}

/** Where a key press moves the wipe, or null for a key the wipe does not handle. */
export function compareKeyX(key: string, x: number): number | null {
	const clamp = (v: number) => Math.min(1, Math.max(0, v));
	switch (key) {
		case "ArrowLeft":
			return clamp(x - COMPARE_KEY_STEP);
		case "ArrowRight":
			return clamp(x + COMPARE_KEY_STEP);
		case "Home":
			return 0;
		case "End":
			return 1;
		default:
			return null;
	}
}

/**
 * The side that fills more of the frame at wipe position `x` ("before" shows left of x). Its label is
 * read out as the slider's value text and drawn at full ink; ties go to "before".
 */
export function compareSide(x: number): "before" | "after" {
	return x >= 0.5 ? "before" : "after";
}

/** Draw-on of one route segment (`.nb-draw` in notebook.css, grammar `MOTION.draw`). */
export const STEPS_DRAW_MS = 900;
/** A station has faded in this long before the pen leaves it. */
export const STEPS_SEGMENT_LEAD_MS = 150;
/**
 * Time from one station to the next. The pen reaches about 70 % of a segment 60 % into its draw (the
 * draw easing is slow at both ends), so the next station fades in as the pen arrives at it.
 */
export const STEPS_PERIOD_MS = Math.round(
	STEPS_SEGMENT_LEAD_MS + 0.6 * STEPS_DRAW_MS,
);

/** When station `i` of a route topo fades in, in ms after the figure is in view. */
export function stepsStationDelay(i: number): number {
	return i * STEPS_PERIOD_MS;
}

/** When the route segment below station `i` starts to draw (or, dashed, to fade in). */
export function stepsSegmentDelay(i: number): number {
	return stepsStationDelay(i) + STEPS_SEGMENT_LEAD_MS;
}

/**
 * The stage index Stages first renders: the last one, the result frame (grammar §4: the static state
 * is the result). The client steps back to the first stage only where motion is allowed.
 */
export function stagesInitialIndex(count: number): number {
	return Math.max(0, count - 1);
}

/** The React key of stage `i`'s frame: stages sharing a `frame` key keep one mounted frame. */
export function stageFrameKey(stage: { frame?: string }, i: number): string {
	return stage.frame != null ? `frame:${stage.frame}` : `stage:${i}`;
}

/**
 * False on the server and first paint; on the client, true unless reduced motion, webdriver automation,
 * print or a missing IntersectionObserver ask for the static frame (grammar `useMotionAllowed`, which
 * replaces this when viz/motion.ts lands).
 */
export function useSequenceMotion(reduce: boolean): boolean {
	const [allowed, setAllowed] = useState(false);
	// before paint, so a client mount steps to its first beat without painting the result frame first
	useIsomorphicLayoutEffect(() => {
		setAllowed(!reduce && !revealsImmediately());
		const off = () => setAllowed(false);
		const back = () => setAllowed(!reduce && !revealsImmediately());
		window.addEventListener("beforeprint", off);
		window.addEventListener("afterprint", back);
		return () => {
			window.removeEventListener("beforeprint", off);
			window.removeEventListener("afterprint", back);
		};
	}, [reduce]);
	return allowed;
}

const useIsomorphicLayoutEffect =
	typeof window === "undefined" ? useEffect : useLayoutEffect;

/** Opens a closed `<details>` for printing and closes it again afterwards. */
export function useOpenForPrint(ref: RefObject<HTMLDetailsElement | null>) {
	useEffect(() => {
		let openedForPrint = false;
		const before = () => {
			const el = ref.current;
			if (el && !el.open) {
				el.open = true;
				openedForPrint = true;
			}
		};
		const after = () => {
			if (openedForPrint && ref.current) ref.current.open = false;
			openedForPrint = false;
		};
		window.addEventListener("beforeprint", before);
		window.addEventListener("afterprint", after);
		return () => {
			window.removeEventListener("beforeprint", before);
			window.removeEventListener("afterprint", after);
		};
	}, [ref]);
}
