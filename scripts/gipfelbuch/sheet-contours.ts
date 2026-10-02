// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * Illuminated (Tanaka) and surface-coloured contours (design book R6, I3). Each simplified contour ring is cut into
 * runs by the aspect of the slope against the NW light (lit / middle / shaded) and by surface (earth or rock). Runs are
 * merged per class into one path string, so the sheet keeps 9 contour <path> elements. At 1:25k scale only index
 * contours run through rock (LK, design book 2.2).
 */
export type ContourKey =
	| "m0"
	| "m1"
	| "m2"
	| "i0"
	| "i1"
	| "i2"
	| "r0"
	| "r1"
	| "r2";
export const CONTOUR_KEYS: ContourKey[] = [
	"m0",
	"m1",
	"m2",
	"i0",
	"i1",
	"i2",
	"r0",
	"r1",
	"r2",
];

type Pt = [number, number];

export interface ContourSampler {
	/** Cosine of the downhill direction against the direction to the light, -1 (shaded) .. 1 (lit). */
	litness: (x: number, y: number) => number;
	slopeDeg: (x: number, y: number) => number;
	isRock: (x: number, y: number) => boolean;
}

const bucketOf = (c: number) => (c > 0.4 ? 0 : c < -0.4 ? 2 : 1);

/** Integer relative path for a run of points. */
function runPath(pts: Pt[]) {
	const d = `M${pts[0][0]} ${pts[0][1]}l`;
	const parts: string[] = [];
	for (let i = 1; i < pts.length; i++)
		parts.push(`${pts[i][0] - pts[i - 1][0]} ${pts[i][1] - pts[i - 1][1]}`);
	return d + parts.join(" ").replace(/ -/g, "-");
}

export function addContourRing(
	ring: Pt[],
	isIndex: boolean,
	sampler: ContourSampler,
	out: Record<ContourKey, string>,
) {
	const n = ring.length;
	// per-point litness smoothed over a short window so runs do not flicker
	const raw = ring.map(([x, y]) => sampler.litness(x, y));
	const smooth = raw.map((_, i) => {
		let s = 0;
		let c = 0;
		for (let k = -3; k <= 3; k++) {
			const j = i + k;
			if (j < 0 || j >= n) continue;
			s += raw[j];
			c++;
		}
		return s / c;
	});
	const keyAt = (i: number): ContourKey | undefined => {
		const [x, y] = ring[i];
		const rock = sampler.isRock(x, y);
		if (rock && !isIndex) return undefined; // 1:25k: minor contours stop at the rock
		const flat = sampler.slopeDeg(x, y) < 5;
		const b = flat ? 1 : bucketOf(smooth[i]);
		return `${rock ? "r" : isIndex ? "i" : "m"}${b}` as ContourKey;
	};
	const keys = ring.map((_, i) => keyAt(i));
	// segment i joins point i to i+1; it takes the key of its start point, runs break where the key changes
	let start = 0;
	for (let i = 1; i <= n; i++) {
		if (i < n && keys[i - 1] === keys[i]) continue;
		const key = keys[i - 1];
		if (key && i - start >= 1) {
			const end = Math.min(n - 1, i);
			const run = ring.slice(start, end + 1);
			if (run.length >= 2) out[key] += runPath(run);
		}
		start = i;
	}
}
