// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Dirty rectangles of the brush mask canvas: a stroke frame uploads only what it painted.

/** Half-open pixel rectangle [x0, x1) x [y0, y1). */
export type PixelRect = { x0: number; y0: number; x1: number; y1: number };

/** The smallest rectangle holding both (`a` null = just `b`). */
export function unionRect(a: PixelRect | null, b: PixelRect): PixelRect {
	return a
		? {
				x0: Math.min(a.x0, b.x0),
				y0: Math.min(a.y0, b.y0),
				x1: Math.max(a.x1, b.x1),
				y1: Math.max(a.y1, b.y1),
			}
		: b;
}

/**
 * The pixels a filled circle (centre x, y; radius r) can touch, padded by one pixel for
 * anti-aliasing and clamped to the canvas. Empty (x1 <= x0 or y1 <= y0) when fully outside.
 */
export function circleRect(
	x: number,
	y: number,
	r: number,
	width: number,
	height: number,
): PixelRect {
	return {
		x0: Math.max(0, Math.floor(x - r) - 1),
		y0: Math.max(0, Math.floor(y - r) - 1),
		x1: Math.min(width, Math.ceil(x + r) + 1),
		y1: Math.min(height, Math.ceil(y + r) + 1),
	};
}

/** The red channel of RGBA rows (stride `stride` px) over `rect`, tightly packed. */
export function extractRed(
	rgba: Uint8ClampedArray,
	rect: PixelRect,
	stride: number,
): Uint8Array {
	const w = rect.x1 - rect.x0;
	const h = rect.y1 - rect.y0;
	const out = new Uint8Array(w * h);
	for (let y = 0; y < h; y++) {
		let src = ((rect.y0 + y) * stride + rect.x0) * 4;
		for (let x = 0; x < w; x++, src += 4) out[y * w + x] = rgba[src];
	}
	return out;
}
