// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Lives in dem/ so geocam can use it without importing deck-webgpu (height-gather.ts re-exports it).

/**
 * Record / replay for code that reads heights through a callback in an order that does not depend
 * on the values (buildTrailSegments, localMaxOf): `fn` runs once with a recorder (every call answers
 * null, so the run is cheap), the recorded points are looked up in one batch, then `fn` runs again
 * with the answers in call order. `lookup` returns heightAt's values (NaN = null). Returns `fn`'s
 * second result, synchronously when the lookup is.
 */
export function replayHeights<T>(
	fn: (heightAt: (lat: number, lon: number) => number | null) => T,
	lookup: (
		lats: number[],
		lons: number[],
	) => Float64Array | Promise<Float64Array>,
): T | Promise<T> {
	const lats: number[] = [];
	const lons: number[] = [];
	fn((lat, lon) => {
		lats.push(lat);
		lons.push(lon);
		return null;
	});
	const replay = (h: Float64Array) => {
		let i = 0;
		const r = fn((lat, lon) => {
			// invariant: the second run asks for the same points in the same order (value-independent)
			if (lat !== lats[i] || lon !== lons[i])
				throw new Error("replayHeights: call order changed");
			const v = h[i++];
			return Number.isNaN(v) ? null : v;
		});
		return r;
	};
	const h = lookup(lats, lons);
	return h instanceof Float64Array ? replay(h) : h.then(replay);
}
