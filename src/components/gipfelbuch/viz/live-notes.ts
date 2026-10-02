// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

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
