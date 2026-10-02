// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryStore, NullStore, openStore } from "../store";

const body = (...n: number[]) => Uint8Array.from(n).buffer;
const bytesOf = (b: ArrayBuffer) => Array.from(new Uint8Array(b));

afterEach(() => {
	vi.unstubAllGlobals();
});

// Fake Cache API keyed by request URL (strings only).
function fakeCaches(
	opts: { failOpen?: boolean; failMatch?: boolean; failPut?: boolean } = {},
) {
	const map = new Map<string, Response>();
	const cache = {
		match: async (u: string) => {
			if (opts.failMatch) throw new Error("opaque origin");
			const r = map.get(u);
			return r ? r.clone() : undefined;
		},
		put: async (u: string, r: Response) => {
			if (opts.failPut) throw new Error("quota");
			map.set(u, r);
		},
		delete: async (u: string) =>
			map.delete(
				typeof u === "string" ? u : (u as unknown as { url: string }).url,
			),
		keys: async () => [...map.keys()],
	};
	vi.stubGlobal("caches", {
		open: async () => {
			if (opts.failOpen) throw new Error("denied");
			return cache;
		},
	});
	return { map, cache };
}

describe("Cache API backend", () => {
	it("round-trips bytes and content type, with a synthetic URL per encoded key", async () => {
		const { map } = fakeCaches();
		const s = await openStore("t", "cache");
		expect(s.kind).toBe("cache");
		expect(
			await s.put("tile/1 2?x", { body: body(1, 2, 3), type: "image/png" }),
		).toBe(true);
		expect([...map.keys()][0]).toBe(
			`https://summit-lens-tile-cache.invalid/${encodeURIComponent("tile/1 2?x")}`,
		);
		const got = await s.get("tile/1 2?x");
		expect(got?.type).toBe("image/png");
		expect(bytesOf(got?.body as ArrayBuffer)).toEqual([1, 2, 3]);
		expect(await s.get("other")).toBeNull();
	});

	it("deletes one key, clears all, and stores meta separately as JSON", async () => {
		fakeCaches();
		const s = await openStore("t", "cache");
		await s.put("a", { body: body(1), type: "x" });
		await s.put("b", { body: body(2), type: "x" });
		await s.putMeta({ order: ["a", "b"] });
		expect(await s.getMeta()).toEqual({ order: ["a", "b"] });
		await s.delete("a");
		expect(await s.get("a")).toBeNull();
		expect(await s.get("b")).not.toBeNull();
		await s.clear();
		expect(await s.get("b")).toBeNull();
		expect(await s.getMeta()).toBeNull();
	});

	it("reports a failed write as false and a failed read as a miss instead of throwing", async () => {
		fakeCaches({ failPut: true });
		const s = await openStore("t", "cache");
		expect(await s.put("a", { body: body(1), type: "x" })).toBe(false);
		await s.putMeta({ a: 1 }); // swallowed
		expect(await s.getMeta()).toBeNull();
	});

	it("is not selected when caches throw on use or on open", async () => {
		fakeCaches({ failMatch: true });
		expect((await openStore("t", "cache")).kind).toBe("memory");
		fakeCaches({ failOpen: true });
		expect((await openStore("t", "auto")).kind).toBe("memory");
	});
});

