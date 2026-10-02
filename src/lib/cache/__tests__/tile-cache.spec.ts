// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryStore, NullStore, openStore } from "../store";
import { rangeKey, TileCache } from "../tile-cache";

const bytes = (...v: number[]) => Uint8Array.from(v);
const BODY = bytes(1, 2, 3, 4);

function server(status = 200, body: Uint8Array = BODY, type = "image/png") {
	return vi.fn(
		async (_u: RequestInfo | URL, _init?: RequestInit) =>
			new Response(status === 200 ? (body as BodyInit) : null, {
				status,
				headers: { "content-type": type },
			}),
	);
}
const mk = (
	fetch: typeof globalThis.fetch,
	extra: ConstructorParameters<typeof TileCache>[0] = {},
) => new TileCache({ fetch, backend: "memory", metaDebounceMs: 5, ...extra });
const arr = (b: ArrayBuffer) => Array.from(new Uint8Array(b));

afterEach(() => vi.useRealTimers());

describe("TileCache.get", () => {
	it("misses to the network, then serves from memory", async () => {
		const f = server();
		const c = mk(f);
		const a = await c.get("https://t/1");
		expect(a).toMatchObject({
			status: 200,
			source: "network",
			type: "image/png",
		});
		expect(arr(a.body)).toEqual([1, 2, 3, 4]);
		const b = await c.get("https://t/1");
		expect(b.source).toBe("memory");
		expect(f).toHaveBeenCalledTimes(1);
		const s = c.stats();
		expect(s.hits.memory).toBe(1);
		expect(s.misses).toBe(1);
		expect(s.network.bytes).toBe(4);
	});
	it("shares one request between concurrent callers", async () => {
		const f = server();
		const c = mk(f);
		await Promise.all([
			c.get("https://t/1"),
			c.get("https://t/1"),
			c.get("https://t/1"),
		]);
		expect(f).toHaveBeenCalledTimes(1);
	});
	it("uses cors + no-store by default and lets fetchInit override", async () => {
		const f = server();
		await mk(f).get("https://t/1");
		expect(f.mock.calls[0][1]).toMatchObject({
			mode: "cors",
			cache: "no-store",
		});
		const g = server();
		await mk(g, { fetchInit: { cache: "default" } }).get("https://t/1");
		expect(g.mock.calls[0][1]).toMatchObject({
			mode: "cors",
			cache: "default",
		});
	});
	it("persists network bodies and serves them after the memory tier is gone", async () => {
		const f = server();
		const c = mk(f, { memoryCapBytes: 0 });
		await c.get("https://t/1");
		await c.flushWrites();
		expect(c.stats()).toMatchObject({
			entries: 1,
			bytes: 4,
			writes: { ok: 1, failed: 0 },
		});
		const again = await c.get("https://t/1");
		expect(again.source).toBe("persistent");
		expect(f).toHaveBeenCalledTimes(1);
		expect(c.stats().hits.persistent).toBe(1);
	});
	it("persist:false skips the store", async () => {
		const c = mk(server(), { memoryCapBytes: 0 });
		await c.get("https://t/1", { persist: false });
		await c.flushWrites();
		expect(c.stats().entries).toBe(0);
	});
	it("does not store or memoise non-2xx and negative-caches 404 for the session", async () => {
		const f = server(404);
		const c = mk(f);
		const a = await c.get("https://t/missing");
		expect(a).toMatchObject({ status: 404, source: "network" });
		expect(a.body.byteLength).toBe(0);
		const b = await c.get("https://t/missing");
		expect(b).toMatchObject({ status: 404, source: "memory" });
		expect(f).toHaveBeenCalledTimes(1);
		expect(c.stats().network.notOk).toBe(1);
		await c.flushWrites();
		expect(c.stats().entries).toBe(0);
	});
	it("does not negative-cache a 500", async () => {
		const f = server(500);
		const c = mk(f);
		await c.get("https://t/e");
		await c.get("https://t/e");
		expect(f).toHaveBeenCalledTimes(2);
	});
	it("rejects on a network error and counts it", async () => {
		const c = mk(
			vi.fn(async () => {
				throw new TypeError("offline");
			}),
		);
		await expect(c.get("https://t/1")).rejects.toThrow("offline");
		expect(c.stats().network.errors).toBe(1);
	});
	it("rejects with AbortError for a pre-aborted signal without fetching", async () => {
		const f = server();
		const ac = new AbortController();
		ac.abort();
		await expect(
			mk(f).get("https://t/1", { signal: ac.signal }),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(f).not.toHaveBeenCalled();
	});
	it("aborts a slow fetch when its only caller aborts, without counting a network error", async () => {
		const f = vi.fn(
			(_u: unknown, init?: RequestInit) =>
				new Promise<Response>((_res, rej) => {
					init?.signal?.addEventListener("abort", () =>
						rej(Object.assign(new Error("aborted"), { name: "AbortError" })),
					);
				}),
		);
		const c = mk(f);
		const ac = new AbortController();
		const p = c.get("https://t/1", { signal: ac.signal });
		await new Promise((r) => setTimeout(r, 5));
		ac.abort();
		await expect(p).rejects.toMatchObject({ name: "AbortError" });
		expect(c.stats().network.errors).toBe(0);
	});
	it("times out a stalled fetch with a TimeoutError", async () => {
		vi.useFakeTimers();
		const f = vi.fn(
			(_u: unknown, init?: RequestInit) =>
				new Promise<Response>((_res, rej) => {
					init?.signal?.addEventListener("abort", () =>
						rej(init.signal?.reason),
					);
				}),
		);
		const c = mk(f, { fetchTimeoutMs: 1000 });
		const p = c.get("https://t/1");
		const caught = p.catch((e) => e);
		await vi.advanceTimersByTimeAsync(1001);
		const e = await caught;
		expect(e.name).toBe("TimeoutError");
		expect(c.stats().network).toMatchObject({ timeouts: 1, errors: 1 });
	});
	it("fetchTimeoutMs 0 disables the timeout", async () => {
		vi.useFakeTimers();
		const f = server();
		const p = mk(f, { fetchTimeoutMs: 0 }).get("https://t/1");
		await vi.advanceTimersByTimeAsync(0);
		expect((await p).status).toBe(200);
	});
});

describe("TileCache memory tier", () => {
	it("evicts least-recently-used tiles beyond memoryCapBytes", async () => {
		const f = server();
		const c = mk(f, { memoryCapBytes: 8, backend: "none" });
		await c.get("https://t/a");
		await c.get("https://t/b");
		await c.get("https://t/c"); // 12 bytes > 8: a is evicted
		expect(c.stats().memory).toMatchObject({ entries: 2, bytes: 8 });
		await c.get("https://t/a");
		expect(f).toHaveBeenCalledTimes(4);
	});
	it("does not hold a single body larger than the cap", async () => {
		const c = mk(server(), { memoryCapBytes: 2, backend: "none" });
		await c.get("https://t/a");
		expect(c.stats().memory.entries).toBe(0);
	});
});

describe("TileCache byte ranges", () => {
	it("sends a Range header and keys the entry by range", async () => {
		const f = vi.fn(async () => new Response(bytes(5, 6), { status: 206 }));
		const c = mk(f);
		const r = await c.get("https://t/f", { range: [10, 11] });
		expect(arr(r.body)).toEqual([5, 6]);
		expect(
			new Headers(
				(f.mock.calls[0] as unknown as [string, RequestInit])[1].headers,
			).get("Range"),
		).toBe("bytes=10-11");
		expect((await c.get("https://t/f", { range: [10, 11] })).source).toBe(
			"memory",
		);
		expect(rangeKey("https://t/f", 10, 11)).toBe("https://t/f bytes=10-11");
	});
	it("slices a whole-file 200 answer to the range", async () => {
		const c = mk(server(200, bytes(0, 1, 2, 3, 4, 5, 6, 7)));
		const r = await c.get("https://t/f", { range: [2, 4] });
		expect(arr(r.body)).toEqual([2, 3, 4]);
	});
});

describe("TileCache persistence limits", () => {
	it("keeps the persistent index under capBytes by evicting the oldest", async () => {
		const c = mk(server(), { capBytes: 8, memoryCapBytes: 0 });
		for (const k of ["a", "b", "c"]) {
			await c.get(`https://t/${k}`);
			await c.flushWrites();
		}
		const s = c.stats();
		expect(s.bytes).toBeLessThanOrEqual(8);
		expect(s.entries).toBe(2);
		expect(s.evictions).toBeGreaterThanOrEqual(1);
	});
	it("never stores a body bigger than the cap", async () => {
		const c = mk(server(), { capBytes: 2, memoryCapBytes: 0 });
		await c.get("https://t/a");
		await c.flushWrites();
		expect(c.stats().entries).toBe(0);
	});
	it("a store that cannot write counts failures and drops the index entry", async () => {
		const c = mk(server(), { backend: "none", memoryCapBytes: 0 });
		await c.get("https://t/a");
		await c.flushWrites();
		expect(c.stats().entries).toBe(0);
		expect(c.stats().backend).toBe("none");
	});
});

describe("derived blobs", () => {
	it("round-trips through memory and the store", async () => {
		const c = mk(server());
		await c.writeDerived(
			"heights:1",
			Uint8Array.from([9, 8, 7]).buffer,
			"application/x-test",
		);
		const v = await c.readDerived("heights:1");
		expect(v && arr(v.body)).toEqual([9, 8, 7]);
		expect(v?.type).toBe("application/x-test");
		expect(await c.readDerived("heights:none")).toBeNull();
	});
	it("reads from the persistent store after the memory tier forgets", async () => {
		const c = mk(server(), { memoryCapBytes: 0 });
		await c.writeDerived("k", Uint8Array.from([1]).buffer);
		await c.flushWrites();
		const v = await c.readDerived("k");
		expect(v && arr(v.body)).toEqual([1]);
	});
});

describe("clear", () => {
	it("empties memory, store, negative cache and index", async () => {
		const f = server();
		const c = mk(f);
		await c.get("https://t/a");
		await c.flushWrites();
		await c.clear();
		expect(c.stats()).toMatchObject({
			entries: 0,
			bytes: 0,
			memory: { entries: 0 },
		});
		await c.get("https://t/a");
		expect(f).toHaveBeenCalledTimes(2);
	});
});

describe("readOnly", () => {
	it("never writes to or indexes the store", async () => {
		const c = mk(server(), { readOnly: true, memoryCapBytes: 0 });
		await c.get("https://t/a");
		await c.flushWrites();
		expect(c.stats()).toMatchObject({ entries: 0, writes: { ok: 0 } });
		await c.writeDerived("d", new ArrayBuffer(3));
		expect(c.stats().entries).toBe(0);
	});
});

describe("stats", () => {
	it("reports opening, then the backend kind", async () => {
		const c = mk(server());
		expect(c.stats().backend).toBe("opening");
		await c.ready();
		expect(c.stats().backend).toBe("memory");
		expect(c.stats().capBytes).toBe(300 * 1024 * 1024);
		expect(c.stats().queue.concurrency).toBe(24);
	});
});

describe("stores", () => {
	it("MemoryStore round-trips bodies and meta and clear wipes both", async () => {
		const s = new MemoryStore();
		expect(await s.put("k", { body: new ArrayBuffer(2), type: "a/b" })).toBe(
			true,
		);
		expect((await s.get("k"))?.type).toBe("a/b");
		await s.putMeta({ v: 1 });
		expect(await s.getMeta()).toEqual({ v: 1 });
		await s.delete("k");
		expect(await s.get("k")).toBeNull();
		await s.clear();
		expect(await s.getMeta()).toBeNull();
	});
	it("NullStore holds nothing and refuses writes", async () => {
		const s = new NullStore();
		expect(await s.put()).toBe(false);
		expect(await s.get()).toBeNull();
		expect(await s.getMeta()).toBeNull();
	});
	it("openStore honours explicit preferences and degrades to memory in node", async () => {
		expect((await openStore("x", "none")).kind).toBe("none");
		expect((await openStore("x", "memory")).kind).toBe("memory");
		expect((await openStore("x", "auto")).kind).toBe("memory"); // no Cache API / IndexedDB in node
		expect((await openStore("x", "cache")).kind).toBe("memory");
		expect((await openStore("x", "idb")).kind).toBe("memory");
	});
});
