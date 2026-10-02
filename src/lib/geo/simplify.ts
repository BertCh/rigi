// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Douglas–Peucker polyline simplification, shared by the roll ridgelines, the lake compactor and the
// bake scripts. Iterative; endpoints always kept; the first farthest point wins ties (strict >).

/**
 * How far a point is from the chord of the span being split:
 * - "line": perpendicular distance to the infinite line through the chord ends.
 * - "segment": distance to the chord segment (projection clamped to [0, 1]).
 * A zero-length chord measures plain distance from its start in both modes.
 */
export type SimplifyDistance = "line" | "segment";

/**
 * Indices kept by Douglas–Peucker over `count` points read through `getX`/`getY`. `tolerance` is in
 * the caller's coordinate units; a point survives when it is farther than that from the chord.
 * Fewer than 3 points are all kept.
 */
export function simplifyIndices(
	count: number,
	getX: (index: number) => number,
	getY: (index: number) => number,
	tolerance: number,
	distance: SimplifyDistance = "line",
): number[] {
	if (count < 3) return Array.from({ length: count }, (_, i) => i);
	const keep = new Uint8Array(count);
	keep[0] = keep[count - 1] = 1;
	const stack: [number, number][] = [[0, count - 1]];
	while (stack.length) {
		const [first, last] = stack.pop() as [number, number]; // length checked by the loop
		const x0 = getX(first);
		const y0 = getY(first);
		const dx = getX(last) - x0;
		const dy = getY(last) - y0;
		const length = Math.hypot(dx, dy);
		const lengthSquared = dx * dx + dy * dy;
		let best = -1;
		let bestIndex = -1;
		for (let k = first + 1; k < last; k++) {
			const px = getX(k) - x0;
			const py = getY(k) - y0;
			let d: number;
			if (distance === "line") {
				d = length ? Math.abs(dy * px - dx * py) / length : Math.hypot(px, py);
			} else if (lengthSquared === 0) d = Math.hypot(px, py);
			else {
				const t = Math.max(0, Math.min(1, (px * dx + py * dy) / lengthSquared));
				d = Math.hypot(px - t * dx, py - t * dy);
			}
			if (d > best) {
				best = d;
				bestIndex = k;
			}
		}
		if (bestIndex >= 0 && best > tolerance) {
			keep[bestIndex] = 1;
			stack.push([first, bestIndex], [bestIndex, last]);
		}
	}
	const out: number[] = [];
	for (let i = 0; i < count; i++) if (keep[i]) out.push(i);
	return out;
}

/** `simplifyIndices` over [x, y, …] points (extra components ignored); returns the kept indices. */
export function simplifyPointIndices(
	points: ArrayLike<number>[],
	tolerance: number,
	distance: SimplifyDistance = "line",
): number[] {
	return simplifyIndices(
		points.length,
		(i) => points[i][0],
		(i) => points[i][1],
		tolerance,
		distance,
	);
}
