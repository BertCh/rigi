// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// TileCache: memory hot tier → persistent store (Cache API / IndexedDB) → network, with
// a byte-capped LRU over the persistent store and a priority fetch queue in front of the
// network. See ./index.ts for the public API.
import { LruIndex } from "./lru";
import { abortError, PriorityQueue, type QueueStats } from "./queue";
import {
	type BackendKind,
	type BackendPreference,
	type ByteStore,
	openStore,
	type StoredBody,
} from "./store";

export type TileCacheOptions = {
	/** Persistent byte cap (LRU-evicted). Default 300 MB. */
	capBytes?: number;
	/** In-memory hot tier cap. Default 64 MB; 0 disables. */
	memoryCapBytes?: number;
	/** Max concurrent network fetches. Default 24 (16 measured ~100–160 ms slower on a 170-tile cold load over HTTP/2). */
	concurrency?: number;
	/** Storage backend. Default "auto" (Cache API → IndexedDB → memory). */
	backend?: BackendPreference;
	/** Cache / database name; bump the suffix to invalidate everything. */
	name?: string;
	/** Concurrent persistent writes (kept low so writes don't slow reads). Default 2. */
	writeConcurrency?: number;
	/** Debounce for persisting the LRU index, ms. Default 2000. */
	metaDebounceMs?: number;
	/**
	 * A network fetch (response and body) that takes longer than this, ms, is aborted and fails like
	 * a network error (a TimeoutError; the DEM loader retries it, then falls back to the ancestor).
	 * Without it one stalled request held its tile, and its queue slot, forever: the terrain
	 * streamer's set never completed and loadFullTerrain ran into its 300 s timeout. Default 30000;
	 * 0 = none.
	 */
	fetchTimeoutMs?: number;
	/** Injectable fetch (tests). Default globalThis.fetch. */
	fetch?: typeof fetch;
	/**
	 * Cache-wide init for every network fetch (requests are deduped per URL, so there is
	 * no per-caller init). Default `{ mode: "cors", cache: "no-store" }`: the persistent
	 * store already holds the bytes, so the HTTP cache would only keep a second copy.
	 * `signal` is always managed by the queue.
	 */
	fetchInit?: Omit<RequestInit, "signal">;
	/**
	 * Read-only view of a store another context owns (a dedicated worker next to the page, see
	 * ./index.ts). Every memory miss probes the store directly (the owner's index is debounced, so it
	 * would lag), and nothing is ever written, deleted or indexed: the owner's LRU stays the only
	 * writer, so no body can end up outside its index (and its byte cap). Default false.
	 */
	readOnly?: boolean;
};

export type FetchSource = "memory" | "persistent" | "network";

export type CachedBody = StoredBody & { status: number; source: FetchSource };

export type CachedFetchOptions = {
	/** Lower = sooner. Use `tilePriority()` for DEM/imagery tiles. Default 0. */
	priority?: number;
	signal?: AbortSignal;
	/** Store successful responses persistently (default true). */
	persist?: boolean;
	/**
	 * HTTP byte range [start, end] (inclusive, as in the `Range` header). The body is exactly those bytes
	 * (shorter at end of file); a server that ignores Range (200) is sliced. Cached, deduped and stored
	 * under `rangeKey(url, start, end)`, so different ranges of one file are separate entries.
	 */
	range?: readonly [start: number, end: number];
};

/** Cache key of a byte range of `url` (a space never occurs in a URL, so it cannot collide with one). */
export const rangeKey = (url: string, start: number, end: number) =>
	`${url} bytes=${start}-${end}`;

const RANGE_KEY = /^(.*) bytes=(\d+)-(\d+)$/;

export type TileCacheStats = {
	backend: BackendKind | "opening";
	entries: number;
	bytes: number;
	capBytes: number;
	memory: { entries: number; bytes: number; capBytes: number };
	hits: { memory: number; persistent: number };
	misses: number;
	/** errors include timeouts (fetchTimeoutMs) */
	network: { bytes: number; errors: number; notOk: number; timeouts: number };
	writes: { ok: number; failed: number; pending: number };
	evictions: number;
	queue: QueueStats;
};

type NetResult = StoredBody & { status: number };

