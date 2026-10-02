// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Persistent byte stores behind the tile cache: Cache API (preferred), IndexedDB
// (fallback), and memory (last resort / node). Every storage call is wrapped so that a
// missing API, private mode, quota errors or a corrupted database degrade to "miss"
// instead of throwing into the render path.

export type StoredBody = { body: ArrayBuffer; type: string };

export type BackendKind = "cache" | "idb" | "memory" | "none";

export interface ByteStore {
	readonly kind: BackendKind;
	get(key: string): Promise<StoredBody | null>;
	/** Returns false if the write failed (e.g. quota). */
	put(key: string, value: StoredBody): Promise<boolean>;
	delete(key: string): Promise<void>;
	clear(): Promise<void>;
	/** Small JSON blob for the LRU index. */
	getMeta(): Promise<unknown>;
	putMeta(meta: unknown): Promise<void>;
}

/** Synthetic same-scheme URL so arbitrary keys (and Vary-less requests) work with Cache API. */
const cacheUrl = (key: string) =>
	`https://rigi-tile-cache.invalid/${encodeURIComponent(key)}`;
const META_KEY = "__meta__";

class CacheApiStore implements ByteStore {
	readonly kind = "cache" as const;
	constructor(private cache: Cache) {}

	static async open(name: string): Promise<CacheApiStore | null> {
		try {
			if (typeof caches === "undefined") return null;
			const c = await caches.open(name);
			// probe: some browsers expose `caches` but throw on use (e.g. opaque origins)
			await c.match(cacheUrl(META_KEY));
			return new CacheApiStore(c);
		} catch {
			return null;
		}
	}

	async get(key: string) {
		try {
			const r = await this.cache.match(cacheUrl(key));
			if (!r) return null;
			return {
				body: await r.arrayBuffer(),
				type: r.headers.get("content-type") ?? "",
			};
		} catch {
			return null;
		}
	}

	async put(key: string, v: StoredBody) {
		try {
			await this.cache.put(
				cacheUrl(key),
				new Response(v.body, {
					headers: {
						"content-type": v.type,
						"content-length": String(v.body.byteLength),
					},
				}),
			);
			return true;
		} catch {
			return false;
		}
	}

	async delete(key: string) {
		try {
			await this.cache.delete(cacheUrl(key));
		} catch {
			/* ignore */
		}
	}

	async clear() {
		try {
			const keys = await this.cache.keys();
			await Promise.all(keys.map((k) => this.cache.delete(k)));
		} catch {
			/* ignore */
		}
	}

	async getMeta() {
		try {
			const r = await this.cache.match(cacheUrl(META_KEY));
			return r ? await r.json() : null;
		} catch {
			return null;
		}
	}

	async putMeta(meta: unknown) {
		try {
			await this.cache.put(
				cacheUrl(META_KEY),
				new Response(JSON.stringify(meta), {
					headers: { "content-type": "application/json" },
				}),
			);
		} catch {
			/* ignore */
		}
	}
}

const reqP = <T>(r: IDBRequest<T>) =>
	new Promise<T>((res, rej) => {
		r.onsuccess = () => res(r.result);
		r.onerror = () => rej(r.error);
	});

class IdbStore implements ByteStore {
	readonly kind = "idb" as const;
	constructor(private db: IDBDatabase) {}

	static async open(name: string): Promise<IdbStore | null> {
		try {
			if (typeof indexedDB === "undefined") return null;
			const req = indexedDB.open(name, 1);
			req.onupgradeneeded = () => {
				const db = req.result;
				if (!db.objectStoreNames.contains("blobs"))
					db.createObjectStore("blobs");
				if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
			};
			const opened = reqP(req);
			let timer: ReturnType<typeof setTimeout> | undefined;
			let timedOut = false;
			let db: IDBDatabase;
			try {
				db = await Promise.race([
					opened,
					// a blocked/hung open (another tab mid-upgrade) must not stall tile loading
					new Promise<never>((_, rej) => {
						timer = setTimeout(() => {
							timedOut = true;
							// a late open must not leak its connection (only closed when it
							// really lost the race, never a connection that opened in time)
							opened.then(
								(late) => late.close(),
								() => {},
							);
							rej(new Error("idb open timeout"));
						}, 3000);
					}),
				]);
			} finally {
				if (!timedOut) clearTimeout(timer);
			}
			// another tab upgrades / deletes the database: release ours
			db.onversionchange = () => db.close();
			return new IdbStore(db);
		} catch {
			return null;
		}
	}

