// Browser DEM loading: decode (image.ts, in a worker pool on the page), a plain uncached fetch, and the app's one
// Mapterhorn tile policy (shared tile cache; a missing tile is stood in for by its nearest ancestor).
import { cachedFetch, tilePriority } from "../cache";
import type { DecodeIn, DecodeOut } from "./decode.worker";
import { blobHeights } from "./image";
import { type DemSource, MAPTERHORN } from "./sources";
import { parentKey, type TileKey, tileId } from "./tiles";

export { bitmapHeights, blobHeights } from "./image";

/**
 * Page-side decode pool: Terrarium tiles decode in a few workers (the same blobHeights, see
 * decode.worker.ts) instead of on the main thread, where ~200 tiles per /photo load cost ~120 ms.
 * Elsewhere (workers, node, no OffscreenCanvas) or if a worker fails, blobHeights runs here.
 */
type Pending = {
	buf: ArrayBuffer;
	resolve: (h: Float32Array) => void;
	reject: (e: unknown) => void;
};
let pool: Worker[] | null | undefined;
let nextWorker = 0;
let nextId = 0;
const pending = new Map<number, Pending>();

function decodePool(): Worker[] | null {
	if (pool !== undefined) return pool;
	pool = null;
	if (
		typeof document === "undefined" ||
		typeof Worker === "undefined" ||
		typeof OffscreenCanvas === "undefined"
	)
		return pool;
	try {
		const n = Math.max(
			1,
			Math.min(4, (navigator.hardwareConcurrency || 4) - 1),
		);
		const workers: Worker[] = [];
		for (let i = 0; i < n; i++) {
			const w = new Worker(new URL("./decode.worker.ts", import.meta.url), {
				type: "module",
			});
			w.onmessage = (e: MessageEvent<DecodeOut>) => {
				const p = pending.get(e.data.id);
				if (!p) return;
				pending.delete(e.data.id);
				if ("heights" in e.data) p.resolve(e.data.heights);
				else p.reject(new Error(e.data.error));
			};
			// a worker that cannot start or dies: decode everything here from now on, pending jobs too
			w.onerror = () => {
				for (const x of workers) x.terminate();
				pool = null;
				const jobs = [...pending.values()];
				pending.clear();
				for (const p of jobs)
					blobHeights(new Blob([p.buf])).then(p.resolve, p.reject);
			};
			workers.push(w);
		}
		pool = workers;
	} catch {
		pool = null;
	}
	return pool;
}

/** Heights of an encoded Terrarium tile, decoded in the page's worker pool when there is one. */
export function decodeHeights(buf: ArrayBuffer): Promise<Float32Array> {
	const workers = decodePool();
	if (!workers) return blobHeights(new Blob([buf]));
	const id = nextId++;
	const w = workers[nextWorker++ % workers.length];
	return new Promise<Float32Array>((resolve, reject) => {
		pending.set(id, { buf, resolve, reject });
		// copied, not transferred: kept for the fallback should the worker die
		w.postMessage({ id, buf } satisfies DecodeIn);
	});
}

/** Plain fetch (HTTP cache only) + decode; undefined when the source has no such tile (any non-2xx). */
export async function fetchDemTile(
	src: DemSource,
	key: TileKey,
	signal?: AbortSignal,
): Promise<Float32Array | undefined> {
	const res = await fetch(src.url(key), { signal });
	return res.ok ? blobHeights(await res.blob()) : undefined;
}

export type DemLoadOptions = {
	/** Don't fall back to ancestors coarser than this zoom. */
	minZoom?: number;
	/** Queue priority for the shared tile cache (lower = sooner); see tilePriority(). */
	priority?: number;
	signal?: AbortSignal;
};

/** Mapterhorn tiles known not to exist (404/204) this session. */
const missing = new Set<string>();

