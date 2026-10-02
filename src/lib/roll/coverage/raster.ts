// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Coverage grid -> RGBA pixels (north up) and lat/lon corners, pure so the minimap only has to paint.
import { fromEnu } from "./frame";
import type { CoverageGrid } from "./grid";

/** [r, g, b] of a role colour hex (#rrggbb). */
export const hexToRgb = (hex: string): [number, number, number] => {
	const n = Number.parseInt(hex.slice(1), 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

/**
 * Pixels of the grid, `size` x `size`, row 0 = north. Alpha ramps with value / peak (peak at least 2 so
 * a lone wedge stays faint), colour blends from `low` to `high`; empty cells are fully transparent.
 */
export function coverageRaster(
	grid: CoverageGrid,
	low: readonly [number, number, number],
	high: readonly [number, number, number],
	maxAlpha = 0.7,
): Uint8ClampedArray {
	const { size, data } = grid;
	const peak = Math.max(2, grid.max);
	const out = new Uint8ClampedArray(size * size * 4);
	for (let row = 0; row < size; row++) {
		for (let col = 0; col < size; col++) {
			const v = data[(size - 1 - row) * size + col];
			if (!(v > 0.02)) continue;
			const t = Math.min(1, v / peak);
			const k = (row * size + col) * 4;
			for (let c = 0; c < 3; c++) out[k + c] = low[c] + (high[c] - low[c]) * t;
			out[k + 3] = 255 * maxAlpha * Math.sqrt(t);
		}
	}
	return out;
}

/** Geographic corners of the grid square. */
export function gridLatLonBounds(grid: CoverageGrid) {
	const sw = fromEnu(grid.frame, grid.bounds.minX, grid.bounds.minY);
	const ne = fromEnu(grid.frame, grid.bounds.maxX, grid.bounds.maxY);
	return { south: sw.lat, west: sw.lon, north: ne.lat, east: ne.lon };
}