	private async tx<T>(
		store: "blobs" | "meta",
		mode: IDBTransactionMode,
		fn: (s: IDBObjectStore) => IDBRequest<T>,
	) {
		const t = this.db.transaction(store, mode);
		const done = new Promise<void>((res, rej) => {
			t.oncomplete = () => res();
			t.onerror = () => rej(t.error);
			t.onabort = () => rej(t.error);
		});
		const r = await reqP(fn(t.objectStore(store)));
		if (mode === "readwrite") await done;
		else done.catch(() => {});
		return r;
	}

	async get(key: string) {
		try {
			const v = (await this.tx("blobs", "readonly", (s) => s.get(key))) as
				| StoredBody
				| undefined;
			return v?.body ? { body: v.body, type: v.type ?? "" } : null;
		} catch {
			return null;
		}
	}

	async put(key: string, v: StoredBody) {
		try {
			await this.tx("blobs", "readwrite", (s) =>
				s.put({ body: v.body, type: v.type }, key),
			);
			return true;
		} catch {
			return false;
		}
	}

	async delete(key: string) {
		try {
			await this.tx("blobs", "readwrite", (s) => s.delete(key));
		} catch {
			/* ignore */
		}
	}

	async clear() {
		try {
			await this.tx("blobs", "readwrite", (s) => s.clear());
			await this.tx("meta", "readwrite", (s) => s.clear());
		} catch {
			/* ignore */
		}
	}

	async getMeta() {
		try {
			return await this.tx("meta", "readonly", (s) => s.get(META_KEY));
		} catch {
			return null;
		}
	}

	async putMeta(meta: unknown) {
		try {
			await this.tx("meta", "readwrite", (s) => s.put(meta, META_KEY));
		} catch {
			/* ignore */
		}
	}
}

/** Non-persistent store (node, or when neither Cache API nor IndexedDB works). */
export class MemoryStore implements ByteStore {
	readonly kind = "memory" as const;
	private m = new Map<string, StoredBody>();
	private meta: unknown = null;
	async get(key: string) {
		return this.m.get(key) ?? null;
	}
	async put(key: string, v: StoredBody) {
		this.m.set(key, v);
		return true;
	}
	async delete(key: string) {
		this.m.delete(key);
	}
	async clear() {
		this.m.clear();
		this.meta = null;
	}
	async getMeta() {
		return this.meta;
	}
	async putMeta(meta: unknown) {
		this.meta = meta;
	}
}

/** Store that holds nothing (persistence explicitly disabled). */
export class NullStore implements ByteStore {
	readonly kind = "none" as const;
	async get() {
		return null;
	}
	async put() {
		return false;
	}
	async delete() {}
	async clear() {}
	async getMeta() {
		return null;
	}
	async putMeta() {}
}

export type BackendPreference = "auto" | BackendKind;

/** Open the best available store: Cache API → IndexedDB → memory. Never throws. */
export async function openStore(
	name: string,
	pref: BackendPreference = "auto",
): Promise<ByteStore> {
	if (pref === "none") return new NullStore();
	if (pref === "memory") return new MemoryStore();
	if (pref === "auto" || pref === "cache") {
		const c = await CacheApiStore.open(name);
		if (c) return c;
	}
	if (pref === "auto" || pref === "idb") {
		const i = await IdbStore.open(name);
		if (i) return i;
	}
	return new MemoryStore();
}