/** Encoded bytes of one Mapterhorn tile: null = the server has none, undefined = failed twice. */
async function fetchTile(key: TileKey, o: DemLoadOptions) {
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const res = await cachedFetch(MAPTERHORN.url(key), {
				priority: o.priority ?? tilePriority(0, key.z),
				signal: o.signal,
			});
			if (res.ok) return res.arrayBuffer();
			if (res.status === 404 || res.status === 204) {
				missing.add(tileId(key));
				return null;
			}
		} catch (e) {
			if ((e as Error)?.name === "AbortError" || o.signal?.aborted) throw e;
		}
	}
	return undefined;
}

/**
 * The app's DEM policy (three terrain, deck terrain, CPU horizon): the Mapterhorn tile for `key`, or,
 * where it has none (coarser coverage outside CH/FR, or z > maxZoom), its nearest ancestor that exists
 * (down to `minZoom`). A tile under a known-missing ancestor skips straight past it (the pyramid is
 * nested), so each uncovered region costs one probe per level. A network failure (after one retry)
 * also falls back but isn't remembered. Aborts reject. Null only if nothing loads.
 */
export async function fetchDemBytes(
	key: TileKey,
	o: DemLoadOptions = {},
): Promise<{ source: TileKey; buf: ArrayBuffer } | null> {
	let k = key;
	while (k.z > MAPTERHORN.maxZoom) k = parentKey(k);
	for (let a = k; a.z > 0; a = parentKey(a))
		if (missing.has(tileId(a))) k = parentKey(a);
	for (; k.z >= (o.minZoom ?? 0); k = parentKey(k)) {
		const buf = await fetchTile(k, o);
		if (buf) return { source: k, buf };
		if (k.z === 0) break;
	}
	return null;
}

/**
 * The part of ancestor tile `source` (heights `h`, S×S) under `key`, bilinear-resampled to size×size
 * (pixel centres; the ancestor's pixels just outside the quadrant feed its edges). `h` itself when
 * key = source and the size matches.
 */
export function ancestorCrop(
	h: Float32Array,
	source: TileKey,
	key: TileKey,
	size: number,
) {
	const S = Math.round(Math.sqrt(h.length));
	const n = 2 ** (key.z - source.z);
	if (n === 1 && S === size) return h;
	const f = S / n / size;
	const ox = (key.x - source.x * n) * (S / n) - 0.5;
	const oy = (key.y - source.y * n) * (S / n) - 0.5;
	const m = S - 1;
	const out = new Float32Array(size * size);
	for (let j = 0; j < size; j++) {
		const y = Math.min(Math.max(oy + (j + 0.5) * f, 0), m);
		const y0 = Math.floor(y);
		const r0 = y0 * S;
		const r1 = Math.min(y0 + 1, m) * S;
		const fy = y - y0;
		for (let i = 0; i < size; i++) {
			const x = Math.min(Math.max(ox + (i + 0.5) * f, 0), m);
			const x0 = Math.floor(x);
			const x1 = Math.min(x0 + 1, m);
			const fx = x - x0;
			const a = h[r0 + x0] * (1 - fx) + h[r0 + x1] * fx;
			const b = h[r1 + x0] * (1 - fx) + h[r1 + x1] * fx;
			out[j * size + i] = a * (1 - fy) + b * fy;
		}
	}
	return out;
}

export type DemRaster = {
	/** The tile this raster covers. */
	key: TileKey;
	/** Grid is size × size, row-major, row 0 = north edge. */
	size: number;
	heights: Float32Array;
	/** The tile the data actually came from (an ancestor when `key` is missing). */
	source: TileKey;
};

/** fetchDemBytes, decoded (a bad image = null); an ancestor's quadrant is upsampled to the full tile size. */
export async function loadDemTile(
	key: TileKey,
	o: DemLoadOptions = {},
): Promise<DemRaster | null> {
	const r = await fetchDemBytes(key, o);
	if (!r) return null;
	const h = await decodeHeights(r.buf).catch(() => null);
	if (!h) return null;
	const size = Math.round(Math.sqrt(h.length));
	return {
		key,
		source: r.source,
		size,
		heights: ancestorCrop(h, r.source, key, size),
	};
}