const EMPTY = new ArrayBuffer(0);

export class TileCache {
	readonly opts: Required<Omit<TileCacheOptions, "fetch" | "fetchInit">> & {
		fetch?: typeof fetch;
		fetchInit: Omit<RequestInit, "signal">;
	};
	readonly queue: PriorityQueue<NetResult>;
	private store: ByteStore | null = null;
	private readyP: Promise<void>;
	private index: LruIndex;
	private mem: LruIndex;
	private memData = new Map<string, StoredBody>();
	private lookups = new Map<string, Promise<StoredBody | null>>();
	/** Session-only negative cache (404 etc.) so fallback chains don't re-request. */
	private negative = new Map<string, number>();
	private pendingWrites = new Map<string, StoredBody>();
	private writes: PriorityQueue<void>;
	private writeSeq = 0;
	private metaTimer: ReturnType<typeof setTimeout> | null = null;
	private counters = {
		memHits: 0,
		persistentHits: 0,
		misses: 0,
		netBytes: 0,
		netErrors: 0,
		netTimeouts: 0,
		notOk: 0,
		writesOk: 0,
		writesFailed: 0,
		evictions: 0,
	};

	constructor(options: TileCacheOptions = {}) {
		this.opts = {
			capBytes: 300 * 1024 * 1024,
			memoryCapBytes: 64 * 1024 * 1024,
			concurrency: 24,
			fetchTimeoutMs: 30_000,
			backend: "auto",
			name: "summit-lens-tiles-v1",
			metaDebounceMs: 2000,
			writeConcurrency: 2,
			readOnly: false,
			...options,
			fetchInit: { mode: "cors", cache: "no-store", ...options.fetchInit },
		};
		this.index = new LruIndex(this.opts.capBytes);
		this.mem = new LruIndex(this.opts.memoryCapBytes);
		this.queue = new PriorityQueue<NetResult>(
			(url, signal) => this.network(url, signal),
			this.opts.concurrency,
		);
		this.writes = new PriorityQueue<void>(
			(url) => this.doPersist(url),
			this.opts.writeConcurrency,
		);
		this.readyP = this.open();
		if (typeof addEventListener === "function")
			try {
				addEventListener("pagehide", () => this.flushMeta());
			} catch {
				/* not a window */
			}
	}

	/** Resolves once the persistent store is open (or has failed over to memory). */
	ready() {
		return this.readyP;
	}

	private async open() {
		try {
			const store = await openStore(this.opts.name, this.opts.backend);
			if (this.opts.readOnly) {
				this.store = store;
				return;
			}
			const meta = await store.getMeta();
			if (meta) this.index = LruIndex.fromJSON(meta, this.opts.capBytes);
			else if (store.kind === "cache" || store.kind === "idb")
				await store.clear(); // no index → orphaned bodies
			this.store = store;
			// cap may have shrunk since the index was written
			for (const k of this.index.evict()) this.dropPersistent(k);
		} catch {
			this.store = null;
		}
	}

	/** Memory → persistent → network. Resolves with the body; rejects like fetch on network error/abort. */
	async get(target: string, o: CachedFetchOptions = {}): Promise<CachedBody> {
		const { signal } = o;
		// every tier below is keyed by `url`: the target, or the target plus a byte range
		const url = o.range ? rangeKey(target, o.range[0], o.range[1]) : target;
		if (signal?.aborted) throw abortError(signal.reason);
		const m = this.memGet(url);
		if (m) {
			this.counters.memHits++;
			return { ...m, status: 200, source: "memory" };
		}
		const neg = this.negative.get(url);
		if (neg) return { body: EMPTY, type: "", status: neg, source: "memory" };

		const hit = await this.lookup(url);
		if (signal?.aborted) throw abortError(signal.reason);
		if (hit) {
			this.counters.persistentHits++;
			this.memPut(url, hit);
			return { ...hit, status: 200, source: "persistent" };
		}
		this.counters.misses++;
		const r = await this.queue.request(url, { priority: o.priority, signal });
		if (r.status >= 200 && r.status < 300) {
			const body = { body: r.body, type: r.type };
			if (!this.memData.has(url)) this.memPut(url, body);
			if (o.persist !== false) void this.persist(url, body);
		}
		return { ...r, source: "network" };
	}

