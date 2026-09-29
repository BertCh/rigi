// IndexedDB persistence for browser uploads: photo records (meta + JPEG blob + thumbnail) and
// region data (shared between photos). Everything degrades to "not stored" when IndexedDB is
// unavailable (private mode, SSR).
import type { RegionData } from "../photos";
import type { LocalPhotoMeta } from "./exif";

const DB_NAME = "mt-image-uploads";
const DB_VERSION = 1;
const PHOTOS = "photos";
const REGIONS = "regions";

export type PhotoRecord = {
	id: string;
	meta: LocalPhotoMeta;
	/** Upright JPEG, long side ≤ 2048 px. */
	blob: Blob;
	/** Small JPEG for lists. */
	thumb?: Blob;
};

let dbp: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
	if (typeof indexedDB === "undefined")
		return Promise.reject(new Error("IndexedDB unavailable"));
	dbp ??= new Promise<IDBDatabase>((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, DB_VERSION);
		req.onupgradeneeded = () => {
			const d = req.result;
			if (!d.objectStoreNames.contains(PHOTOS))
				d.createObjectStore(PHOTOS, { keyPath: "id" });
			if (!d.objectStoreNames.contains(REGIONS))
				d.createObjectStore(REGIONS, { keyPath: "id" });
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
		req.onblocked = () => reject(new Error("IndexedDB blocked by another tab"));
	}).catch((e) => {
		dbp = null;
		throw e;
	});
	return dbp;
}

function tx<T>(
	store: string,
	mode: IDBTransactionMode,
	fn: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
	return db().then(
		(d) =>
			new Promise<T>((resolve, reject) => {
				const t = d.transaction(store, mode);
				const req = fn(t.objectStore(store));
				t.oncomplete = () => resolve(req.result);
				t.onerror = () => reject(t.error ?? req.error);
				t.onabort = () => reject(t.error ?? new Error("transaction aborted"));
			}),
	);
}

export const putPhoto = (r: PhotoRecord) =>
	tx(PHOTOS, "readwrite", (s) => s.put(r)).then(() => undefined);
export const getPhotoRecord = (id: string) =>
	tx<PhotoRecord | undefined>(PHOTOS, "readonly", (s) => s.get(id)).then(
		(r) => r ?? null,
	);
export const deletePhotoRecord = (id: string) =>
	tx(PHOTOS, "readwrite", (s) => s.delete(id)).then(() => undefined);
export const allPhotoRecords = () =>
	tx<PhotoRecord[]>(PHOTOS, "readonly", (s) => s.getAll());

export const putRegion = (r: RegionData) =>
	tx(REGIONS, "readwrite", (s) => s.put(r)).then(() => undefined);
export const getRegion = (id: string) =>
	tx<RegionData | undefined>(REGIONS, "readonly", (s) => s.get(id)).then(
		(r) => r ?? null,
	);
export const deleteRegion = (id: string) =>
	tx(REGIONS, "readwrite", (s) => s.delete(id)).then(() => undefined);
export const regionIds = () =>
	tx<IDBValidKey[]>(REGIONS, "readonly", (s) => s.getAllKeys()).then((k) =>
		k.map(String),
	);
