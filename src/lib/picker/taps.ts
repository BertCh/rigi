// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Tap-a-peak helpers (roadmap R4), pure and node-testable: stable tap identity, peak-menu ranking by
// fit with the taps already placed, and menu placement. No DOM, no solve; the pose and the ranking of
// the top-3 candidates are untouched.
import type { Pin } from "#/lib/align";
import { pairFitDeg } from "#/lib/pins/diagnostics";
import type { NearbyPeak } from "./candidates";

/**
 * Stable identity of a summit: its ENU position rounded to the metre (the same rounding `nearbyPeaks`
 * uses to drop duplicates). Names are not unique (Schwarzhorn, Rothorn), so taps are never keyed by name.
 */
export const peakKey = (world: ArrayLike<number>): string =>
	`${Math.round(world[0])},${Math.round(world[1])},${Math.round(world[2])}`;

/** Add `tap`, replacing an earlier tap of the same summit (same position) and nothing else. */
export function upsertTap<T extends { world: ArrayLike<number> }>(
	taps: T[],
	tap: T,
): T[] {
	const key = peakKey(tap.world);
	return [...taps.filter((t) => peakKey(t.world) !== key), tap];
}

/** Remove the tap of one summit. */
export const removeTap = <T extends { world: ArrayLike<number> }>(
	taps: T[],
	world: ArrayLike<number>,
): T[] => taps.filter((t) => peakKey(t.world) !== peakKey(world));

/** A name fits the earlier taps when no pair misses by more than this (tap error + lens slack). */
export const MENU_FIT_TOL_DEG = 1.5;

export type RankedPeak = NearbyPeak & {
	/** worst pair miss against the taps already placed (deg); 0 with no taps */
	fitDeg: number;
	/** true when `fitDeg` is over `MENU_FIT_TOL_DEG` (shown as "doesn't fit") */
	misfit: boolean;
};

/**
 * Rank the offered peaks by how well each fits the taps already placed (`pairFitDeg`, rotation-free):
 * fitting names first, in their original nearest-to-the-tap order, then misfits by growing miss.
 * With no taps the order is unchanged. Peaks already tapped are dropped from the menu.
 */
export function rankPeaksByFit(
	offered: NearbyPeak[],
	taps: Pin[],
	tapped: { u: number; v: number },
	eye: ArrayLike<number>,
	aspect: number,
	vfovRangeDeg: [number, number],
): RankedPeak[] {
	const used = new Set(taps.map((t) => peakKey(t.world)));
	const rows = offered
		.filter((o) => !used.has(peakKey(o.world)))
		.map((o, order) => {
			const fitDeg = pairFitDeg(
				taps,
				{ world: o.world, u: tapped.u, v: tapped.v },
				eye,
				aspect,
				vfovRangeDeg,
			);
			return { o, order, fitDeg, misfit: fitDeg > MENU_FIT_TOL_DEG };
		});
	rows.sort((a, b) => {
		if (a.misfit !== b.misfit) return a.misfit ? 1 : -1;
		if (a.misfit && a.fitDeg !== b.fitDeg) return a.fitDeg - b.fitDeg;
		return a.order - b.order;
	});
	return rows.map(({ o, fitDeg, misfit }) => ({ ...o, fitDeg, misfit }));
}

/** Touch-row height of the peak menu (px), the 44 pt / 48 dp minimum. */
export const MENU_ROW_PX = 44;
export const MENU_WIDTH_PX = 208;
export const MENU_PAD_PX = 6;
const MENU_GAP_PX = 8;
const MENU_HEADER_PX = 24;

/** Menu box for `rows` rows (header and the "None of these" row included), capped at `maxHeight`. */
export const menuSize = (
	rows: number,
	maxHeight = 320,
): { w: number; h: number } => ({
	w: MENU_WIDTH_PX,
	h: Math.min(
		maxHeight,
		MENU_HEADER_PX + (rows + 1) * MENU_ROW_PX + 2 * MENU_PAD_PX,
	),
});

/**
 * Top-left of the menu for a tap at `anchor`, all in one coordinate space with `bounds` the visible
 * area (stage ∩ viewport). Opens below-right of the tap, flips to the other side when it would cross
 * an edge, and is finally clamped inside `bounds` (pinned to the top-left when it does not fit at all).
 */
export function placeMenu(
	anchor: { x: number; y: number },
	size: { w: number; h: number },
	bounds: { left: number; top: number; right: number; bottom: number },
): { left: number; top: number } {
	let left = anchor.x + MENU_GAP_PX;
	if (left + size.w > bounds.right) left = anchor.x - MENU_GAP_PX - size.w;
	let top = anchor.y + MENU_GAP_PX;
	if (top + size.h > bounds.bottom) top = anchor.y - MENU_GAP_PX - size.h;
	left = Math.max(bounds.left, Math.min(left, bounds.right - size.w));
	top = Math.max(bounds.top, Math.min(top, bounds.bottom - size.h));
	return { left, top };
}
