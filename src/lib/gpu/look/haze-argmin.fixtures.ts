// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Synthetic haze-grid fixtures of the GPU arg-min program (./haze-argmin.ts): random landscapes and
// the adversarial grids (ties at the minimum / the 256th candidate, more than GRID_PICK_CAP
// candidates, f32 neighbours of the f64 tolerance, NaN, ±∞, ±0, subnormals, negatives, all-NaN).
// Used by haze-argmin.check.ts (emulatePick, no GPU) and scripts/gpu/haze-argmin-dawn.ts (the real
// program on Dawn, the same grids bound to the err import).
import { fromBits32, nextDown32, nextUp32 } from "../precision/df32";
import { GRID_CELLS, GRID_PICK_CAP, gridTolerance } from "./haze";
import { lcg } from "./haze-emulate";

/** One seeded stream: `makeGrid(kind)` and the atomic slot order `shuffle(n)` draw from it. */
export function createHazeGridFixtures(seed = 20261001) {
	const rnd = lcg(seed);
	const shuffle = (n: number) => {
		const a = [...Array(n).keys()];
		for (let i = n - 1; i > 0; i--) {
			const j = Math.floor(rnd() * (i + 1));
			[a[i], a[j]] = [a[j], a[i]];
		}
		return a;
	};

	/** f32 neighbours of the f64 tolerance of `gMin`: the largest f32 ≤ T and the next ones. */
	function aroundTolerance(gMin: number) {
		const T = gridTolerance(gMin);
		let f = Math.fround(T);
		if (f > T) f = nextDown32(f);
		return [nextDown32(f), f, nextUp32(f), nextUp32(nextUp32(f))];
	}

	function makeGrid(kind: number): Float32Array {
		const g = new Float32Array(GRID_CELLS);
		const scale = 10 ** (rnd() * 12 - 8);
		const flat = kind % 7 === 3;
		for (let k = 0; k < GRID_CELLS; k++) {
			const hk = Math.floor(k / (25 * 37));
			const a = Math.floor((k % (25 * 37)) / 37);
			const b = k % 37;
			const bowl =
				((a - 12) / 12) ** 2 + ((b - 18) / 18) ** 2 + 0.2 * ((hk - 2) / 3) ** 2;
			g[k] =
				scale * (flat ? 1 + 1e-5 * bowl * rnd() : 0.5 + bowl + 0.01 * rnd());
		}
		// adversarial sprinkles
		const sprinkle = (n: number, v: () => number) => {
			for (let i = 0; i < n; i++) g[Math.floor(rnd() * GRID_CELLS)] = v();
		};
		if (kind % 2 === 0) sprinkle(20, () => Number.NaN);
		if (kind % 3 === 0) sprinkle(10, () => Number.POSITIVE_INFINITY);
		if (kind % 5 === 0) sprinkle(5, () => (rnd() < 0.5 ? 0 : -0));
		if (kind % 11 === 0)
			sprinkle(5, () => fromBits32(1 + Math.floor(rnd() * 1000)));
		if (kind % 13 === 0) sprinkle(5, () => -scale * rnd());
		// ties at the minimum
		let gMin = Number.POSITIVE_INFINITY;
		for (const e of g) if (e < gMin) gMin = e;
		if (kind % 4 === 1) sprinkle(30, () => gMin);
		// cells on the tolerance's f32 neighbours (and many of them: past the cap)
		if (kind % 4 === 2) {
			const n = aroundTolerance(gMin);
			sprinkle(
				kind % 8 === 2 ? 600 : 40,
				() => n[Math.floor(rnd() * n.length)],
			);
		}
		// many ties around the 256th candidate
		if (kind % 6 === 5) {
			const v = Math.fround(gMin + Math.abs(gMin) * 5e-4);
			sprinkle(400, () => v);
		}
		return g;
	}

	return { rnd, shuffle, makeGrid };
}

/** The fixed adversarial grids (no random draws), by label. */
export function namedHazeGrids(): [string, Float32Array][] {
	const nan = new Float32Array(GRID_CELLS).fill(Number.NaN);
	const one = new Float32Array(GRID_CELLS).fill(Number.NaN);
	one[1234] = 0.5;
	const exact = new Float32Array(GRID_CELLS).fill(2);
	for (let k = 0; k < GRID_PICK_CAP; k++) exact[k * 7] = 1;
	const exact257 = exact.slice();
	exact257[3] = 1;
	const zeros = new Float32Array(GRID_CELLS).fill(1);
	for (let k = 0; k < 300; k++) zeros[k * 11] = k % 2 ? -0 : 0;
	return [
		["all NaN", nan],
		["one finite cell", one],
		["exactly 256 at the minimum", exact],
		["257 at the minimum", exact257],
		["300 ±0 minima", zeros],
	];
}
