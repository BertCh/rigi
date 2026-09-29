/**
 * High-level single-thread entry: tiles → mosaics → snapped peaks → march.
 * HorizonPool (pool.ts) does the same across workers.
 */
import {
	computeHorizonFast,
	type Eye,
	type FastHorizonOptions,
	type FastHorizonProfile,
} from "../../../src/lib/horizon-fast/march";
import {
	buildMosaics,
	cellMeters,
	DEFAULT_RINGS,
	type MosaicOptions,
	mosaicTileKeys,
	type Ring,
	type RingSpan,
	resolveRings,
	type TileStore,
} from "../../../src/lib/horizon-fast/mosaic";
import {
	type PeakInput,
	type SnapOptions,
	type SnappedPeak,
	snapPeaks,
} from "../../../src/lib/horizon-fast/visibility";

export interface EngineOptions extends FastHorizonOptions {
	rings?: Ring[];
	/** OSM peaks to snap and classify (results in profile.peaks). */
	osmPeaks?: PeakInput[];
	snap?: SnapOptions;
	concurrency?: number;
}

export interface Prepared {
	spans: RingSpan[];
	peaks?: SnappedPeak[];
	/** Tile loading (incl. download/decode/validation), ms. */
	loadMs: number;
}

export const spanFor = (spans: RingSpan[], d: number) => {
	for (const s of spans) if (d <= s.maxDistance) return s;
	return spans[spans.length - 1];
};

/** Resolves rings, loads every tile for the full circle, snaps peaks. */
export async function prepare(
	store: TileStore,
	eye: Eye,
	opts: EngineOptions = {},
): Promise<Prepared> {
	const t0 = performance.now();
	const maxDistance = opts.maxDistance ?? 150_000;
	const spans = await resolveRings(
		opts.rings ?? DEFAULT_RINGS,
		eye.lat,
		eye.lon,
		maxDistance,
		store,
	);
	await store.ensure(
		mosaicTileKeys(eye.lat, eye.lon, spans, store.tileSize),
		opts.concurrency,
	);
	const loadMs = performance.now() - t0;
	let peaks: SnappedPeak[] | undefined;
	if (opts.osmPeaks) {
		// Snapping reads the tiles directly (valid for any sector split).
		peaks = snapPeaks(
			opts.osmPeaks,
			(lon, lat, d) => store.heightAt(lon, lat, spanFor(spans, d).z),
			(d) => cellMeters(eye.lat, spanFor(spans, d).z, store.tileSize),
			eye,
			{ maxDistance, ...opts.snap },
		);
	}
	return { spans, peaks, loadMs };
}

export interface EngineTimings {
	loadMs: number;
	mosaicMs: number;
	marchMs: number;
	totalMs: number;
}

/** Single-thread horizon (and peak visibility) from a tile store. */
export async function horizonFromStore(
	store: TileStore,
	eye: Eye,
	opts: EngineOptions = {},
): Promise<FastHorizonProfile & { timings: EngineTimings }> {
	const t0 = performance.now();
	const prep = await prepare(store, eye, opts);
	const t1 = performance.now();
	const mosaicOpts: MosaicOptions = { mips: opts.mipSkip !== false };
	const mosaics = buildMosaics(eye.lat, eye.lon, store, prep.spans, mosaicOpts);
	const t2 = performance.now();
	const profile = computeHorizonFast(mosaics, eye, {
		...opts,
		peaks: prep.peaks,
	});
	const t3 = performance.now();
	return {
		...profile,
		timings: {
			loadMs: prep.loadMs,
			mosaicMs: t2 - t1,
			marchMs: t3 - t2,
			totalMs: t3 - t0,
		},
	};
}
