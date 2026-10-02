// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Shared helpers for Vitest specs (see src/test/README.md). Pure, no GPU, no network.

import { expect } from "vitest";

/** A deterministic PRNG (mulberry32) so property-style specs are reproducible. */
export function seededRandom(seed = 0x5eed): () => number {
	let s = seed >>> 0;
	return () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Uniform float in [lo, hi) from a seeded generator. */
export const uniform = (rand: () => number, lo: number, hi: number) =>
	lo + (hi - lo) * rand();

/** Element-wise closeness for arrays / typed arrays, with an absolute tolerance. */
export function expectArrayClose(
	actual: ArrayLike<number>,
	expected: ArrayLike<number>,
	tolerance = 1e-9,
) {
	expect(actual.length).toBe(expected.length);
	for (let i = 0; i < expected.length; i++) {
		const diff = Math.abs(actual[i] - expected[i]);
		if (
			!(diff <= tolerance) &&
			!(Number.isNaN(actual[i]) && Number.isNaN(expected[i]))
		)
			throw new Error(
				`index ${i}: ${actual[i]} vs ${expected[i]} (|Δ| ${diff} > ${tolerance})`,
			);
	}
}

/** Angular difference in degrees, wrapped to [0, 180]. */
export const angleDiffDeg = (a: number, b: number) => {
	const d = Math.abs(((((a - b) % 360) + 540) % 360) - 180);
	return d;
};

/** Run a test body with a per-realm flag override (src/lib/flags), cleaned up by src/test/setup.ts. */
export function withFlags(flags: Record<string, string>) {
	(globalThis as { __RIGI_FLAGS__?: Record<string, string> }).__RIGI_FLAGS__ = {
		...flags,
	};
}
