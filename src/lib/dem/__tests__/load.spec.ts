// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// the shared tile cache is the network boundary: route it to a scripted fake
const cachedFetch = vi.fn<(url: string, ...a: unknown[]) => unknown>();
vi.mock("../../cache", () => ({
	cachedFetch: (url: string, o?: unknown) => cachedFetch(url, o),
	tilePriority: (d: number, z: number) => d + z,
}));

import {
	demRasterFromBytes,
	fetchDemBytes,
	fetchDemTile,
	loadDemTile,
} from "../load";
import { MAPTERHORN, TERRARIUM_AWS } from "../sources";

/** An "encoded image" for the stubbed decoder: raw RGBA bytes of a size x size Terrarium tile. */
function fakeTile(size: number, height: number) {
	const v = height + 32768;
	const r = Math.floor(v / 256);
	const g = Math.floor(v - r * 256);
	const px = new Uint8Array(size * size * 4);
	for (let i = 0; i < size * size; i++) px.set([r, g, 0, 255], i * 4);
	return px;
}
const ok = (bytes: Uint8Array) => ({
	ok: true,
	status: 200,
	arrayBuffer: async () => bytes.buffer.slice(0),
	blob: async () => new Blob([bytes as BlobPart]),
});
const status = (s: number) => ({
	ok: false,
	status: s,
	arrayBuffer: async () => new ArrayBuffer(0),
	blob: async () => new Blob([]),
});

beforeEach(() => {
	cachedFetch.mockReset();
	// createImageBitmap/OffscreenCanvas stand-ins that treat the blob bytes as the RGBA pixels
	vi.stubGlobal("createImageBitmap", async (blob: Blob) => {
		const data = new Uint8ClampedArray(await blob.arrayBuffer());
		const w = Math.sqrt(data.length / 4);
		return { width: w, height: w, close() {}, data };
	});
	vi.stubGlobal(
		"OffscreenCanvas",
		class {
			constructor(
				public w: number,
				public h: number,
			) {}
			getContext() {
				let src: Uint8ClampedArray = new Uint8ClampedArray(0);
				return {
					clearRect() {},
					drawImage: (b: { data: Uint8ClampedArray }) => {
						src = b.data;
					},
					getImageData: () => ({ data: src }),
				};
			}
		},
	);
});
afterEach(() => vi.unstubAllGlobals());

describe("fetchDemTile", () => {
	it("decodes a 2xx tile through the stubbed image decoder", async () => {
		vi.stubGlobal("fetch", async () => ok(fakeTile(4, 1234)));
		const h = await fetchDemTile(TERRARIUM_AWS, { z: 1, x: 0, y: 0 });
		expect(h?.length).toBe(16);
		expect(h?.[5]).toBeCloseTo(1234, 3);
	});
	it("is undefined on any non-2xx", async () => {
		vi.stubGlobal("fetch", async () => status(404));
		expect(
			await fetchDemTile(TERRARIUM_AWS, { z: 1, x: 0, y: 0 }),
		).toBeUndefined();
	});
	it("requests the source's own URL", async () => {
		const f = vi.fn(async (_url: string) => status(500));
		vi.stubGlobal("fetch", f);
		await fetchDemTile(TERRARIUM_AWS, { z: 3, x: 4, y: 5 });
		expect(f.mock.calls[0][0]).toBe(TERRARIUM_AWS.url({ z: 3, x: 4, y: 5 }));
	});
});

describe("fetchDemBytes", () => {
	it("returns the tile itself when it exists", async () => {
		cachedFetch.mockResolvedValue(ok(fakeTile(2, 10)));
		const r = await fetchDemBytes({ z: 15, x: 100, y: 200 });
		expect(r?.source).toEqual({ z: 15, x: 100, y: 200 });
		expect(cachedFetch.mock.calls[0][0]).toBe(
			MAPTERHORN.url({ z: 15, x: 100, y: 200 }),
		);
	});
	it("clamps zoom above maxZoom to the ancestor at maxZoom", async () => {
		cachedFetch.mockResolvedValue(ok(fakeTile(2, 10)));
		const r = await fetchDemBytes({ z: 19, x: 4 * 5, y: 4 * 7 });
		expect(r?.source).toEqual({ z: 17, x: 5, y: 7 });
	});
	it("falls back through ancestors on 404 and remembers the miss", async () => {
		const key = { z: 8, x: 33, y: 77 };
		cachedFetch.mockImplementation(async (url: string) =>
			url === MAPTERHORN.url(key) ? status(404) : ok(fakeTile(2, 10)),
		);
		const r = await fetchDemBytes(key);
		expect(r?.source).toEqual({ z: 7, x: 16, y: 38 });
		expect(cachedFetch).toHaveBeenCalledTimes(2);
		cachedFetch.mockClear();
		// the missing key is not probed again; a child skips straight to its grandparent
		const r2 = await fetchDemBytes({ z: 9, x: 66, y: 154 });
		expect(r2?.source).toEqual({ z: 7, x: 16, y: 38 });
		expect(cachedFetch.mock.calls.map((c) => c[0])).not.toContain(
			MAPTERHORN.url(key),
		);
	});
	it("respects minZoom: null when nothing at or above it exists", async () => {
		cachedFetch.mockResolvedValue(status(404));
		expect(
			await fetchDemBytes({ z: 6, x: 1, y: 1 }, { minZoom: 5 }),
		).toBeNull();
	});
	it("retries once after a network error", async () => {
		cachedFetch
			.mockRejectedValueOnce(new Error("net"))
			.mockResolvedValueOnce(ok(fakeTile(2, 3)));
		const r = await fetchDemBytes({ z: 14, x: 8000, y: 9000 });
		expect(r?.source.z).toBe(14);
		expect(cachedFetch).toHaveBeenCalledTimes(2);
	});
	it("rejects on abort instead of falling back", async () => {
		const e = Object.assign(new Error("aborted"), { name: "AbortError" });
		cachedFetch.mockRejectedValue(e);
		await expect(fetchDemBytes({ z: 14, x: 2, y: 2 })).rejects.toBe(e);
	});
});

describe("loadDemTile / demRasterFromBytes", () => {
	it("decodes bytes to a raster of the requested key", async () => {
		const key = { z: 14, x: 10, y: 10 };
		cachedFetch.mockResolvedValue(ok(fakeTile(4, 500)));
		const r = await loadDemTile(key);
		expect(r?.key).toEqual(key);
		expect(r?.size).toBe(4);
		expect(r?.heights[0]).toBeCloseTo(500, 3);
	});
	it("a constant ancestor crops to the same constant", async () => {
		const buf = fakeTile(8, 1000).buffer;
		const r = await demRasterFromBytes(
			{ z: 5, x: 3, y: 2 },
			{ source: { z: 3, x: 0, y: 0 }, buf },
		);
		expect(r?.size).toBe(8);
		expect(r?.source).toEqual({ z: 3, x: 0, y: 0 });
		for (const v of r?.heights ?? []) expect(v).toBeCloseTo(1000, 3);
	});
	it("an undecodable image gives null", async () => {
		vi.stubGlobal("createImageBitmap", async () => {
			throw new Error("bad image");
		});
		expect(
			await demRasterFromBytes(
				{ z: 1, x: 0, y: 0 },
				{ source: { z: 1, x: 0, y: 0 }, buf: new ArrayBuffer(4) },
			),
		).toBeNull();
	});
	it("loadDemTile is null when nothing loads", async () => {
		cachedFetch.mockResolvedValue(status(404));
		expect(await loadDemTile({ z: 3, x: 1, y: 1 }, { minZoom: 3 })).toBeNull();
	});
});
