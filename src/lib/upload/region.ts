// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import type { SWNE } from "#/lib/ontology/core/geometry";
// OSM region data for an uploaded photo: named peaks within PEAK_RADIUS_KM and named lakes
// within TRAIL_RADIUS_KM, fetched from Overpass like scripts/ingest.mjs and shaped as RegionData
// (public/photos/region-*.json). Hiking paths are the heaviest query (`out geom`), so they are not
// fetched with the region: fetchRegionTrails() loads them only when the trails layer is switched on.
// Results are cached in memory and IndexedDB, keyed by a snapped centre so nearby uploads share one
// region.
import { getFlag } from "../flags";
import { compactLakes, type LakeGeo } from "../geocam/lakes/compact";
import { distanceBearing } from "../geodesy";
import { osmExtractEnabled } from "../licences/config";
import { namedPeaksInBBox, parseBBox } from "../osm/extract";
import { parseOsmMetres } from "../osm/metres";
import { type OsmElement, overpass } from "../overpass";
import {
	photos as bundledPhotos,
	loadRegion,
	type RegionData,
	type RegionPeak,
	type RegionTrail,
} from "../photos";
import { getRegion, putRegion } from "./store";

export const PEAK_RADIUS_KM = 60;
export const TRAIL_RADIUS_KM = 12;
/** Region centres snap to this grid (degrees) so photos a few km apart share one fetch. */
export const REGION_SNAP_DEG = 0.05;

export function bboxAround(lat: number, lon: number, km: number): SWNE {
	const dLat = km / 111.32;
	const dLon = km / (111.32 * Math.cos((lat * Math.PI) / 180));
	return [lat - dLat, lon - dLon, lat + dLat, lon + dLon];
}

const bb = (b: number[]) => b.map((v) => v.toFixed(5)).join(",");

/** The peaks query's bbox exactly as Overpass parses it (the 5-decimal strings in regionQueries). */
export const peakBBox = (lat: number, lon: number) =>
	parseBBox(bb(bboxAround(lat, lon, PEAK_RADIUS_KM)));

export function regionQueries(lat: number, lon: number) {
	const pk = bb(bboxAround(lat, lon, PEAK_RADIUS_KM));
	// the centre is snapped, so widen the trail box by the worst-case snap offset
	const tr = bb(bboxAround(lat, lon, TRAIL_RADIUS_KM + 3));
	return {
		peaks: `[out:json][timeout:90];node["natural"~"peak|volcano"]["name"](${pk});out;`,
		trails: `[out:json][timeout:120];(way["highway"~"path|footway|track"]["sac_scale"](${tr});way["highway"="path"](${tr}););out geom;`,
		water: `[out:json][timeout:120];(way["natural"="water"]["name"](${tr});relation["natural"="water"]["name"](${tr}););out geom;`,
	};
}

export function snapCenter(lat: number, lon: number): [number, number] {
	const s = (v: number) => Math.round(v / REGION_SNAP_DEG) * REGION_SNAP_DEG;
	return [Number(s(lat).toFixed(4)), Number(s(lon).toFixed(4))];
}

export function regionIdFor(lat: number, lon: number) {
	const [a, b] = snapCenter(lat, lon);
	return `local-region-${a.toFixed(2)}_${b.toFixed(2)}`;
}

/** OSM `ele` / `prominence` in metres, null if unusable (osm/metres.ts parseOsmMetres). */
export const parseMetres = (v: unknown): number | null =>
	parseOsmMetres(v) ?? null;

export function parsePeaks(els: OsmElement[]): RegionPeak[] {
	return els
		.filter(
			(el) =>
				el.tags?.name &&
				typeof el.lat === "number" &&
				typeof el.lon === "number",
		)
		.map((el) => ({
			name: el.tags?.name as string,
			lat: el.lat as number,
			lon: el.lon as number,
			ele: parseMetres(el.tags?.ele),
			prominence: parseMetres(el.tags?.prominence),
		}));
}

