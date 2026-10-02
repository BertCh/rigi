// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Pure card-position math for TopoBoard (positions are board-centred CSS px: origin at the board
// centre, x right, y down). Kept free of React so the clamp and the resize behaviour can be tested.

export const BLEED_TOP = 20;
export const BLEED_BOTTOM = 64;

export type BoardSize = { w: number; h: number };
export type CardBox = { w: number; h: number };
export type CardPosition = { x: number; y: number };

/** Keep a card of footprint `box` inside the bleed area (`side` px each side of the board). */
export function clampCardPosition(
	pos: CardPosition,
	box: CardBox,
	size: BoardSize,
	side: number,
): CardPosition {
	const mx = size.w / 2 + side - box.w / 2;
	return {
		x: Math.max(-mx, Math.min(mx, pos.x)),
		y: Math.max(
			-size.h / 2 - BLEED_TOP + box.h / 2,
			Math.min(size.h / 2 + BLEED_BOTTOM - box.h / 2, pos.y),
		),
	};
}

/** A position as a fraction of the board size, so it survives a resize. */
export function normaliseCardPosition(
	pos: CardPosition,
	size: BoardSize,
): CardPosition {
	return { x: pos.x / (size.w || 1), y: pos.y / (size.h || 1) };
}

/** Inverse of `normaliseCardPosition`, clamped into the (possibly narrower) bleed area. */
export function restoreCardPosition(
	norm: CardPosition,
	box: CardBox,
	size: BoardSize,
	side: number,
): CardPosition {
	return clampCardPosition(
		{ x: norm.x * size.w, y: norm.y * size.h },
		box,
		size,
		side,
	);
}