	/** Deduped persistent-store read. */
	private lookup(url: string): Promise<StoredBody | null> {
		let p = this.lookups.get(url);
		if (!p) {
			p = (async () => {
				await this.readyP;
				const store = this.store;
				if (!store) return null;
				if (this.opts.readOnly) return await store.get(url);
				if (!this.index.has(url)) return null;
				const v = await store.get(url);
				if (!v) {
					this.index.remove(url); // index said yes, store said no (evicted by browser / other tab)
					this.scheduleMeta();
					return null;
				}
				this.index.touch(url);
				this.scheduleMeta();
				return v;
			})()
				.catch(() => null)
				.finally(() => this.lookups.delete(url));
			this.lookups.set(url, p);
		}
		return p;
	}

	private async network(key: string, signal: AbortSignal): Promise<NetResult> {
		const m = RANGE_KEY.exec(key);
		const url = m ? m[1] : key;
		const start = m ? Number(m[2]) : 0;
		// the queue's signal (every caller left) plus the stall timeout, on one controller
		const ac = new AbortController();
		const forward = () => ac.abort(signal.reason);
		if (signal.aborted) forward();
		else signal.addEventListener("abort", forward, { once: true });
		let timedOut = false;
		const ms = this.opts.fetchTimeoutMs;
		const timer =
			ms > 0
				? setTimeout(() => {
						timedOut = true;
						const e = new Error(`tile fetch timed out after ${ms} ms: ${url}`);
						e.name = "TimeoutError";
						ac.abort(e);
					}, ms)
				: null;
		try {
			return await this.networkOnce(key, url, start, m, ac.signal);
		} catch (e) {
			if (timedOut) {
				this.counters.netTimeouts++;
				this.counters.netErrors++;
				// what fetch rejects with on abort varies (the reason, or an AbortError): a timeout is
				// always a TimeoutError, never an AbortError (callers retry it like a network error)
				if ((e as Error)?.name !== "TimeoutError") {
					const t = new Error(`tile fetch timed out after ${ms} ms: ${url}`);
					t.name = "TimeoutError";
					throw t;
				}
			}
			throw e;
		} finally {
			if (timer) clearTimeout(timer);
			signal.removeEventListener("abort", forward);
		}
	}

	private async networkOnce(
		key: string,
		url: string,
		start: number,
		m: RegExpExecArray | null,
		signal: AbortSignal,
	): Promise<NetResult> {
		const f = this.opts.fetch ?? globalThis.fetch.bind(globalThis);
		const init: RequestInit = { ...this.opts.fetchInit, signal };
		if (m) {
			const headers = new Headers(this.opts.fetchInit.headers);
			headers.set("Range", `bytes=${start}-${m[3]}`);
			init.headers = headers;
		}
		let res: Response;
		try {
			res = await f(url, init);
		} catch (e) {
			const name = (e as Error)?.name;
			if (name !== "AbortError" && name !== "TimeoutError")
				this.counters.netErrors++;
			throw e;
		}
		if (!res.ok) {
			this.counters.notOk++;
			if (res.status === 404 || res.status === 204)
				this.negative.set(key, res.status);
			return { body: EMPTY, type: "", status: res.status };
		}
		let body = await res.arrayBuffer();
		this.counters.netBytes += body.byteLength;
		// a server that ignores Range answers 200 with the whole file: keep what was asked
		if (m && res.status === 200) body = body.slice(start, Number(m[3]) + 1);
		return {
			body,
			type: res.headers.get("content-type") ?? "",
			status: res.status,
		};
	}

	private memGet(url: string) {
		const v = this.memData.get(url);
		if (v) this.mem.touch(url);
		return v;
	}

	private memPut(url: string, v: StoredBody) {
		if (
			this.opts.memoryCapBytes <= 0 ||
			v.body.byteLength > this.opts.memoryCapBytes
		)
			return;
		this.memData.set(url, v);
		for (const k of this.mem.add(url, v.body.byteLength, v.type))
			this.memData.delete(k);
	}

