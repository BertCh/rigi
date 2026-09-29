// Browser upload path: File → EXIF prior + upright JPEG → PhotoMeta (same as ingest.mjs) →
// OSM region → IndexedDB. See out/lead/upload/API.md.
import * as photosModule from "../photos";
import type { PhotoMeta, RegionData } from "../photos";
import { contentHash, type Decoded, decodeImage } from "./decode";
import {
	buildPhotoMeta,
	exifDiagnostics,
	type LocalPhotoMeta,
	readExif,
} from "./exif";
import {
	attachPhotoToRegion,
	fetchRegion,
	isLocalRegionId,
	type LocalRegion,
	type RegionProgress,
} from "./region";
import {
	allPhotoRecords,
	deletePhotoRecord,
	deleteRegion,
	getPhotoRecord,
	getRegion,
	putPhoto,
	regionIds,
} from "./store";

export { HeicUnsupportedError, isHeif } from "./decode";
export {
	buildPhotoMeta,
	captureTime,
	type LocalPhotoMeta,
	orientationFromGravity,
	parseAppleMakerNote,
	readExif,
	vfovFromF35,
} from "./exif";
export {
	fetchRegion,
	fetchRegionTrails,
	isLocalRegionId,
	type LocalRegion,
	regionIdFor,
} from "./region";

export const LOCAL_PREFIX = "local-";
export const isLocalPhotoId = (id: string) => id.startsWith(LOCAL_PREFIX);

export type UploadStage = "reading" | "exif" | "decoding" | "done";

export type UploadDraft = {
	id: string;
	file: File;
	decoded: Decoded;
	diagnostics: ReturnType<typeof exifDiagnostics>;
	/** lat/lon are NaN when EXIF GPS is missing: place a pin, then call `withPosition`. */
	meta: LocalPhotoMeta;
	/** Build inputs, so the meta can be rebuilt with a pinned position. */
	exif: Awaited<ReturnType<typeof readExif>>;
};

/** Parse + decode a picked file. Throws HeicUnsupportedError when HEIC can't be decoded here. */
export async function prepareUpload(
	file: File,
	onStage?: (s: UploadStage) => void,
): Promise<UploadDraft> {
	onStage?.("reading");
	const bytes = new Uint8Array(await file.arrayBuffer());
	const id = `${LOCAL_PREFIX}${await contentHash(bytes)}`;
	onStage?.("exif");
	const exif = await readExif(bytes);
	onStage?.("decoding");
	const decoded = await decodeImage(file, bytes, exif.tags.Orientation ?? 1);
	const meta = buildPhotoMeta(exif.tags, exif.raw, {
		id,
		width: decoded.width,
		height: decoded.height,
		sourceWidth: decoded.sourceWidth,
		sourceHeight: decoded.sourceHeight,
		fallbackTime: file.lastModified,
		file: {
			name: file.name,
			type: file.type || (decoded.decoder === "libheif" ? "image/heic" : ""),
			bytes: file.size,
		},
	});
	onStage?.("done");
	return {
		id,
		file,
		decoded,
		diagnostics: exifDiagnostics(exif.tags, exif.raw),
		meta,
		exif,
	};
}

/** Rebuild the draft's meta with a user-placed position (pin). */
export function withPosition(
	draft: UploadDraft,
	lat: number,
	lon: number,
): LocalPhotoMeta {
	const m = buildPhotoMeta(draft.exif.tags, draft.exif.raw, {
		id: draft.id,
		width: draft.decoded.width,
		height: draft.decoded.height,
		sourceWidth: draft.decoded.sourceWidth,
		sourceHeight: draft.decoded.sourceHeight,
		fallbackTime: draft.file.lastModified,
		position: { lat, lon },
		file: {
			name: draft.meta.local.fileName,
			type: draft.meta.local.fileType,
			bytes: draft.meta.local.fileBytes,
		},
	});
	return m;
}

export const hasPosition = (m: PhotoMeta) =>
	Number.isFinite(m.lat) && Number.isFinite(m.lon);

/** Fetch (or reuse) OSM data for the meta's position. */
export function regionFor(
	meta: PhotoMeta,
	opts?: { signal?: AbortSignal; onProgress?: RegionProgress; force?: boolean },
) {
	if (!hasPosition(meta))
		return Promise.reject(new Error("photo has no position yet"));
	return fetchRegion(meta.lat, meta.lon, opts);
}

const blobUrls = new Map<string, string>();
function blobUrlFor(id: string, blob: Blob) {
	let u = blobUrls.get(id);
	if (!u) {
		u = URL.createObjectURL(blob);
		blobUrls.set(id, u);
	}
	return u;
}

/**
 * Persist an upload. `region` may be null (Overpass unreachable): the photo is stored with an
 * empty region so it still opens; `refreshLocalRegion` can fill it later.
 */
export async function saveUpload(
	draft: UploadDraft,
	meta: LocalPhotoMeta,
	region: RegionData | null,
) {
	if (!hasPosition(meta)) throw new Error("place the photo on the map first");
	const r: RegionData = region
		? await attachPhotoToRegion(region, meta.id)
		: await attachPhotoToRegion(emptyRegion(meta), meta.id);
	const stored: LocalPhotoMeta = { ...meta, src: "", region: r.id };
	await putPhoto({
		id: meta.id,
		meta: stored,
		blob: draft.decoded.blob,
		thumb: draft.decoded.thumb,
	});
	return {
		meta: { ...stored, src: blobUrlFor(meta.id, draft.decoded.blob) },
		region: r,
	};
}

