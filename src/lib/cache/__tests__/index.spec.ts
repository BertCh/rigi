// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { afterEach, describe, expect, it, vi } from "vitest";
import {
	cachedFetch,
	cachedFetchBuffer,
	cachedFetchRange,
	cacheStats,
	clearTileCache,
	configureTileCache,
	getTileCache,
	readDerived,
	tilePriority,
	tileQueue,
	writeDerived,
} from "..";

const FILE = Uint8Array.from({ length: 50 }, (_, i) => i);
const server = vi.fn(async (u: RequestInfo | URL, init?: RequestInit) => {
	const url = String(u);
	if (url.endsWith("/404")) return new Response(null, { status: 404 });
	const m = /^bytes=(\d+)-(\d+)$/.exec(
		new Headers(init?.headers).get("Range") ?? "",
	);
	if (m)
		return new Response(FILE.slice(Number(m[1]), Number(m[2]) + 1), {
			status: 206,
		});
	return new Response(FILE.slice(), {
		status: 200,
		headers: { "content-type": "image/webp" },
	});
});
const fresh = () => {
	server.mockClear();
	return configureTileCache({ fetch: server, backend: "memory" });
};
afterEach(() => void fresh());

describe("tilePriority", () => {
	it("is km to the camera plus a small zoom bias", () => {
		expect(tilePriority(5000)).toBe(5);
		expect(tilePriority(0, 10)).toBeCloseTo(0.1, 12);
		expect(tilePriority(2000, 3)).toBeCloseTo(2.03, 12);
	});
	it("clamps negative distances to 0", () => {
		expect(tilePriority(-100)).toBe(0);
	});
	it("a coarse tile beats a fine one at equal distance", () => {
		expect(tilePriority(1000, 8)).toBeLessThan(tilePriority(1000, 14));
	});
});

describe("cachedFetch", () => {
	it("returns a fresh Response with the cache source header and content type", async () => {
		fresh();
		const a = await cachedFetch("https://x/a");
		expect(a.status).toBe(200);
		expect(a.headers.get("x-tile-cache")).toBe("network");
		expect(a.headers.get("content-type")).toBe("image/webp");
		expect((await a.arrayBuffer()).byteLength).toBe(50);
		const b = await cachedFetch("https://x/a");
		expect(b.headers.get("x-tile-cache")).toBe("memory");
		expect((await b.arrayBuffer()).byteLength).toBe(50); // each caller can consume its own body
	});
	it("defaults the content type and gives non-2xx an empty body", async () => {
		fresh();
		const r = await cachedFetch("https://x/404");
		expect(r.status).toBe(404);
		expect((await r.arrayBuffer()).byteLength).toBe(0);
	});
});

describe("cachedFetchBuffer", () => {
	it("returns a private copy of the bytes", async () => {
		fresh();
		const a = await cachedFetchBuffer("https://x/a");
		expect(a?.byteLength).toBe(50);
		new Uint8Array(a as ArrayBuffer).fill(0);
		const b = await cachedFetchBuffer("https://x/a");
		expect(new Uint8Array(b as ArrayBuffer)[7]).toBe(7);
	});
	it("is null for a non-2xx status", async () => {
		fresh();
		expect(await cachedFetchBuffer("https://x/404")).toBeNull();
	});
});

describe("cachedFetchRange", () => {
	it("returns exactly bytes [start, end] inclusive", async () => {
		fresh();
		expect(Array.from(await cachedFetchRange("https://x/f", 3, 6))).toEqual([
			3, 4, 5, 6,
		]);
	});
	it("throws with the url and range on a non-2xx status", async () => {
		fresh();
		await expect(cachedFetchRange("https://x/404", 0, 3)).rejects.toThrow(
			"https://x/404 bytes=0-3: HTTP 404",
		);
	});
});

describe("derived data", () => {
	it("round-trips and returns copies", async () => {
		fresh();
		await writeDerived("h", Uint8Array.from([4, 5, 6]).buffer);
		const v = await readDerived("h");
		expect(v && Array.from(new Uint8Array(v))).toEqual([4, 5, 6]);
		expect(await readDerived("nothing")).toBeNull();
	});
	it("is namespaced away from tile URLs", async () => {
		fresh();
		await writeDerived("https://x/a", Uint8Array.from([1]).buffer);
		await cachedFetch("https://x/a");
		expect(server).toHaveBeenCalledTimes(1); // the derived entry did not satisfy the URL
	});
});

describe("tileQueue", () => {
	it("clamps concurrency to an integer >= 1", () => {
		fresh();
		tileQueue.concurrency = 0;
		expect(tileQueue.concurrency).toBe(1);
		tileQueue.concurrency = 7.9;
		expect(tileQueue.concurrency).toBe(7);
	});
	it("proxies the current instance's queue", async () => {
		const c = fresh();
		expect(getTileCache()).toBe(c);
		await cachedFetch("https://x/a");
		await tileQueue.idle();
		expect(tileQueue.stats().completed).toBe(1);
		expect(cacheStats().misses).toBe(1);
	});
});

describe("configureTileCache / clearTileCache", () => {
	it("replaces the instance, dropping the old one's state", async () => {
		fresh();
		await cachedFetch("https://x/a");
		fresh();
		expect(cacheStats().misses).toBe(0);
		const r = await cachedFetch("https://x/a");
		expect(r.headers.get("x-tile-cache")).toBe("network");
	});
	it("clearTileCache forces a re-fetch", async () => {
		fresh();
		await cachedFetch("https://x/a");
		await clearTileCache();
		const r = await cachedFetch("https://x/a");
		expect(r.headers.get("x-tile-cache")).toBe("network");
	});
});
