// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A small in-memory IndexedDB: object stores keyed by `id` (keyPath), async requests, and the
// open/blocked/versionchange hooks that store.ts reacts to.
type Rec = { id: string };
type Req<T> = {
	result?: T;
	error?: unknown;
	onsuccess?: () => void;
	onerror?: () => void;
};

class FakeDb {
	closed = false;
	onversionchange: (() => void) | null = null;
	stores = new Map<string, Map<string, Rec>>();
	failTx: string | null = null;
	objectStoreNames = {
		contains: (n: string) => this.stores.has(n),
	};
	createObjectStore(n: string) {
		this.stores.set(n, new Map());
	}
	close() {
		this.closed = true;
	}
	transaction(name: string) {
		if (this.closed) throw new Error("InvalidStateError");
		const st = this.stores.get(name);
		if (!st) throw new Error("NotFoundError");
		const t: {
			oncomplete?: () => void;
			onerror?: () => void;
			onabort?: () => void;
			error?: unknown;
			objectStore: (n: string) => unknown;
		} = {
			objectStore: () => ({
				put: (r: Rec) =>
					run(t, () => {
						st.set(r.id, r);
						return r.id;
					}),
				get: (k: string) => run(t, () => st.get(k)),
				delete: (k: string) =>
					run(t, () => {
						st.delete(k);
					}),
				getAll: () => run(t, () => [...st.values()]),
				getAllKeys: () => run(t, () => [...st.keys()]),
			}),
		};
		return t;
	}
}

function run<T>(
	t: { oncomplete?: () => void; onabort?: () => void; error?: unknown },
	fn: () => T,
) {
	const req: Req<T> = {};
	queueMicrotask(() => {
		if (current.failTx) {
			t.error = new Error(current.failTx);
			(t as { onerror?: () => void }).onerror?.();
			return;
		}
		req.result = fn();
		t.oncomplete?.();
	});
	return req;
}

let current: FakeDb;
let opens: number;
let mode: "ok" | "blocked" | "error" | "lateSuccessAfterBlocked";
let lastReq: {
	onsuccess?: () => void;
	onblocked?: () => void;
	onerror?: () => void;
	onupgradeneeded?: () => void;
	result: FakeDb;
	error?: unknown;
};

function installIdb(db: FakeDb) {
	vi.stubGlobal("indexedDB", {
		open: () => {
			opens++;
			const req = { result: db, error: undefined as unknown } as typeof lastReq;
			lastReq = req;
			queueMicrotask(() => {
				if (!db.objectStoreNames.contains("photos")) req.onupgradeneeded?.();
				if (mode === "ok") req.onsuccess?.();
				else if (mode === "blocked" || mode === "lateSuccessAfterBlocked")
					req.onblocked?.();
				else {
					req.error = new Error("open failed");
					req.onerror?.();
				}
			});
			return req;
		},
	});
}

async function load() {
	vi.resetModules();
	return import("../store");
}

const meta = { id: "p1" } as never;
const rec = (id: string) => ({ id, meta, blob: new Blob(["x"]) }) as never;

beforeEach(() => {
	current = new FakeDb();
	opens = 0;
	mode = "ok";
	installIdb(current);
});
afterEach(() => vi.unstubAllGlobals());

describe("upload store", () => {
	it("creates both object stores on upgrade and round-trips photo records", async () => {
		const s = await load();
		await s.putPhoto(rec("a"));
		expect([...current.stores.keys()].sort()).toEqual(["photos", "regions"]);
		expect(await s.getPhotoRecord("a")).toMatchObject({ id: "a" });
		expect(await s.getPhotoRecord("missing")).toBeNull();
		await s.putPhoto(rec("b"));
		expect((await s.allPhotoRecords()).map((r) => r.id).sort()).toEqual([
			"a",
			"b",
		]);
		await s.deletePhotoRecord("a");
		expect(await s.getPhotoRecord("a")).toBeNull();
	});

	it("keeps photos and regions in separate stores and lists region ids as strings", async () => {
		const s = await load();
		await s.putRegion({ id: "r1" } as never);
		await s.putRegion({ id: "r2" } as never);
		await s.putPhoto(rec("r1"));
		expect((await s.regionIds()).sort()).toEqual(["r1", "r2"]);
		expect(await s.getRegion("r1")).toMatchObject({ id: "r1" });
		expect(await s.getRegion("zzz")).toBeNull();
		await s.deleteRegion("r1");
		expect(await s.regionIds()).toEqual(["r2"]);
		expect(await s.getPhotoRecord("r1")).not.toBeNull();
	});

	it("opens the database once for many operations", async () => {
		const s = await load();
		await Promise.all([
			s.putPhoto(rec("a")),
			s.putPhoto(rec("b")),
			s.allPhotoRecords(),
		]);
		expect(opens).toBe(1);
	});

	it("rejects when IndexedDB is unavailable (private mode, SSR)", async () => {
		vi.stubGlobal("indexedDB", undefined);
		const s = await load();
		await expect(s.putPhoto(rec("a"))).rejects.toThrow("IndexedDB unavailable");
	});

	it("rejects on a blocked open and retries on the next call instead of caching the failure", async () => {
		mode = "blocked";
		const s = await load();
		await expect(s.allPhotoRecords()).rejects.toThrow(/blocked/);
		mode = "ok";
		installIdb(current);
		await expect(s.allPhotoRecords()).resolves.toEqual([]);
		expect(opens).toBe(2);
	});

	it("closes a connection that opens after the open was given up as blocked", async () => {
		mode = "blocked";
		const s = await load();
		await expect(s.allPhotoRecords()).rejects.toThrow(/blocked/);
		lastReq.onsuccess?.();
		expect(current.closed).toBe(true);
	});

	it("rejects on an open error and does not cache it", async () => {
		mode = "error";
		const s = await load();
		await expect(s.allPhotoRecords()).rejects.toThrow("open failed");
		mode = "ok";
		installIdb(current);
		await expect(s.allPhotoRecords()).resolves.toEqual([]);
	});

	it("releases the connection on versionchange and reopens on next use", async () => {
		const s = await load();
		await s.putPhoto(rec("a"));
		expect(opens).toBe(1);
		current.onversionchange?.();
		expect(current.closed).toBe(true);
		const fresh = new FakeDb();
		fresh.stores = current.stores;
		current = fresh;
		installIdb(fresh);
		expect(await s.getPhotoRecord("a")).toMatchObject({ id: "a" });
		expect(opens).toBe(2);
	});

	it("rejects a transaction error with the transaction's error", async () => {
		const s = await load();
		await s.allPhotoRecords();
		current.failTx = "QuotaExceededError";
		await expect(s.putPhoto(rec("big"))).rejects.toThrow("QuotaExceededError");
	});
});