// Minimal fake IndexedDB with the blobs/meta stores the IdbStore uses.
function fakeIdb(opts: { failTx?: boolean } = {}) {
	const stores = {
		blobs: new Map<string, unknown>(),
		meta: new Map<string, unknown>(),
	};
	const db = {
		onversionchange: null as (() => void) | null,
		objectStoreNames: { contains: () => true },
		createObjectStore: () => {},
		close: vi.fn(),
		transaction(name: "blobs" | "meta") {
			if (opts.failTx) throw new Error("InvalidStateError");
			const st = stores[name];
			const t: {
				oncomplete?: () => void;
				onerror?: () => void;
				onabort?: () => void;
				error?: unknown;
				objectStore: () => unknown;
			} = {
				objectStore: () => {
					const mk = <T>(fn: () => T) => {
						const r: { result?: T; onsuccess?: () => void } = {};
						queueMicrotask(() => {
							r.result = fn();
							r.onsuccess?.();
							t.oncomplete?.();
						});
						return r;
					};
					return {
						get: (k: string) => mk(() => st.get(k)),
						put: (v: unknown, k: string) =>
							mk(() => {
								st.set(k, v);
								return k;
							}),
						delete: (k: string) =>
							mk(() => {
								st.delete(k);
							}),
						clear: () =>
							mk(() => {
								st.clear();
							}),
					};
				},
			};
			return t;
		},
	};
	vi.stubGlobal("indexedDB", {
		open: () => {
			const req: { result: typeof db; onsuccess?: () => void } = { result: db };
			queueMicrotask(() => req.onsuccess?.());
			return req;
		},
	});
	return { stores, db };
}

describe("IndexedDB backend", () => {
	it("is the fallback when Cache API is missing, and round-trips bytes", async () => {
		vi.stubGlobal("caches", undefined);
		const { stores } = fakeIdb();
		const s = await openStore("t", "auto");
		expect(s.kind).toBe("idb");
		expect(await s.put("k", { body: body(9, 8), type: "image/webp" })).toBe(
			true,
		);
		expect(stores.blobs.has("k")).toBe(true);
		const got = await s.get("k");
		expect(got?.type).toBe("image/webp");
		expect(bytesOf(got?.body as ArrayBuffer)).toEqual([9, 8]);
		expect(await s.get("nope")).toBeNull();
	});

	it("keeps meta in its own store, delete removes one key and clear empties both stores", async () => {
		const { stores } = fakeIdb();
		const s = await openStore("t", "idb");
		await s.put("k", { body: body(1), type: "x" });
		await s.putMeta({ v: 2 });
		expect(await s.getMeta()).toEqual({ v: 2 });
		expect(stores.blobs.size).toBe(1);
		await s.delete("k");
		expect(stores.blobs.size).toBe(0);
		await s.put("k", { body: body(1), type: "x" });
		await s.clear();
		expect(stores.blobs.size + stores.meta.size).toBe(0);
	});

	it("closes its connection when another tab changes the version", async () => {
		const { db } = fakeIdb();
		await openStore("t", "idb");
		db.onversionchange?.();
		expect(db.close).toHaveBeenCalledTimes(1);
	});

	it("turns transaction failures into misses and false", async () => {
		fakeIdb({ failTx: true });
		const s = await openStore("t", "idb");
		expect(await s.get("k")).toBeNull();
		expect(await s.put("k", { body: body(1), type: "x" })).toBe(false);
		expect(await s.getMeta()).toBeNull();
		await s.delete("k");
		await s.clear();
		await s.putMeta({});
	});
});

describe("openStore selection", () => {
	it("honours 'none' and 'memory' and falls through to memory with no backends", async () => {
		expect((await openStore("t", "none")).kind).toBe("none");
		expect((await openStore("t", "memory")).kind).toBe("memory");
		vi.stubGlobal("caches", undefined);
		vi.stubGlobal("indexedDB", undefined);
		expect((await openStore("t")).kind).toBe("memory");
		expect((await openStore("t", "idb")).kind).toBe("memory");
	});
});

describe("MemoryStore / NullStore", () => {
	it("memory store holds values and clear drops meta too", async () => {
		const s = new MemoryStore();
		await s.put("a", { body: body(1), type: "x" });
		await s.putMeta({ m: 1 });
		expect(await s.get("a")).not.toBeNull();
		await s.delete("a");
		expect(await s.get("a")).toBeNull();
		await s.clear();
		expect(await s.getMeta()).toBeNull();
	});
	it("null store never keeps anything and reports failed writes", async () => {
		const s = new NullStore();
		expect(await s.put()).toBe(false);
		expect(await s.get()).toBeNull();
		expect(await s.getMeta()).toBeNull();
	});
});
