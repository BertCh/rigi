// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Lake outlines near a photo (GEO GA0/GA4), and the app's lake-floor hook (flag ?geoLakeFloor).
//
// lakesNear: the region's compact lakes when it carries them (upload regions fetched under ?geoLakes),
// else the SAME Overpass water query as src/lib/upload/region.ts regionQueries().water for the snapped
// region cell (named natural=water within ~15 km), compacted. One fetch per cell, memoised; a failed
// fetch is forgotten so a later call retries. Each caller races the shared fetch against its own signal.
// region.ts is imported lazily: it pulls the bundled photo list (a Vite virtual module), which node
// checks cannot load; tests inject `fetchWater`.
//
// photoLakeFloor: everything the engines need in one fail-open call — lakes near the fix, levels (OSM
// ele → Swiss table → DEM median via `absHeight`), floor.ts's rule; null on no lake, timeout (default
// 3 s), abort or any error.

import { lakeLevel } from "../../concord/cues/water";
import { replayHeights } from "../../dem/replay-heights";
import { getFlag } from "../../flags";
import { DEG, EARTH_R } from "../../geodesy";
import {
	compactLakes,
	type LakeGeo,
	type SceneLake,
	toSceneLakes,
	type WaterElement,
} from "./compact";
import {
	floorRadius,
	insideLake,
	type LakeFloor,
	lakeFloorDetail,
	outlineDistance,
} from "./floor";
import { lakeLevelOf } from "./levels";

export type WaterFetcher = (
	lat: number,
	lon: number,
	signal: AbortSignal,
) => Promise<{ elements: WaterElement[] }>;

/** The app's fetcher: region.ts's water query for the snapped cell (lazy import, see header). */
const overpassWater: WaterFetcher = async (lat, lon, signal) => {
	const [{ regionQueries, snapCenter }, { overpass }] = await Promise.all([
		import("../../upload/region"),
		import("../../overpass"),
	]);
	const [clat, clon] = snapCenter(lat, lon);
	const r = await overpass(regionQueries(clat, clon).water, {
		timeoutMs: 20_000,
		signal,
		retryQuickFail: true,
	});
	return { elements: r.elements as WaterElement[] };
};

const memo = new Map<string, Promise<LakeGeo[]>>();
const cellKey = (lat: number, lon: number) =>
	`${(Math.round(lat / 0.05) * 0.05).toFixed(2)}_${(Math.round(lon / 0.05) * 0.05).toFixed(2)}`;

/** Test hook. */
export function _resetLakesMemo() {
	memo.clear();
}

function raceSignal<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return p;
	if (signal.aborted)
		return Promise.reject(new DOMException("aborted", "AbortError"));
	return new Promise<T>((res, rej) => {
		const onAbort = () => rej(new DOMException("aborted", "AbortError"));
		signal.addEventListener("abort", onAbort, { once: true });
		p.then(
			(v) => {
				signal.removeEventListener("abort", onAbort);
				res(v);
			},
			(e) => {
				signal.removeEventListener("abort", onAbort);
				rej(e);
			},
		);
	});
}

export type LakesNearOpts = {
	/** A region that may carry `lakes` (LocalRegion under ?geoLakes). */
	region?: { lakes?: LakeGeo[] } | null;
	signal?: AbortSignal;
	fetchWater?: WaterFetcher;
};

export function lakesNear(
	lat: number,
	lon: number,
	opts: LakesNearOpts = {},
): Promise<LakeGeo[]> {
	if (opts.region?.lakes) return Promise.resolve(opts.region.lakes);
	const fetchWater = opts.fetchWater ?? overpassWater;
	const key = `${fetchWater === overpassWater ? "osm" : "inj"}:${cellKey(lat, lon)}`;
	let p = memo.get(key);
	if (!p) {
		// the shared fetch never takes a caller's signal (another caller may still want it)
		const ctl = new AbortController();
		p = fetchWater(lat, lon, ctl.signal).then((r) => compactLakes(r.elements));
		memo.set(key, p);
		p.catch(() => memo.delete(key));
	}
	return raceSignal(p, opts.signal);
}

/** Local ENU (m) around (lat0, lon0), equirectangular: < 0.1 m error at a few km. */
export const enuAround =
	(lat0: number, lon0: number) =>
	(lat: number, lon: number): [number, number] => [
		(lon - lon0) * DEG * EARTH_R * Math.cos(lat0 * DEG),
		(lat - lat0) * DEG * EARTH_R,
	];

export type PhotoLakeFloorOpts = {
	hAccM?: number | null;
	/** Absolute DEM height at the fix (enables floor rule (b)). */
	demAtFix?: number | null;
	/** Absolute DEM height at a lat/lon (the DEM-median level fallback); null/NaN when unknown. */
	absHeight?: (lat: number, lon: number) => number | null | undefined;
	/**
	 * Batched absolute heights (NaN = unknown), e.g. the engine's GPU gather: the DEM-median level
	 * samples are recorded, looked up in one call and replayed (replay-heights.ts; the sampling
	 * order is geometric, so the result equals `absHeight`'s). A rejection (or the timeout) falls
	 * back to `absHeight`.
	 */
	absHeights?: (
		lats: number[],
		lons: number[],
	) => Float64Array | Promise<Float64Array>;
	region?: { lakes?: LakeGeo[] } | null;
	/** An already-started lakesNear promise (the engines start it at init). */
	lakes?: Promise<LakeGeo[]>;
	signal?: AbortSignal;
	/** Cap on the wait (ms). Default 3000. */
	timeoutMs?: number;
	fetchWater?: WaterFetcher;
};

