// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Camera-roll import: many files → drafts (bounded decode concurrency, see pool.ts) → positions
// (EXIF GPS, time interpolation, or a user pin) → rolls (clusterPhotos) → IndexedDB through the
// upload module's save path, with one OSM region fetch per roll.
import { distanceM } from "#/lib/geodesy";
import type { LatLon } from "#/lib/ontology/core/geometry";
import type { RegionData } from "#/lib/photos";
import {
	hasPosition,
	LOCAL_PREFIX,
	type LocalPhotoMeta,
	listLocalPhotos,
	regionFor,
	saveUpload,
	type UploadDraft,
	withPosition,
} from "#/lib/upload";
import { offsetFromLongitude } from "#/lib/upload/exif";
import { bundledRegionIdFor } from "#/lib/upload/region";
import {
	type EstimatedPosition,
	interpolatePositions,
	mode,
	offsetHours,
} from "./interpolate";
import {
	type PositionProvenance,
	provenanceFromEstimate,
	saveProvenance,
} from "./provenance";

export {
	type EstimatedPosition,
	interpolatePositions,
	MAX_GAP_MS,
} from "./interpolate";
export { createPool } from "./pool";
export { loadProvenance, type PositionProvenance } from "./provenance";
export { reuseIfSame } from "./stable";

/** Decodes in flight at once (HEIC decode is heavy: ~100 MB of pixels per 12 MP frame). */
export const DECODE_CONCURRENCY = 2;

export type { LatLon };

// ---- duplicates -------------------------------------------------------------------------

export type StoredIndex = { ids: Set<string>; nameTime: Set<string> };

const nameTimeKey = (name: string, iso: string) =>
	`${name.toLowerCase()}|${iso}`;

/** Name + capture-time keys of a meta: its takenAt, and the zone-less reading when the zone was guessed. */
function nameTimeKeys(m: LocalPhotoMeta): string[] {
	const keys = [nameTimeKey(m.local.fileName, m.takenAt)];
	const h = offsetHours(m.tzOffset);
	if (m.local.tzEstimated && h != null)
		keys.push(
			nameTimeKey(
				m.local.fileName,
				new Date(Date.parse(m.takenAt) + h * 3600_000).toISOString(),
			),
		);
	return keys;
}

/** What is already stored on this device, for duplicate checks. */
export async function storedIndex(): Promise<StoredIndex> {
	const list = await listLocalPhotos();
	return {
		ids: new Set(list.map((s) => s.id)),
		nameTime: new Set(
			list.flatMap((s) => (s.meta.local ? nameTimeKeys(s.meta) : [])),
		),
	};
}

/** Same file name + capture time as a stored (or earlier-in-batch) photo? */
export const isNameTimeDuplicate = (idx: StoredIndex, m: LocalPhotoMeta) =>
	nameTimeKeys(m).some((k) => idx.nameTime.has(k));

export function addToIndex(idx: StoredIndex, m: LocalPhotoMeta) {
	idx.ids.add(m.id);
	for (const k of nameTimeKeys(m)) idx.nameTime.add(k);
}

/** Read a file once: its bytes and the id prepareUpload gives it (content hash), without decoding. */
export async function readFileId(file: File) {
	const { contentHash } = await import("#/lib/upload/decode");
	const bytes = new Uint8Array(await file.arrayBuffer());
	return { bytes, id: `${LOCAL_PREFIX}${await contentHash(bytes)}` };
}

/** The id prepareUpload will give this file (content hash), computed without decoding it. */
export async function idForFile(file: File) {
	return (await readFileId(file)).id;
}

// ---- positions --------------------------------------------------------------------------

export type Placement =
	| { kind: "gps" }
	| { kind: "estimate"; est: EstimatedPosition }
	| { kind: "pin"; lat: number; lon: number }
	| { kind: "none" };

/**
 * Capture instants (ms UTC) for interpolation. A GPS-less photo whose time is zone-less EXIF
 * wall-clock ('exif-local') was read as UTC; shift it by the zone the batch's GPS'd photos use.
 * GPS-less photos timed only by the file date get NaN (not interpolated).
 */
function effectiveTimes(metas: LocalPhotoMeta[]): Map<string, number> {
	const located = metas.filter(hasPosition);
	const known = located
		.filter((m) => !m.local.tzEstimated)
		.map((m) => m.tzOffset)
		.filter((z): z is string => !!z);
	let zoneH = offsetHours(mode(known));
	if (zoneH == null && located.length) {
		const lons = located.map((m) => m.lon).sort((a, b) => a - b);
		zoneH = offsetHours(offsetFromLongitude(lons[lons.length >> 1]));
	}
	const out = new Map<string, number>();
	for (const m of metas) {
		const t = Date.parse(m.takenAt);
		if (hasPosition(m)) out.set(m.id, t);
		// a file date (no EXIF time) is usually the copy time: too unreliable to interpolate on
		else if (m.local.timeSource === "file") out.set(m.id, Number.NaN);
		else
			out.set(
				m.id,
				m.local.timeSource === "exif-local" ? t - (zoneH ?? 0) * 3600_000 : t,
			);
	}
	return out;
}

