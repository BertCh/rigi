// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * Pure maths for the paper surround that follows a live plate's photo (live.tsx): the bloom front
 * of site/RevealLoop carried onto the margins, and the before/after wipe's left side.
 */

/** A photo's place in its surround canvas (fractions of the canvas), as in a SurroundBake. */
export interface SurroundPhoto {
	x: number;
	y: number;
	w: number;
	h: number;
}

// Must match site/RevealLoop.tsx (CENTRE, RADIUS, FULL), which does not export them: the bloom's
// ellipse in photo fractions, and the radius (%) at which RevealLoop rests once the photo is lit.
const CENTRE = { x: 0.5, y: 1.15 };
const RADIUS = { x: 1.4, y: 1.2 };
export const PHOTO_FULL = 135;

/** The surround's own vars, so a margin never reads the photo's: unset means fully lit (static). */
export const REVEAL_VAR = "--gb-reveal";
export const REVEAL_OPACITY_VAR = "--gb-reveal-opacity";

const pc = (v: number) => `${(v * 100).toFixed(2)}%`;

/**
 * The photo's bloom ellipse in a canvas that holds the photo at `photo`. A radius in % is relative to
 * the ellipse, which scales with the canvas, so the same % is the same front on photo and margin.
 */
export function surroundRevealAt(photo: SurroundPhoto): string {
	return `ellipse ${pc(RADIUS.x * photo.w)} ${pc(RADIUS.y * photo.h)} at ${pc(photo.x + CENTRE.x * photo.w)} ${pc(photo.y + CENTRE.y * photo.h)}`;
}

/** Fill (lit behind the front) and front-band masks; without the var they are fully lit. */
export function surroundRevealMasks(at: string): {
	fill: string;
	front: string;
} {
	const r = `var(${REVEAL_VAR}, 999%)`;
	return {
		fill: `radial-gradient(${at}, #000 calc(${r} - 6%), transparent ${r})`,
		front: `radial-gradient(${at}, transparent calc(${r} - 9%), #000 calc(${r} - 3%), transparent calc(${r} + 1%))`,
	};
}

/** Radius (%) at which every corner of the canvas is past the front band (RevealLoop's fullRadius). */
export function surroundFullRadius(photo: SurroundPhoto): number {
	const xs = [-photo.x / photo.w, (1 - photo.x) / photo.w];
	const ys = [-photo.y / photo.h, (1 - photo.y) / photo.h];
	let far = 0;
	for (const x of xs)
		for (const y of ys)
			far = Math.max(
				far,
				Math.hypot((x - CENTRE.x) / RADIUS.x, (y - CENTRE.y) / RADIUS.y),
			);
	return Math.max(PHOTO_FULL, far * 100 + 12);
}

/**
 * The margin's radius for the photo's radius `r` (%): the same front while the bloom runs. Once the
 * photo rests lit (RevealLoop stops at PHOTO_FULL), the margin goes on to its own full radius over
 * `settle`, so a wide surround (demo-09) lights its far corners instead of stopping short of them.
 */
export function mirrorRevealRadius(
	r: number,
	surroundFull: number,
): { radius: number; settle: boolean } {
	return r >= PHOTO_FULL - 0.05 && surroundFull > PHOTO_FULL
		? { radius: surroundFull, settle: true }
		: { radius: r, settle: false };
}

/**
 * Strength of the left side's spill beside a before/after wipe at divider `v` (0 = all after,
 * 1 = all before): only near the far left is the photo's left edge the overlay too (the landing's ramp).
 */
export function compareLeftSpill(v: number): number {
	return Math.min(1, Math.max(0, (0.12 - v) / 0.1));
}

/** Where site/Compare's divider starts. */
export const COMPARE_START = 0.42;
