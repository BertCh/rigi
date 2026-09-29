/// <reference lib="webworker" />
// Worker half of viewpointTerrain.ts: decode the DEM tiles the main thread fetched (shared tile cache),
// build horizon-fast ring mosaics over the full circle and trace the viewpoint's ridgelines. One job per
// worker; the main thread terminates it afterwards (the mosaics are ~100 MB and die with it).
import {
	ancestorCrop,
	blobHeights,
	MAPTERHORN,
	type TileKey,
	tileId,
	validateTile,
} from "#/lib/dem";
import {
	buildMosaic,
	mosaicFor,
	mosaicHeight,
	type RingSpan,
	ringWindow,
	TileStore,
} from "#/lib/horizon-fast/mosaic";
import {
	type PeakInput,
	traceViewpoint,
	type ViewpointTerrain,
} from "./ridgelines";

export type RidgeWorkerIn = {
	lat: number;
	lon: number;
	/** GPS / ground-truth eye altitude (m MSL), or null for DEM + 1.8 m. */
	eyeAlt: number | null;
	spans: RingSpan[];
	tiles: { key: TileKey; source: TileKey | null; buf: ArrayBuffer | null }[];
	peaks: PeakInput[];
};

export type RidgeWorkerOut =
	| { type: "done"; terrain: ViewpointTerrain; ms: number }
	| { type: "error"; error: string };

const scope = self as unknown as DedicatedWorkerGlobalScope;
const T = MAPTERHORN.tileSize;

scope.onmessage = async (e: MessageEvent<RidgeWorkerIn>) => {
	const t0 = performance.now();
	try {
		const j = e.data;
		const store = new TileStore(
			{ tileSize: T, maxZoom: 30, load: async () => null },
			false,
		);
		// an ancestor standing in for several missing tiles decodes once
		const sources = new Map<string, Promise<Float32Array>>();
		await Promise.all(
			j.tiles.map(async ({ key, source, buf }) => {
				if (!buf || !source) {
					store.tiles.set(tileId(key), null);
					return;
				}
				let src = sources.get(tileId(source));
				if (!src) {
					src = blobHeights(new Blob([buf])).then((h) => {
						validateTile(h, Math.round(Math.sqrt(h.length)));
						return h;
					});
					sources.set(tileId(source), src);
				}
				store.tiles.set(tileId(key), ancestorCrop(await src, source, key, T));
			}),
		);
		const mosaics = j.spans.map((s) =>
			buildMosaic(
				store,
				ringWindow(j.lat, j.lon, s, T, 0, 360),
				s,
				j.lat,
				false,
			),
		);
		store.tiles.clear();
		const dem = mosaicHeight(mosaics[0], j.lon, j.lat);
		if (Number.isNaN(dem) && j.eyeAlt == null)
			throw new Error("no terrain under the viewpoint");
		// deck/scene eyeAltitude: GPS altitude unless underground (summit fixes land down the slope)
		const h = Number.isNaN(dem)
			? (j.eyeAlt as number)
			: j.eyeAlt != null
				? Math.max(j.eyeAlt, dem + 1.6)
				: dem + 1.8;
		const terrain = traceViewpoint(
			(lat, lon, d) => mosaicHeight(mosaicFor(mosaics, d), lon, lat),
			{ lat: j.lat, lon: j.lon, h },
			j.peaks,
			{ dMax: j.spans.at(-1)?.maxDistance },
		);
		scope.postMessage(
			{
				type: "done",
				terrain,
				ms: performance.now() - t0,
			} satisfies RidgeWorkerOut,
			[
				terrain.pts.buffer,
				terrain.start.buffer,
				terrain.slab.buffer,
				terrain.ridge.buffer,
				terrain.skyline.buffer,
				terrain.cuePts.buffer,
				terrain.cueStart.buffer,
				terrain.cueSlab.buffer,
			],
		);
	} catch (err) {
		scope.postMessage({
			type: "error",
			error: String((err as Error)?.stack ?? err),
		} satisfies RidgeWorkerOut);
	}
};
