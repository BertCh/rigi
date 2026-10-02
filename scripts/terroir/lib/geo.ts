// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Small geometry helpers. LV95 conversion lives in scripts/lib/lv95.ts.
export type LonLat = [number, number];

/** Douglas-Peucker on a planar ring/line (units of the input; pass tolerance in the same units). */
export function simplify(
	pts: [number, number][],
	tol: number,
	closed = false,
): [number, number][] {
	if (pts.length <= (closed ? 4 : 2)) return pts;
	const keep = new Uint8Array(pts.length);
	keep[0] = keep[pts.length - 1] = 1;
	const stack: [number, number][] = [[0, pts.length - 1]];
	const t2 = tol * tol;
	while (stack.length) {
		const top = stack.pop();
		if (!top) break;
		const [a, b] = top;
		let md = -1,
			mi = -1;
		const [ax, ay] = pts[a],
			[bx, by] = pts[b];
		const dx = bx - ax,
			dy = by - ay,
			l2 = dx * dx + dy * dy;
		for (let i = a + 1; i < b; i++) {
			const [px, py] = pts[i];
			let d2: number;
			if (l2 === 0) d2 = (px - ax) ** 2 + (py - ay) ** 2;
			else {
				const t = Math.max(
					0,
					Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2),
				);
				d2 = (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2;
			}
			if (d2 > md) {
				md = d2;
				mi = i;
			}
		}
		if (md > t2) {
			keep[mi] = 1;
			stack.push([a, mi], [mi, b]);
		}
	}
	const out = pts.filter((_, i) => keep[i]);
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