/**
 * Scene lakes near a fix that could bind the floor (inside, or within the floor radius), with levels.
 * Levels are only computed for these candidates (the DEM median samples up to 3000 heights).
 */
export function candidateLakes(
	lakes: readonly LakeGeo[],
	lat: number,
	lon: number,
	o: Pick<PhotoLakeFloorOpts, "hAccM" | "absHeight"> = {},
): SceneLake[] {
	const toEN = enuAround(lat, lon);
	const radius = floorRadius(o.hAccM);
	const geo = toSceneLakes(lakes, toEN);
	const out: SceneLake[] = [];
	geo.forEach((l, i) => {
		if (!insideLake(l, 0, 0) && outlineDistance(l, 0, 0) > radius) return;
		const lv = lakeLevelOf(lakes[i], () => {
			const abs = o.absHeight;
			if (!abs) return null;
			const lat1 = (n: number) => lat + n / (EARTH_R * DEG);
			const lon1 = (e: number) =>
				lon + e / (EARTH_R * DEG * Math.cos(lat * DEG));
			return lakeLevel(l, (e, n) => abs(lat1(n), lon1(e)) ?? Number.NaN, {
				maxSamples: 600,
			}).levelM;
		});
		out.push({
			...l,
			levelM: lv?.levelM ?? Number.NaN,
			levelSource: lv?.source ?? "none",
		});
	});
	return out;
}

/** The lake floor at a photo's fix (m, absolute) with its reason, or null. Never throws. */
export async function photoLakeFloor(
	lat: number,
	lon: number,
	o: PhotoLakeFloorOpts = {},
): Promise<LakeFloor | null> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const timeout = new Promise<null>((res) => {
			timer = setTimeout(() => res(null), o.timeoutMs ?? 3000);
		});
		const lakesP = raceSignal(
			o.lakes ??
				lakesNear(lat, lon, {
					region: o.region,
					signal: o.signal,
					fetchWater: o.fetchWater,
				}),
			o.signal,
		);
		lakesP.catch(() => {}); // a late failure after the timeout is not an unhandled rejection
		const lakes = await Promise.race([lakesP, timeout]);
		if (!lakes?.length) return null;
		const cpu = () => candidateLakes(lakes, lat, lon, o);
		let cands: SceneLake[] | null;
		if (o.absHeights) {
			const absHeights = o.absHeights;
			const gathered = Promise.resolve(
				replayHeights(
					(h) =>
						candidateLakes(lakes, lat, lon, {
							hAccM: o.hAccM,
							absHeight: h,
						}),
					absHeights,
				),
			);
			gathered.catch(() => {}); // a late failure after the timeout is not an unhandled rejection
			cands = await Promise.race([gathered.catch(cpu), timeout]);
		} else cands = cpu();
		if (!cands) return null;
		return lakeFloorDetail(cands, [0, 0], {
			hAccM: o.hAccM,
			demAtFix: o.demAtFix,
		});
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * The engines' hook (flag ?geoLakeFloor, read at engine init; null when off, so the caller does nothing).
 * Starts the lake fetch at once (the region promise resolves in parallel: its `lakes` win when present);
 * the returned function resolves the floor for the DEM height at the fix, fail-open (null) within
 * timeoutMs (3 s) of being called.
 */
export function startLakeFloor(
	photo: { lat: number; lon: number; hAccuracy?: number | null },
	region: unknown,
	signal?: AbortSignal,
	timeoutMs = 3000,
):
	| ((
			demAtFix: number,
			absHeight?: (lat: number, lon: number) => number | null | undefined,
			absHeights?: PhotoLakeFloorOpts["absHeights"],
	  ) => Promise<number | null>)
	| null {
	if (getFlag("geoLakeFloor") !== "on") return null;
	if (!Number.isFinite(photo.lat) || !Number.isFinite(photo.lon)) return null;
	const lakes = Promise.resolve(region).then((r) =>
		lakesNear(photo.lat, photo.lon, {
			region: r as { lakes?: LakeGeo[] } | null,
			signal,
		}),
	);
	lakes.catch(() => {});
	return async (demAtFix, absHeight, absHeights) => {
		const f = await photoLakeFloor(photo.lat, photo.lon, {
			lakes,
			hAccM: photo.hAccuracy,
			demAtFix,
			absHeight,
			absHeights,
			signal,
			timeoutMs,
		});
		if (f)
			console.info(
				`[geo] lake floor ${f.floorM.toFixed(1)} m (${f.lake}, level ${f.levelM.toFixed(1)} ${f.levelSource}, ${f.inside ? "inside" : `${f.distM.toFixed(0)} m from shore`})`,
			);
		return f?.floorM ?? null;
	};
}
