// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Bounded LRU for the engines' imagery bitmap cache (tile id → ImageBitmap; CR-14). The Map's
// insertion order is the recency order. Tiles in the current render set are never evicted
// (they are on screen or about to be), so the cap is soft: it bounds what panning leaves behind.

/** Decoded size of a bitmap (RGBA8). */
export const imageryBytes = (b: { width: number; height: number }) =>
	b.width * b.height * 4;

/** Soft cap on cached imagery bitmaps (decoded bytes). */
export const IMAGERY_CACHE_CAP_BYTES = 384 * 1024 * 1024;

/** Mark `ids` (those present) most recently used by re-inserting them at the end. */
export function touchImagery<V>(map: Map<string, V>, ids: Iterable<string>) {
	for (const id of ids) {
		const v = map.get(id);
		if (v === undefined) continue;
		map.delete(id);
		map.set(id, v);
	}
}

/**
 * Remove least-recently-used entries not in `keep` until the total size is within `capBytes`;
 * calls `release` on each removed value and returns the removed ids (oldest first).
 */
export function evictImagery<V extends { width: number; height: number }>(
	map: Map<string, V>,
	keep: ReadonlySet<string>,
	capBytes: number,
	release: (v: V) => void,
): string[] {
	let total = 0;
	for (const v of map.values()) total += imageryBytes(v);
	const out: string[] = [];
	if (total <= capBytes) return out;
	for (const [id, v] of map) {
		if (total <= capBytes) break;
		if (keep.has(id)) continue;
		map.delete(id);
		total -= imageryBytes(v);
		release(v);
		out.push(id);
	}
	return out;
}