export function parseTrails(els: OsmElement[]): RegionTrail[] {
	return els
		.filter((el) => (el.geometry?.length ?? 0) > 1)
		.map((el) => ({
			sac: el.tags?.sac_scale ?? null,
			name: el.tags?.name ?? null,
			coords: (el.geometry ?? []).map(
				(g) =>
					[Number(g.lon.toFixed(6)), Number(g.lat.toFixed(6))] as [
						number,
						number,
					],
			),
		}));
}

/** A photo this close (km) to a bundled region's centre reuses public/photos/region-*.json. */
export const BUNDLED_REUSE_KM = 6;

/**
 * Bundled region covering (lat, lon), if any. ingest.mjs centres a region on its first photo
 * and fetches trails within 12 km of that centre, so only reuse it close to the centre.
 */
export function bundledRegionIdFor(lat: number, lon: number): string | null {
	const seen = new Set<string>();
	for (const p of bundledPhotos) {
		if (!p.region || seen.has(p.region)) continue;
		seen.add(p.region); // first photo of each region = its centre
		if (
			distanceBearing(lat, lon, p.lat, p.lon).distance / 1000 <=
			BUNDLED_REUSE_KM
		)
			return p.region;
	}
	return null;
}

export type RegionProgress = (
	stage: "cache" | "peaks" | "trails" | "water" | "done",
	info?: string,
) => void;

/**
 * RegionData plus `warnings`, `partial` (set by older versions when trails failed, so the cache
 * retries later) and `trailsFetched` (fetchRegionTrails has queried this region's paths).
 */
export type LocalRegion = RegionData & {
	/** ?geoLakes: compact lake outlines (src/lib/geocam/lakes) from the same water query. */
	lakes?: LakeGeo[];
	warnings?: string[];
	partial?: boolean;
	trailsFetched?: boolean;
};

/**
 * One in-flight/settled fetch per key, shared by every caller. The fetch runs on its own
 * AbortController, never on a caller's signal: each caller races the shared promise against its
 * own signal, and the shared fetch is aborted only once no caller is left (after a short grace,
 * so a re-pin inside the same cell, which aborts then immediately re-requests, rejoins it).
 */
type Entry = {
	promise: Promise<LocalRegion>;
	ctl: AbortController;
	users: number;
	settled: boolean;
	listeners: Set<RegionProgress>;
	last: Parameters<RegionProgress> | null;
};
const memo = new Map<string, Entry>();
/** How long an abandoned in-flight fetch survives waiting for a new caller (ms). */
export const ABANDON_GRACE_MS = 1500;

/** Test hook: forget memoised regions (does not touch IndexedDB). */
export function _resetRegionMemo() {
	for (const e of memo.values())
		if (!e.settled) e.ctl.abort(new DOMException("reset", "AbortError"));
	memo.clear();
}

/** Memo key: bundled regions by their own id (the reuse test is exact-position), else the cell. */
function regionKeyFor(lat: number, lon: number, force = false) {
	const bundled = force ? null : bundledRegionIdFor(lat, lon);
	return bundled
		? { key: `bundled:${bundled}`, bundled }
		: { key: regionIdFor(lat, lon), bundled: null };
}

function startEntry(
	key: string,
	run: (signal: AbortSignal, progress: RegionProgress) => Promise<LocalRegion>,
): Entry {
	const ctl = new AbortController();
	const entry: Entry = {
		promise: null as unknown as Promise<LocalRegion>,
		ctl,
		users: 0,
		settled: false,
		listeners: new Set(),
		last: null,
	};
	const progress: RegionProgress = (...a) => {
		entry.last = a;
		for (const l of entry.listeners) l(...a);
	};
	entry.promise = run(ctl.signal, progress);
	entry.promise.then(
		(r) => {
			entry.settled = true;
			if (r.partial && memo.get(key) === entry) memo.delete(key);
		},
		() => {
			entry.settled = true;
			if (memo.get(key) === entry) memo.delete(key);
		},
	);
	return entry;
}

