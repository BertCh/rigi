// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Seeded sampling for the RANSAC loops (mulberry32). Deterministic per seed; it does not reproduce
// numpy's PCG64 stream, so CPU/GPU/Python runs agree in outcome, not in the exact samples drawn.

export type Rng = { next: () => number; int: (n: number) => number };

export function createRng(seed = 0): Rng {
	let s = (seed ^ 0x9e3779b9) >>> 0;
	const next = () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	return { next, int: (n: number) => Math.floor(next() * n) };
}

/** k distinct indices in [0, n) into `out` (k ≤ n; k is small, so rejection is cheap). */
export function sampleDistinct(
	rng: Rng,
	n: number,
	k: number,
	out: Int32Array,
): Int32Array {
	for (let j = 0; j < k; j++) {
		let i: number;
		let dup: boolean;
		do {
			i = rng.int(n);
			dup = false;
			for (let m = 0; m < j; m++)
				if (out[m] === i) {
					dup = true;
					break;
				}
		} while (dup);
		out[j] = i;
	}
	return out;
}

/** RANSAC trials needed to draw one all-inlier sample with probability `confidence`. */
export function trialsNeeded(
	inlierRatio: number,
	sampleSize: number,
	confidence: number,
): number {
	if (!(inlierRatio > 0)) return Number.POSITIVE_INFINITY;
	const p = inlierRatio ** sampleSize;
	if (p >= 1) return 1;
	return Math.ceil(Math.log(1 - confidence) / Math.log(1 - p));
}