function emptyRegion(meta: PhotoMeta): RegionData {
	return {
		id: `local-region-empty-${meta.id}`,
		center: [meta.lat, meta.lon],
		photos: [],
		peaks: [],
		trails: [],
		waterNames: [],
	};
}

export type RestoredPhoto = {
	meta: LocalPhotoMeta;
	region: RegionData;
	blobUrl: string;
};

/** Load an upload back from IndexedDB. meta.src is set to a (cached) blob: URL. */
export async function restoreLocalPhoto(
	id: string,
): Promise<RestoredPhoto | null> {
	const rec = await getPhotoRecord(id).catch(() => null);
	if (!rec) return null;
	const blobUrl = blobUrlFor(id, rec.blob);
	// bundled regions are stored by reference only: read the current public/photos JSON
	const region = (isLocalRegionId(rec.meta.region)
		? await getRegion(rec.meta.region).catch(() => null)
		: await photosModule.loadRegion(rec.meta.region).catch(() => null)) ?? {
		...emptyRegion(rec.meta),
		id: rec.meta.region,
	};
	const { warnings: _w, partial: _p, ...clean } = region as LocalRegion;
	return { meta: { ...rec.meta, src: blobUrl }, region: clean, blobUrl };
}

export type LocalPhotoSummary = {
	id: string;
	meta: LocalPhotoMeta;
	thumbUrl: string | null;
};

/** All stored uploads, newest first. Thumbnail URLs are blob: URLs owned by this module. */
export async function listLocalPhotos(): Promise<LocalPhotoSummary[]> {
	const recs = await allPhotoRecords().catch(() => []);
	return recs
		.sort((a, b) => (b.meta.local?.addedAt ?? 0) - (a.meta.local?.addedAt ?? 0))
		.map((r) => ({
			id: r.id,
			meta: r.meta,
			thumbUrl: r.thumb ? blobUrlFor(`${r.id}#thumb`, r.thumb) : null,
		}));
}

export async function deleteLocalPhoto(id: string) {
	await deletePhotoRecord(id);
	await gcRegions().catch((e) =>
		console.warn("[upload] region cleanup failed", e),
	);
	for (const k of [id, `${id}#thumb`]) {
		const u = blobUrls.get(k);
		if (u) URL.revokeObjectURL(u);
		blobUrls.delete(k);
	}
}

/**
 * Drop stored regions no stored photo references, plus any bundled-region copies an older
 * version of this module wrote (bundled regions are now referenced, not copied).
 */
export async function gcRegions() {
	const used = new Set((await allPhotoRecords()).map((r) => r.meta.region));
	const stale = (await regionIds()).filter(
		(rid) => !isLocalRegionId(rid) || !used.has(rid),
	);
	for (const rid of stale) await deleteRegion(rid);
	return stale;
}

/** Re-query Overpass for a stored photo's region (e.g. after an offline upload). */
export async function refreshLocalRegion(
	id: string,
	opts?: { signal?: AbortSignal; onProgress?: RegionProgress },
) {
	const rec = await getPhotoRecord(id);
	if (!rec) throw new Error(`no local photo ${id}`);
	const region = await attachPhotoToRegion(
		await fetchRegion(rec.meta.lat, rec.meta.lon, { ...opts, force: true }),
		id,
	);
	await putPhoto({ ...rec, meta: { ...rec.meta, region: region.id } });
	return region;
}

// ---- workspace integration --------------------------------------------------------------

type RegisterHook = (meta: PhotoMeta, region: RegionData | null) => void;

/** The photos.ts hook (owned by the workspace session), if it exists yet. */
export function registerHook(): RegisterHook | null {
	const fn = (photosModule as Record<string, unknown>).registerLocalPhoto;
	return typeof fn === "function" ? (fn as RegisterHook) : null;
}

/**
 * For the /photo/$id loader: restore a local upload from IndexedDB and register it with
 * photos.ts so getPhoto/loadRegion see it. Returns the meta, or null if unknown/no hook.
 */
export async function ensureLocalPhotoRegistered(
	id: string,
): Promise<LocalPhotoMeta | null> {
	if (!isLocalPhotoId(id)) return null;
	const hook = registerHook();
	const r = await restoreLocalPhoto(id);
	if (!r || !hook) return r?.meta ?? null;
	registerWithWorkspace(r.meta, r.region);
	return r.meta;
}

/**
 * Register an upload with photos.ts. Only local regions seed its region cache; a bundled id
 * ('region-1') is left for loadRegion to fetch, so bundled photos never see a stale copy.
 * Returns false when photos.ts has no registerLocalPhoto hook.
 */
export function registerWithWorkspace(
	meta: PhotoMeta,
	region: RegionData | null,
) {
	const hook = registerHook();
	if (!hook) return false;
	hook(
		meta,
		region && isLocalRegionId(region.id) && region.id === meta.region
			? region
			: null,
	);
	return true;
}