/** Attach one caller (own signal + progress listener) to a shared entry. */
function join(
	key: string,
	entry: Entry,
	signal?: AbortSignal,
	onProgress?: RegionProgress,
): Promise<LocalRegion> {
	if (signal?.aborted) return Promise.reject(signal.reason);
	entry.users++;
	if (onProgress) {
		entry.listeners.add(onProgress);
		if (entry.last) onProgress(...entry.last);
	}
	return new Promise<LocalRegion>((resolve, reject) => {
		let done = false;
		const leave = () => {
			if (done) return false;
			done = true;
			entry.users--;
			if (onProgress) entry.listeners.delete(onProgress);
			signal?.removeEventListener("abort", onAbort);
			return true;
		};
		const onAbort = () => {
			if (!leave()) return;
			reject(signal?.reason);
			if (entry.users === 0 && !entry.settled)
				setTimeout(() => {
					if (entry.users > 0 || entry.settled) return;
					if (memo.get(key) === entry) memo.delete(key);
					entry.ctl.abort(new DOMException("no callers left", "AbortError"));
				}, ABANDON_GRACE_MS);
		};
		signal?.addEventListener("abort", onAbort);
		entry.promise.then(
			(r) => leave() && resolve(r),
			(e) => leave() && reject(e),
		);
	});
}

/**
 * RegionData around (lat, lon). Cached (memory → bundled region-*.json near its centre →
 * IndexedDB → Overpass). Peaks are required; water degrades to an empty list. Trails are left
 * empty (see fetchRegionTrails). Aborting `signal` only detaches this caller.
 */
export function fetchRegion(
	lat: number,
	lon: number,
	opts: {
		signal?: AbortSignal;
		onProgress?: RegionProgress;
		force?: boolean;
	} = {},
): Promise<LocalRegion> {
	if (opts.signal?.aborted) return Promise.reject(opts.signal.reason);
	const { key, bundled } = regionKeyFor(lat, lon, opts.force);
	let entry = opts.force ? undefined : memo.get(key);
	if (!entry || (entry.settled === false && entry.ctl.signal.aborted)) {
		const id = regionIdFor(lat, lon);
		entry = startEntry(key, async (signal, progress) => {
			progress("cache");
			if (bundled) {
				const r = await loadRegion(bundled).catch(() => null);
				if (r && Array.isArray(r.peaks)) {
					progress("done", "bundled");
					return r as LocalRegion;
				}
			}
			const cached = (await getRegion(id).catch(
				() => null,
			)) as LocalRegion | null;
			if (cached && !cached.partial && !opts.force) {
				progress("done", "cache");
				return cached;
			}
			try {
				return await fetchFromOverpass(id, lat, lon, cached?.photos ?? [], {
					signal,
					onProgress: progress,
				});
			} catch (e) {
				// offline / Overpass down: an older partial region beats nothing
				if (cached && !signal.aborted)
					return {
						...cached,
						warnings: [`using cached data: ${(e as Error).message}`],
					};
				throw e;
			}
		});
		memo.set(key, entry);
	}
	return join(key, entry, opts.signal, opts.onProgress);
}

