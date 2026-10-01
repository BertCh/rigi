// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import type { TileKey } from "./tiles";

/**
 * Bilinear sample of an S×S grid of pixel-centred samples at pixel coords (0..S), clamped to the outer
 * sample centres. Shared by deck/terrain-data, nearfield/near-dem and look/relief/heights
 * (terrain-mesh.ts keeps its own uv variant).
 */
export function sampleGrid(h: Float32Array, S: number, px: number, py: number) {
	const m = S - 1;
	const x = Math.min(Math.max(px - 0.5, 0), m);
	const y = Math.min(Math.max(py - 0.5, 0), m);
	const x0 = Math.floor(x);
	const y0 = Math.floor(y);
	const x1 = Math.min(x0 + 1, m);
	const y1 = Math.min(y0 + 1, m);
	const fx = x - x0;
	const fy = y - y0;
	const a = h[y0 * S + x0] * (1 - fx) + h[y0 * S + x1] * fx;
	const b = h[y1 * S + x0] * (1 - fx) + h[y1 * S + x1] * fx;
	return a * (1 - fy) + b * fy;
}

/**
 * The part of ancestor tile `source` (heights `h`, S×S) under `key`, bilinear-resampled to size×size
 * (pixel centres; the ancestor's pixels just outside the quadrant feed its edges). `h` itself when
 * key = source and the size matches.
 */
export function ancestorCrop(
	h: Float32Array,
	source: TileKey,
	key: TileKey,
	size: number,
) {
	const S = Math.round(Math.sqrt(h.length));
	const n = 2 ** (key.z - source.z);
	if (n === 1 && S === size) return h;
	const f = S / n / size;
	const ox = (key.x - source.x * n) * (S / n) - 0.5;
	const oy = (key.y - source.y * n) * (S / n) - 0.5;
	const m = S - 1;
	const out = new Float32Array(size * size);
	for (let j = 0; j < size; j++) {
		const y = Math.min(Math.max(oy + (j + 0.5) * f, 0), m);
		const y0 = Math.floor(y);
		const r0 = y0 * S;
		const r1 = Math.min(y0 + 1, m) * S;
		const fy = y - y0;
		for (let i = 0; i < size; i++) {
			const x = Math.min(Math.max(ox + (i + 0.5) * f, 0), m);
			const x0 = Math.floor(x);
			const x1 = Math.min(x0 + 1, m);
			const fx = x - x0;
			const a = h[r0 + x0] * (1 - fx) + h[r0 + x1] * fx;
			const b = h[r1 + x0] * (1 - fx) + h[r1 + x1] * fx;
			out[j * size + i] = a * (1 - fy) + b * fy;
		}
	}
	return out;
}
