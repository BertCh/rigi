// Browser DEM loading: decode (createImageBitmap + canvas), a plain uncached fetch, and the app's one
// Mapterhorn tile policy (shared tile cache; a missing tile is stood in for by its nearest ancestor).
import { cachedFetch, tilePriority } from "../cache";
import { decodeTerrarium } from "./decode";
import { type DemSource, MAPTERHORN } from "./sources";
import { parentKey, type TileKey, tileId } from "./tiles";

function context2d(w: number, h: number) {
	if (typeof OffscreenCanvas !== "undefined")
		return new OffscreenCanvas(w, h).getContext("2d", {
			willReadFrequently: true,
		}) as OffscreenCanvasRenderingContext2D | null;
	const c = document.createElement("canvas");
	c.width = w;
	c.height = h;
	return c.getContext("2d", { willReadFrequently: true });
}

/** Heights of a decoded Terrarium image (OffscreenCanvas, or a <canvas> where there is none). */
export function bitmapHeights(bmp: ImageBitmap) {
	const ctx = context2d(bmp.width, bmp.height);
	if (!ctx) throw new Error("2D canvas unavailable for DEM decode");
	ctx.drawImage(bmp, 0, 0);
	return decodeTerrarium(ctx.getImageData(0, 0, bmp.width, bmp.height).data);
}

/** Heights of an encoded Terrarium tile (PNG / WebP bytes). */
export async function blobHeights(blob: Blob) {
	const bmp = await createImageBitmap(blob, {
		colorSpaceConversion: "none",
		premultiplyAlpha: "none",
	});
	try {
		return bitmapHeights(bmp);
	} finally {
		bmp.close();
	}
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
	const h = await blobHeights(new Blob([r.buf])).catch(() => null);
	if (!h) return null;
	const size = Math.round(Math.sqrt(h.length));
	return {
		key,
		source: r.source,
		size,
		heights: ancestorCrop(h, r.source, key, size),
	};
}
