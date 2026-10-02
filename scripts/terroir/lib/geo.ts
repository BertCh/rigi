// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Small geometry helpers. LV95 conversion lives in scripts/lib/lv95.ts.
import { simplifyPointIndices } from "../../../src/lib/geo/simplify";

export type LonLat = [number, number];

/** Douglas-Peucker on a planar ring/line (units of the input; pass tolerance in the same units). */
export function simplify(
	pts: [number, number][],
	tol: number,
	closed = false,
): [number, number][] {
	if (pts.length <= (closed ? 4 : 2)) return pts;
	const keep = new Set(simplifyPointIndices(pts, tol, "segment"));
	const out = pts.filter((_, i) => keep.has(i));
	return closed && out.length < 4 ? pts.slice(0, 4) : out;
}

export const ringAreaM2 = (ring: [number, number][]) => {
	let s = 0;
	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++)
		s += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
	return s / 2;
};
export const haversineM = (
	lat1: number,
	lon1: number,
	lat2: number,
	lon2: number,
) => {
	const r = Math.PI / 180;
	const a =
		Math.sin(((lat2 - lat1) * r) / 2) ** 2 +
		Math.cos(lat1 * r) *
			Math.cos(lat2 * r) *
			Math.sin(((lon2 - lon1) * r) / 2) ** 2;
	return 12742000 * Math.asin(Math.sqrt(a));
};
