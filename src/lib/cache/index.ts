// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Persistent tile cache + prioritised fetch queue for DEM / imagery tiles.
//
//   const res = await cachedFetch(url, { priority: tilePriority(distanceM, z), signal })
//   if (res.ok) bitmap = await createImageBitmap(await res.blob())
//
// Lookup order: in-memory hot tier (64 MB) → persistent store (Cache API, falling back to
// IndexedDB, then memory) → network through `tileQueue` (24 concurrent, lowest priority
// number first, in-flight requests for the same URL are shared). Successful network
// responses are written back to the store, which is LRU-evicted to a byte cap (300 MB).
// All storage failures (private mode, quota, missing APIs) degrade to cache misses.
//
// Everything here is safe to call before the store has finished opening, and from a dedicated
// worker (which gets a read-only view of the page's store, see cache() below).
import {
	type CachedFetchOptions,
	TileCache,
	type TileCacheOptions,
	type TileCacheStats,
} from "./tile-cache";

export { TileCache };
export { LruIndex } from "./lru";
export {
	PriorityQueue,
	type QueueRequestOptions,
	type QueueStats,
} from "./queue";
export type {
	CachedBody,
	CachedFetchOptions,
	FetchSource,
	TileCacheOptions,
	TileCacheStats,
} from "./tile-cache";

let instance: TileCache | null = null;

/**
 * Inside a dedicated worker (the unknown-pose cascade loads its own terrain) the page owns the store:
 * the worker's instance only reads it (TileCacheOptions.readOnly), so the page's LRU index stays the
 * one record of every stored body and its byte cap holds. What the worker downloads itself is not
 * stored, so it fetches with the HTTP cache on (Mapterhorn tiles are max-age=604800): a later
 * photo's worker then gets those tiles from the browser cache as the plain fetch did. No memory tier
 * (those workers live for one photo and load each tile once).
 */
const WORKER_OPTIONS: TileCacheOptions = {
	readOnly: true,
	memoryCapBytes: 0,
	fetchInit: { mode: "cors", cache: "default" },
};
const inWorker = () =>
	typeof window === "undefined" && "WorkerGlobalScope" in globalThis;

function cache(): TileCache {
	if (!instance) instance = new TileCache(inWorker() ? WORKER_OPTIONS : {});
	return instance;
}

/**
 * Replace the default cache with one built from `opts` (call once at startup, before any
 * fetch). Queued work on the previous instance is cancelled.
 */
export function configureTileCache(opts: TileCacheOptions): TileCache {
	instance?.queue.cancelQueued();
	instance = new TileCache(opts);
	return instance;
}

/** The current TileCache instance (created with defaults on first use). */
export function getTileCache(): TileCache {
	return cache();
}

/**
 * Drop-in for `fetch(url, { signal })` on tile URLs. Resolves with a fresh `Response`
 * (each caller may consume its body) carrying `x-tile-cache: memory|persistent|network`.
 * Non-2xx responses resolve with that status and an empty body (like fetch); network
 * errors and aborts reject (AbortError) like fetch.
 */
export async function cachedFetch(
	url: string,
	opts: CachedFetchOptions = {},
): Promise<Response> {
	const r = await cache().get(url, opts);
	const ok = r.status >= 200 && r.status < 300;
	return new Response(ok ? r.body : null, {
		status: r.status,
		headers: {
			"content-type": r.type || "application/octet-stream",
			"x-tile-cache": r.source,
		},
	});
}

/** Like `cachedFetch` but returns the body bytes (a private copy), or null when not 2xx. */
export async function cachedFetchBuffer(
	url: string,
	opts: CachedFetchOptions = {},
): Promise<ArrayBuffer | null> {
	const r = await cache().get(url, opts);
	return r.status >= 200 && r.status < 300 ? r.body.slice(0) : null;
}

/**
 * Suggested priority for a tile: distance to the camera in km, with a small bias so a
 * coarse tile beats a fine one at equal distance (the coarse one covers more screen).
 */
export function tilePriority(distanceM: number, z = 0): number {
	return Math.max(0, distanceM) / 1000 + z * 0.01;
}

/** Controls for the network queue of the current cache (see PriorityQueue). */
export const tileQueue = {
	/** Recompute queued priorities, e.g. `(url) => tilePriority(distFor(url))` after the camera moves. */
	reprioritize: (fn: (url: string, current: number) => number | undefined) =>
		cache().queue.reprioritize(fn),
	setPriority: (url: string, priority: number) =>
		cache().queue.setPriority(url, priority),
	/** Cancel queued (not yet started) fetches matching `match` (all by default). */
	cancelQueued: (match?: (url: string) => boolean) =>
		cache().queue.cancelQueued(match),
	cancel: (url: string) => cache().queue.cancel(url),
	stats: () => cache().queue.stats(),
	idle: () => cache().queue.idle(),
	get concurrency() {
		return cache().queue.concurrency;
	},
	set concurrency(n: number) {
		cache().queue.concurrency = Math.max(1, Math.floor(n));
	},
};

/** Hit/miss/byte counters, persistent + memory occupancy and queue state. */
export function cacheStats(): TileCacheStats {
	return cache().stats();
}

/** Empty memory + persistent tiers and cancel queued fetches. */
export function clearTileCache(): Promise<void> {
	return cache().clear();
}

/** Persist/read derived data (e.g. decoded Float32 heights) under a non-URL key. */
export function writeDerived(key: string, body: ArrayBuffer, type?: string) {
	return cache().writeDerived(`derived:${key}`, body, type);
}

export async function readDerived(key: string): Promise<ArrayBuffer | null> {
	const v = await cache().readDerived(`derived:${key}`);
	return v ? v.body.slice(0) : null;
}