/** Where each photo will be placed: its GPS, a user pin, a time-interpolated estimate, or nowhere yet. */
export function placeBatch(
	metas: LocalPhotoMeta[],
	pins: ReadonlyMap<string, LatLon>,
): Map<string, Placement> {
	const times = effectiveTimes(metas);
	const est = interpolatePositions(
		metas.map((m) => {
			const pin = pins.get(m.id);
			const pos = hasPosition(m) ? { lat: m.lat, lon: m.lon } : (pin ?? null);
			return {
				key: m.id,
				t: times.get(m.id) ?? Number.NaN,
				pos,
				accuracyM: hasPosition(m) ? m.hAccuracy : pin ? 30 : null,
			};
		}),
	);
	const out = new Map<string, Placement>();
	for (const m of metas) {
		const pin = pins.get(m.id);
		const e = est.get(m.id);
		out.set(
			m.id,
			pin
				? { kind: "pin", ...pin }
				: hasPosition(m)
					? { kind: "gps" }
					: e
						? { kind: "estimate", est: e }
						: { kind: "none" },
		);
	}
	return out;
}

/** The meta to store for a placement (null: no position yet). */
export function placedMeta(
	draft: UploadDraft,
	p: Placement,
): LocalPhotoMeta | null {
	if (p.kind === "gps") return draft.meta;
	if (p.kind === "pin") return withPosition(draft, p.lat, p.lon);
	if (p.kind === "estimate")
		return {
			...withPosition(draft, p.est.lat, p.est.lon),
			hAccuracy: p.est.accuracyM,
		};
	return null;
}

export function provenanceOf(p: Placement): PositionProvenance | null {
	if (p.kind === "estimate") return provenanceFromEstimate(p.est);
	if (p.kind === "pin")
		return {
			method: "pin",
			accuracyM: null,
			from: [],
			gapS: null,
			at: Date.now(),
		};
	return null;
}

// ---- saving -----------------------------------------------------------------------------

export type SaveEntry = {
	draft: UploadDraft;
	meta: LocalPhotoMeta;
	provenance: PositionProvenance | null;
};

/**
 * The photo whose region stands for the roll: the one nearest the centroid, preferring photos
 * a bundled region (public/photos) already covers, since those need no Overpass query.
 */
export function representative(ms: LocalPhotoMeta[]) {
	const c = {
		lat: ms.reduce((s, m) => s + m.lat, 0) / ms.length,
		lon: ms.reduce((s, m) => s + m.lon, 0) / ms.length,
	};
	const nearest = (xs: LocalPhotoMeta[]) =>
		xs.reduce(
			(best, m) => (distanceM(c, m) < distanceM(c, best) ? m : best),
			xs[0],
		);
	const bundled = ms.filter((m) => bundledRegionIdFor(m.lat, m.lon));
	return nearest(bundled.length ? bundled : ms);
}

/**
 * Save one roll's photos. The OSM region is fetched once, for the representative photo, and
 * threaded through every save (saveUpload attaches each photo to it and returns the updated
 * region). Region failure (Overpass down) still saves the photos with an empty region.
 */
export async function saveRoll(
	entries: SaveEntry[],
	opts: {
		signal?: AbortSignal;
		onRegion?: (stage: string) => void;
		onSaved?: (id: string, error?: string) => void;
	} = {},
) {
	if (!entries.length)
		return { saved: [] as string[], regionError: null as string | null };
	let regionError: string | null = null;
	let region: RegionData | null = await regionFor(
		representative(entries.map((e) => e.meta)),
		{
			signal: opts.signal,
			onProgress: (s, info) => opts.onRegion?.(info ? `${s} (${info})` : s),
		},
	).catch((e) => {
		regionError = (e as Error).message;
		return null;
	});
	const saved: string[] = [];
	for (const e of entries) {
		if (opts.signal?.aborted) break;
		try {
			const r = await saveUpload(e.draft, e.meta, region);
			// keep threading a local region so its photo list accumulates; empty per-photo regions are not shared
			if (region) region = r.region;
			saveProvenance(e.meta.id, e.provenance);
			saved.push(e.meta.id);
			opts.onSaved?.(e.meta.id);
		} catch (err) {
			opts.onSaved?.(e.meta.id, (err as Error).message);
		}
	}
	return { saved, regionError };
}
