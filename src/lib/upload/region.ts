// OSM region data for an uploaded photo: named peaks within PEAK_RADIUS_KM and hiking paths /
// named lakes within TRAIL_RADIUS_KM, fetched from Overpass exactly like scripts/ingest.mjs and
// shaped as RegionData (public/photos/region-*.json). Results are cached in memory and IndexedDB,
// keyed by a snapped centre so nearby uploads share one region.
import { EARTH_R } from "../geodesy";
import { type OsmElement, overpass } from "../overpass";
import {
	loadRegion,
	photos as bundledPhotos,
	type RegionData,
	type RegionPeak,
	type RegionTrail,
} from "../photos";
import { getRegion, putRegion } from "./store";

export const PEAK_RADIUS_KM = 60;
export const TRAIL_RADIUS_KM = 12;
/** Region centres snap to this grid (degrees) so photos a few km apart share one fetch. */
export const REGION_SNAP_DEG = 0.05;

export function bboxAround(
	lat: number,
	lon: number,
	km: number,
): [number, number, number, number] {
	const dLat = km / 111.32;
	const dLon = km / (111.32 * Math.cos((lat * Math.PI) / 180));
	return [lat - dLat, lon - dLon, lat + dLat, lon + dLon];
}

const bb = (b: number[]) => b.map((v) => v.toFixed(5)).join(",");

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

/** "1234", "1234 m", "1'234", "4,810" (thousands), "3000 ft" → metres; null if unusable. */
export function parseMetres(v: unknown): number | null {
	if (typeof v !== "string") return null;
	let s = v.trim().replace(/[’']/g, "");
	if (/^\d{1,3},\d{3}(\D|$)/.test(s)) s = s.replace(",", "");
	s = s.replace(",", ".");
	const m = s.match(/-?\d+(\.\d+)?/);
	if (!m) return null;
	let n = Number.parseFloat(m[0]);
	if (/ft|feet/i.test(s)) n *= 0.3048;
	return Number.isFinite(n) ? n : null;
}

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

function haversineKm(lat0: number, lon0: number, lat1: number, lon1: number) {
	const D = Math.PI / 180;
	const a =
		Math.sin(((lat1 - lat0) * D) / 2) ** 2 +
		Math.cos(lat0 * D) *
			Math.cos(lat1 * D) *
			Math.sin(((lon1 - lon0) * D) / 2) ** 2;
	return 2 * (EARTH_R / 1000) * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Bundled region covering (lat, lon), if any. ingest.mjs centres a region on its first photo
 * and fetches trails within 12 km of that centre, so only reuse it close to the centre.
 */
export function bundledRegionIdFor(lat: number, lon: number): string | null {
	const seen = new Set<string>();
	for (const p of bundledPhotos) {
		if (!p.region || seen.has(p.region)) continue;
		seen.add(p.region); // first photo of each region = its centre
		if (haversineKm(lat, lon, p.lat, p.lon) <= BUNDLED_REUSE_KM)
			return p.region;
	}
	return null;
}

export type RegionProgress = (
	stage: "cache" | "peaks" | "trails" | "water" | "done",
	info?: string,
) => void;

/** RegionData plus `warnings` (and `partial` when trails failed, so the cache retries later). */
export type LocalRegion = RegionData & {
	warnings?: string[];
	partial?: boolean;
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
export function regionKeyFor(lat: number, lon: number, force = false) {
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
 * IndexedDB → Overpass). Peaks are required; trails and water degrade to empty lists (with
 * `partial` noted in the returned warnings). Aborting `signal` only detaches this caller.
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
		const warnings: string[] = [];
		opts.onProgress?.("peaks");
		// peaks and trails in parallel (Overpass allows 2 slots per client), water afterwards
		const [peaks, trails] = await Promise.all([
			overpass(q.peaks, {
				timeoutMs: 45_000,
				signal: opts.signal,
				retryQuickFail: true,
			}),
			overpass(q.trails, {
				timeoutMs: 45_000,
				signal: opts.signal,
				retryQuickFail: true,
			}).catch((e) => {
				if (opts.signal?.aborted) throw e;
				warnings.push(`trails unavailable: ${(e as Error).message}`);
				return { elements: [] as OsmElement[] };
			}),
		]);
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
			trails: parseTrails(trails.elements),
			waterNames: [
				...new Set(
					water.elements
						.map((el) => el.tags?.name)
						.filter((n): n is string => !!n),
				),
			],
		};
		if (warnings.length) {
			region.warnings = warnings;
			region.partial = true;
		}
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
export async function attachPhotoToRegion(region: RegionData, photoId: string) {
	if (!isLocalRegionId(region.id)) {
		const { warnings: _w, partial: _p, ...clean } = region as LocalRegion;
		return clean as LocalRegion;
	}
	const photos = region.photos.includes(photoId)
		? region.photos
		: [...region.photos, photoId];
	const { warnings: _w, ...clean } = { ...region, photos } as LocalRegion;
	await putRegion(clean).catch(() => {});
	return clean as LocalRegion;
}
