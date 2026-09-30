// Browser DEM loading: decode (image.ts, in a worker pool on the page), a plain uncached fetch, and the app's one
// Mapterhorn tile policy (shared tile cache; a missing tile is stood in for by its nearest ancestor).
import { cachedFetch, tilePriority } from "../cache";
import { WorkerPool } from "../worker-pool";
import { ancestorCrop } from "./grid";
import { blobHeights } from "./image";
import { type DemSource, MAPTERHORN } from "./sources";
import { parentKey, type TileKey, tileId } from "./tiles";

export { bitmapHeights, blobHeights } from "./image";

/**
 * Page-side decode pool: Terrarium tiles decode in a few workers (the same blobHeights, see
 * decode.worker.ts) instead of on the main thread, where ~200 tiles per /photo load cost ~120 ms.
 */
const decodePool = new WorkerPool<ArrayBuffer, Float32Array>(
	() =>
		new Worker(new URL("./decode.worker.ts", import.meta.url), {
			type: "module",
		}),
	(buf) => blobHeights(new Blob([buf])),
);

/** Heights of an encoded Terrarium tile, decoded in the page's worker pool when there is one. */
export function decodeHeights(buf: ArrayBuffer): Promise<Float32Array> {
	return decodePool.run(buf);
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