async function fetchFromOverpass(
	id: string,
	lat: number,
	lon: number,
	photos: string[],
	opts: { signal?: AbortSignal; onProgress?: RegionProgress },
): Promise<LocalRegion> {
	{
		const [clat, clon] = snapCenter(lat, lon);
		const q = regionQueries(clat, clon);
		opts.onProgress?.("peaks");
		// opt-in (?osmextract=on): the same answer from a static pre-extract when one covers the box
		const peaks =
			(osmExtractEnabled()
				? await namedPeaksInBBox(peakBBox(clat, clon)).catch(() => null)
				: null) ??
			(await overpass(q.peaks, {
				timeoutMs: 45_000,
				signal: opts.signal,
				retryQuickFail: true,
			}));
		opts.onProgress?.("water");
		const water = await overpass(q.water, {
			timeoutMs: 20_000,
			signal: opts.signal,
			retryQuickFail: true,
		}).catch((e) => {
			if (opts.signal?.aborted) throw e;
			return { elements: [] as OsmElement[] };
		});
		const region: LocalRegion = {
			id,
			center: [clat, clon],
			photos,
			peaks: parsePeaks(peaks.elements),
			// on demand only: fetchRegionTrails
			trails: [],
			waterNames: [
				...new Set(
					water.elements
						.map((el) => el.tags?.name)
						.filter((n): n is string => !!n),
				),
			],
			...(getFlag("geoLakes") === "on"
				? { lakes: compactLakes(water.elements) }
				: {}),
		};
		await putRegion(region).catch(() => {});
		opts.onProgress?.("done", "network");
		return region;
	}
}

/** Bundled regions (public/photos/region-*.json) are referenced, never copied into IndexedDB. */
export const isLocalRegionId = (id: string) => id.startsWith("local-");

/**
 * Record that `photoId` uses `region` (keeps RegionData.photos meaningful) and persist it.
 * Bundled regions are returned untouched and not persisted: the photo stores only the id.
 */
let attachChain: Promise<unknown> = Promise.resolve();

export function attachPhotoToRegion(
	region: RegionData,
	photoId: string,
): Promise<LocalRegion> {
	// serialised, and merged with the stored record's photo ids, so concurrent uploads keep each other's ids
	const run = attachChain.then(() => attachNow(region, photoId));
	attachChain = run.catch(() => {});
	return run;
}

async function attachNow(region: RegionData, photoId: string) {
	if (!isLocalRegionId(region.id)) {
		const { warnings: _w, partial: _p, ...clean } = region as LocalRegion;
		return clean as LocalRegion;
	}
	const stored = await getRegion(region.id).catch(() => null);
	const photos = [
		...new Set([...(stored?.photos ?? []), ...region.photos, photoId]),
	];
	const { warnings: _w, ...clean } = { ...region, photos } as LocalRegion;
	await putRegion(clean).catch(() => {});
	return clean as LocalRegion;
}

const trailMemo = new Map<string, Promise<RegionTrail[]>>();

/**
 * Hiking paths for a stored local region, queried from Overpass the first time the trails layer
 * is switched on and then kept in IndexedDB with the region. Bundled regions already carry theirs
 * (returns null: use region.trails). Failed queries are not memoised, so toggling again retries.
 */
export function fetchRegionTrails(
	regionId: string,
	opts: { signal?: AbortSignal } = {},
): Promise<RegionTrail[] | null> {
	if (!isLocalRegionId(regionId)) return Promise.resolve(null);
	let p = trailMemo.get(regionId);
	if (!p) {
		p = (async () => {
			const region = (await getRegion(regionId).catch(
				() => null,
			)) as LocalRegion | null;
			if (!region) return [];
			// regions stored before trails went on-demand already hold their paths
			if (region.trailsFetched || region.trails.length) return region.trails;
			const q = regionQueries(region.center[0], region.center[1]);
			const json = await overpass(q.trails, {
				timeoutMs: 45_000,
				signal: opts.signal,
				retryQuickFail: true,
			});
			const trails = parseTrails(json.elements);
			// re-read: the photo list may have changed while Overpass answered
			const latest = ((await getRegion(regionId).catch(() => null)) ??
				region) as LocalRegion;
			const { partial: _p, ...rest } = latest;
			await putRegion({
				...rest,
				trails,
				trailsFetched: true,
			} as LocalRegion).catch(() => {});
			return trails;
		})();
		trailMemo.set(regionId, p);
		p.catch(() => trailMemo.delete(regionId));
	}
	return p;
}