	/** Queue a persistent write; writes run a few at a time so they don't compete with reads. */
	private persist(url: string, v: StoredBody): Promise<void> {
		if (this.opts.readOnly) return Promise.resolve();
		if (this.pendingWrites.has(url)) return Promise.resolve(); // joined callers of one network job
		this.pendingWrites.set(url, v);
		return this.writes
			.request(url, { priority: this.writeSeq++ })
			.catch(() => {});
	}

	private async doPersist(url: string) {
		const v = this.pendingWrites.get(url);
		if (!v) return;
		try {
			await this.readyP;
			const store = this.store;
			if (
				!store ||
				store.kind === "none" ||
				v.body.byteLength > this.opts.capBytes
			)
				return;
			for (const k of this.index.add(url, v.body.byteLength, v.type))
				this.dropPersistent(k);
			let ok = await store.put(url, v);
			if (!ok) {
				// likely quota: shed a quarter of the cache and retry once
				for (const k of this.index.evict(this.index.bytes * 0.75))
					if (k !== url) this.dropPersistent(k);
				ok = await store.put(url, v);
			}
			if (ok) this.counters.writesOk++;
			else {
				this.counters.writesFailed++;
				this.index.remove(url);
			}
			this.scheduleMeta();
		} catch {
			this.counters.writesFailed++;
		} finally {
			this.pendingWrites.delete(url);
		}
	}

	/** Resolves when all queued persistent writes have finished. */
	flushWrites(): Promise<void> {
		return this.writes.idle();
	}

	private dropPersistent(key: string) {
		this.counters.evictions++;
		this.index.remove(key);
		void this.store?.delete(key);
	}

	private scheduleMeta() {
		if (this.opts.readOnly) return;
		if (this.metaTimer) return;
		this.metaTimer = setTimeout(() => {
			this.metaTimer = null;
			void this.flushMeta();
		}, this.opts.metaDebounceMs);
	}

	/** Write the LRU index now (called on pagehide; safe to call any time). */
	async flushMeta() {
		if (this.metaTimer) {
			clearTimeout(this.metaTimer);
			this.metaTimer = null;
		}
		if (this.opts.readOnly) return;
		try {
			await this.store?.putMeta(this.index.toJSON());
		} catch {
			/* ignore */
		}
	}

	/** Read a derived (non-URL) blob, e.g. decoded heights. */
	async readDerived(key: string): Promise<StoredBody | null> {
		const m = this.memGet(key);
		if (m) return m;
		const v = await this.lookup(key);
		if (v) this.memPut(key, v);
		return v;
	}

	/** Store a derived blob under an arbitrary key (shares the LRU cap with tiles). */
	async writeDerived(
		key: string,
		body: ArrayBuffer,
		type = "application/octet-stream",
	) {
		const v = { body, type };
		this.memPut(key, v);
		await this.persist(key, v);
	}

	async clear() {
		this.queue.cancelQueued();
		this.writes.cancelQueued();
		await this.writes.idle(); // let in-progress writes land before wiping
		this.pendingWrites.clear();
		this.memData.clear();
		this.mem.clear();
		this.negative.clear();
		this.index.clear();
		await this.readyP;
		if (this.opts.readOnly) return; // the owner's store is not ours to wipe
		try {
			await this.store?.clear();
			await this.store?.putMeta(this.index.toJSON());
		} catch {
			/* ignore */
		}
	}

	stats(): TileCacheStats {
		const c = this.counters;
		return {
			backend: this.store?.kind ?? "opening",
			entries: this.index.size,
			bytes: this.index.bytes,
			capBytes: this.opts.capBytes,
			memory: {
				entries: this.mem.size,
				bytes: this.mem.bytes,
				capBytes: this.opts.memoryCapBytes,
			},
			hits: { memory: c.memHits, persistent: c.persistentHits },
			misses: c.misses,
			network: {
				bytes: c.netBytes,
				errors: c.netErrors,
				notOk: c.notOk,
				timeouts: c.netTimeouts,
			},
			writes: {
				ok: c.writesOk,
				failed: c.writesFailed,
				pending: this.pendingWrites.size,
			},
			evictions: c.evictions,
			queue: this.queue.stats(),
		};
	}
}
