// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Pure metrics for the offline anchor gate (scripts/nearfield/anchor-eval.ts): the PLACEMENT.txt terrain residual
// (tools/nearfield/spike/PLACEMENT.txt) = median |log(placed / DEM)| over non-Object terrain pixels, overall at
// DEM 15-500 m and in the 15-50 / 50-150 / 150-500 m bands, plus the median-over-photos aggregate.
import { median } from "./geom";

/** DEM range bands (m, [lo, hi)) of PLACEMENT.txt. `ALL` is the headline 15-500 m. */
export const RESIDUAL_ALL: readonly [number, number] = [15, 500];
export const RESIDUAL_BANDS: readonly (readonly [number, number])[] = [
	[15, 50],
	[50, 150],
	[150, 500],
];
/** place.py resid(): fewer terrain pixels than this in a band gives no number (null). */
export const RESIDUAL_MIN_PIXELS = 150;

export type TerrainResiduals = {
	/** Median |log(placed/DEM)| at DEM 15-500 m, null below RESIDUAL_MIN_PIXELS pixels. */
	all: number | null;
	/** Same for each of RESIDUAL_BANDS. */
	bands: (number | null)[];
};

/**
 * `placed[k]` (m) and `dem[k]` (m) per grid cell; `excluded[k]` truthy = Object or sky (skipped). Cells with a
 * non-finite or non-positive placed range or DEM are skipped; the DEM window is lo < dem < hi (place.py resid()).
 */
export function terrainResiduals(
	placed: ArrayLike<number>,
	dem: ArrayLike<number>,
	excluded?: ArrayLike<number> | null,
): TerrainResiduals {
	const windows = [RESIDUAL_ALL, ...RESIDUAL_BANDS];
	const buckets: number[][] = windows.map(() => []);
	for (let k = 0; k < dem.length; k++) {
		const d = dem[k];
		const p = placed[k];
		if (excluded?.[k] || !(d > 0) || !(p > 0) || !Number.isFinite(p)) continue;
		const e = Math.abs(Math.log(p / d));
		for (let w = 0; w < windows.length; w++)
			if (d > windows[w][0] && d < windows[w][1]) buckets[w].push(e);
	}
	const med = (b: number[]) =>
		b.length >= RESIDUAL_MIN_PIXELS ? median(b) : null;
	return { all: med(buckets[0]), bands: buckets.slice(1).map(med) };
}

/** Median of the finite entries, ignoring nulls; NaN when none. */
export function medianOfPhotos(values: readonly (number | null)[]): number {
	return median(
		values.filter((v): v is number => v != null && Number.isFinite(v)),
	);
}

/** Fraction of the non-null values below `threshold` (place.py summ.py "frac<0.1"); NaN when none. */
export function fractionBelow(
	values: readonly (number | null)[],
	threshold: number,
): number {
	const v = values.filter((x): x is number => x != null && Number.isFinite(x));
	return v.length
		? v.filter((x) => x < threshold).length / v.length
		: Number.NaN;
}
