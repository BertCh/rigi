// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// What is in view: coarse-grid statistics of the visible terrain (elevation range, land-cover classes
// present). Pure over a sampler so it checks in node; the Legend throttles it to ~2 Hz.
import type { CoverGrid } from "../pack";

export type ViewSample = { lat: number; lon: number; h: number };
export type ViewStats = {
	hMin: number;
	hMax: number;
	/** class id → fraction of terrain samples */
	cover: Map<number, number>;
	n: number;
};

export function viewStats(
	sample: (u: number, v: number) => ViewSample | null,
	cover: CoverGrid | null,
	nx = 20,
	ny = 14,
): ViewStats | null {
	let hMin = Number.POSITIVE_INFINITY;
	let hMax = Number.NEGATIVE_INFINITY;
	const counts = new Map<number, number>();
	let n = 0;
	for (let j = 0; j < ny; j++)
		for (let i = 0; i < nx; i++) {
			const s = sample((i + 0.5) / nx, (j + 0.5) / ny);
			if (!s) continue;
			n++;
			if (s.h < hMin) hMin = s.h;
			if (s.h > hMax) hMax = s.h;
			if (cover) {
				const c = cover.at(s.lat, s.lon);
				if (c) counts.set(c, (counts.get(c) ?? 0) + 1);
			}
		}
	if (!n) return null;
	const frac = new Map<number, number>();
	for (const [c, k] of counts) frac.set(c, k / n);
	return { hMin, hMax, cover: frac, n };
}
