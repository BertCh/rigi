// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { MOTION } from "./motion";

/** Pure note helpers for the live plates (live.tsx), kept apart so node specs need no engine imports. */

/**
 * The notes whose point lies on the frame (both fractions in 0..1). With a plate's spill off, a note
 * pointing into the paper has nothing to point at, so it is dropped.
 */
export function framedNotes<T extends { at: readonly [number, number] }>(
	notes: readonly T[],
): T[] {
	return notes.filter(({ at: [x, y] }) => x >= 0 && x <= 1 && y >= 0 && y <= 1);
}

/** PenArrow starts its head this long after its shaft (notebook/Ink.tsx). */
export const LEADER_HEAD_MS = 600;
/** A filled pen stroke fades on over this long (notebook.css `nb-fade`, its draw-on substitute). */
export const STROKE_FADE_MS = 600;

/**
 * When note `i`'s leader starts and when its words fade in (ms after the plate arms): the leaders one
 * after another, a `fade` apart after the `lead`, and each note once its arrowhead has landed (head
 * start + its fade), so the reader sees where a note points before reading it.
 */
export function noteTiming(i: number): { leader: number; note: number } {
	const leader = MOTION.lead + i * MOTION.fade;
	return { leader, note: leader + LEADER_HEAD_MS + STROKE_FADE_MS };
}
