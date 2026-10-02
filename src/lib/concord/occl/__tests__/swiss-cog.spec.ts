// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it, vi } from "vitest";
import {
	DSM_COLLECTION,
	httpJsonFetcher,
	httpRangeFetcher,
	inSwissExtent,
	type JsonFetcher,
	lv95ToWgs84,
	lzwDecode,
	newStats,
	openCog,
	pickLevel,
	readWindow,
	STAC_ROOT,
	stacTiles,
	wgs84ToLv95,
} from "../swiss-cog";
import { buildTiff, lzwEncodeLiterals, memoryFetcher } from "./tiff-fixture";

const URL0 = "mem://a.tif";
const ramp = (w: number, h: number) => {
	const v = new Float32Array(w * h);
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) v[y * w + x] = y * 1000 + x;
	return v;
};

describe("LV95 conversions", () => {
	it("maps the Bern observatory to the LV95 origin within a metre", () => {
		const [E, N] = wgs84ToLv95(46.951082877, 7.438632495);
		expect(Math.abs(E - 2600000)).toBeLessThan(1.5);
		expect(Math.abs(N - 1200000)).toBeLessThan(1.5);
	});

	it("round-trips WGS84 -> LV95 -> WGS84 across Switzerland", () => {
		for (const [lat, lon] of [
			[46.95, 7.44],
			[47.37, 8.54],
			[46.2, 6.15],
			[46.8, 9.84],
		]) {
			const [E, N] = wgs84ToLv95(lat, lon);
			const [la, lo] = lv95ToWgs84(E, N);
			expect(Math.abs(la - lat)).toBeLessThan(2e-4);
			expect(Math.abs(lo - lon)).toBeLessThan(2e-4);
		}
	});

	it("inSwissExtent accepts Swiss points and rejects neighbours", () => {
		expect(inSwissExtent(46.95, 7.44)).toBe(true);
		expect(inSwissExtent(47.37, 8.54)).toBe(true);
		expect(inSwissExtent(48.85, 2.35)).toBe(false); // Paris
		expect(inSwissExtent(45.46, 9.19)).toBe(false); // Milan
		expect(inSwissExtent(47.2, 11.5)).toBe(false); // east of the bbox
	});
});

describe("lzwDecode", () => {
	it("decodes a literal-only stream", () => {
		const src = Uint8Array.from({ length: 700 }, (_, i) => (i * 7) & 255);
		expect(Array.from(lzwDecode(lzwEncodeLiterals(src), src.length))).toEqual(
			Array.from(src),
		);
	});

	it("decodes the KwKwK special case ('aaa' = clear, a, 258, eoi)", () => {
		const codes = [256, 97, 258, 257];
		const bits = codes.flatMap((c) =>
			Array.from({ length: 9 }, (_, i) => (c >> (8 - i)) & 1),
		);
		while (bits.length % 8) bits.push(0);
		const bytes = new Uint8Array(bits.length / 8);
		bits.forEach((b, i) => {
			bytes[i >> 3] |= b << (7 - (i & 7));
		});
		expect(Array.from(lzwDecode(bytes, 3))).toEqual([97, 97, 97]);
	});

	it("decodes table references ('abab' = a, b, 258, eoi after clear)", () => {
		const codes = [256, 97, 98, 258, 257];
		const bits = codes.flatMap((c) =>
			Array.from({ length: 9 }, (_, i) => (c >> (8 - i)) & 1),
		);
		while (bits.length % 8) bits.push(0);
		const bytes = new Uint8Array(bits.length / 8);
		bits.forEach((b, i) => {
			bytes[i >> 3] |= b << (7 - (i & 7));
		});
		expect(Array.from(lzwDecode(bytes, 4))).toEqual([97, 98, 97, 98]);
	});

	it("returns a zero-padded buffer on truncated input", () => {
		const out = lzwDecode(new Uint8Array([0x80]), 8);
		expect(out).toHaveLength(8);
	});
});

describe("openCog header parsing", () => {
	const w = 64;
	const h = 48;
	const bytes = buildTiff({
		levels: [
			{ width: w, height: h, tileW: 32, tileH: 16, values: ramp(w, h) },
			{
				width: 32,
				height: 24,
				tileW: 32,
				tileH: 24,
				values: ramp(32, 24),
				overview: true,
			},
		],
		pixel: 2,
		originX: 2600000,
		originY: 1201000,
		nodata: -9999,
		pad: 5000,
	});
	const files = { [URL0]: bytes };

	it("reads levels, tile tables, origin, pixel size and nodata", async () => {
		const { fetcher } = memoryFetcher(files);
		const stats = newStats();
		const hdr = await openCog(URL0, fetcher, stats, undefined, 4096);
		expect(hdr.littleEndian).toBe(true);
		expect(hdr.levels).toHaveLength(2);
		expect(hdr.levels[0]).toMatchObject({
			width: w,
			height: h,
			tileW: 32,
			tileH: 16,
			bitsPerSample: 32,
			sampleFormat: 3,
			compression: 1,
			predictor: 1,
			resX: 2,
		});
		expect(hdr.levels[0].offsets).toHaveLength(2 * 3);
		expect(hdr.levels[1].resX).toBe(4);
		expect(hdr.originX).toBe(2600000);
		expect(hdr.originY).toBe(1201000);
		expect(hdr.nodata).toBe(-9999);
		expect(stats.requests).toBeGreaterThanOrEqual(2); // header prefix, then the IFDs 5 kB in
		expect(stats.bytes).toBe(hdr.prefix.length);
	});

	it("rejects a non-TIFF", async () => {
		const { fetcher } = memoryFetcher({ [URL0]: new Uint8Array(5000).fill(7) });
		await expect(
			openCog(URL0, fetcher, undefined, undefined, 4096),
		).rejects.toThrow(/not a TIFF/);
	});

	it("propagates a fetch failure", async () => {
		const { fetcher } = memoryFetcher({});
		await expect(
			openCog(URL0, fetcher, undefined, undefined, 4096),
		).rejects.toThrow(/404/);
	});

	it("pickLevel chooses the level nearest the requested resolution", async () => {
		const { fetcher } = memoryFetcher(files);
		const hdr = await openCog(URL0, fetcher, undefined, undefined, 4096);
		expect(pickLevel(hdr, 2)).toBe(0);
		expect(pickLevel(hdr, 4)).toBe(1);
		expect(pickLevel(hdr, 0.5)).toBe(0);
		expect(pickLevel(hdr, 100)).toBe(1);
		expect(pickLevel(hdr, 2.7)).toBe(0); // log-nearest: midpoint is sqrt(8) = 2.83
		expect(pickLevel(hdr, 2.9)).toBe(1);
	});
});

describe("readWindow", () => {
	const w = 70; // not a multiple of the tile width: right-edge tiles are padded
	const h = 40;
	const values = ramp(w, h);
	const open = async (
		opts: Partial<Parameters<typeof buildTiff>[0]["levels"][0]> = {},
		nodata?: number,
	) => {
		const bytes = buildTiff({
			levels: [{ width: w, height: h, tileW: 32, tileH: 16, values, ...opts }],
			pixel: 1,
			originX: 0,
			originY: 100,
			nodata,
			pad: 4200,
		});
		const m = memoryFetcher({ [URL0]: bytes });
		const hdr = await openCog(URL0, m.fetcher, undefined, undefined, 4096);
		return { hdr, ...m };
	};

	it("returns the exact pixels of a window crossing tile boundaries", async () => {
		const { hdr, fetcher } = await open();
		const out = await readWindow(hdr, 0, 20, 10, 30, 20, fetcher);
		for (let y = 0; y < 20; y++)
			for (let x = 0; x < 30; x++)
				expect(out[y * 30 + x]).toBe(values[(10 + y) * w + 20 + x]);
	});

	it("reads the ragged right edge (padded tile) correctly", async () => {
		const { hdr, fetcher } = await open();
		const out = await readWindow(hdr, 0, 60, 0, 10, 40, fetcher);
		expect(out[0]).toBe(60);
		expect(out[9]).toBe(69);
		expect(out[39 * 10 + 9]).toBe(39 * 1000 + 69);
	});

	it("leaves a window beyond the tile grid as NaN", async () => {
		const { hdr, fetcher } = await open();
		const out = await readWindow(hdr, 0, 200, 200, 4, 4, fetcher);
		expect(out.every(Number.isNaN)).toBe(true);
	});

	it("maps nodata and values <= -9998 to NaN", async () => {
		const v = new Float32Array(w * h).fill(5);
		v[3] = -9999;
		v[4] = -1;
		const { hdr, fetcher } = await open({ values: v }, -1);
		const out = await readWindow(hdr, 0, 0, 0, 8, 1, fetcher);
		expect(Number.isNaN(out[3])).toBe(true);
		expect(Number.isNaN(out[4])).toBe(true);
		expect(out[2]).toBe(5);
	});

	it("merges contiguous tiles of a row into one request and counts bytes", async () => {
		const { hdr, fetcher, calls } = await open();
		calls.length = 0;
		const stats = newStats();
		await readWindow(hdr, 0, 0, 0, w, 16, fetcher, stats);
		const tileCalls = calls.filter((c) => c.start >= 4200);
		expect(tileCalls.length).toBeLessThanOrEqual(1);
		expect(stats.requests).toBeLessThanOrEqual(1);
	});

	it("reuses the header prefix for tiles it already holds (no request)", async () => {
		const bytes = buildTiff({
			levels: [{ width: 8, height: 8, tileW: 8, tileH: 8, values: ramp(8, 8) }],
			pixel: 1,
			originX: 0,
			originY: 8,
		});
		const m = memoryFetcher({ [URL0]: bytes });
		const hdr = await openCog(URL0, m.fetcher, undefined, undefined, 4096);
		m.calls.length = 0;
		const out = await readWindow(hdr, 0, 0, 0, 8, 8, m.fetcher);
		expect(m.calls).toHaveLength(0);
		expect(out[63]).toBe(7 * 1000 + 7);
	});

	it("decodes Deflate tiles", async () => {
		const { hdr, fetcher } = await open({ compression: 8 });
		const out = await readWindow(hdr, 0, 30, 14, 6, 4, fetcher);
		expect(out[0]).toBe(14 * 1000 + 30);
		expect(out[3 * 6 + 5]).toBe(17 * 1000 + 35);
	});

	it("decodes LZW tiles", async () => {
		const { hdr, fetcher } = await open({ compression: 5 });
		const out = await readWindow(hdr, 0, 30, 14, 6, 4, fetcher);
		expect(out[0]).toBe(14 * 1000 + 30);
		expect(out[3 * 6 + 5]).toBe(17 * 1000 + 35);
	});

	it("undoes the horizontal predictor on int16 data", async () => {
		const v = new Int16Array(w * h);
		for (let i = 0; i < v.length; i++) v[i] = ((i * 37) % 200) - 100;
		const { hdr, fetcher } = await open({
			values: v,
			kind: "i16",
			predictor: 2,
			compression: 8,
		});
		const out = await readWindow(hdr, 0, 0, 0, w, h, fetcher);
		for (let i = 0; i < v.length; i++) expect(out[i]).toBe(v[i]);
	});

	it("undoes the floating-point predictor", async () => {
		const v = new Float32Array(w * h);
		for (let i = 0; i < v.length; i++) v[i] = 1000.25 + Math.sin(i / 9) * 40;
		const { hdr, fetcher } = await open({
			values: v,
			predictor: 3,
			compression: 8,
		});
		const out = await readWindow(hdr, 0, 0, 0, w, h, fetcher);
		for (let i = 0; i < v.length; i++) expect(out[i]).toBeCloseTo(v[i], 3);
	});

	it("decodes uint16 samples", async () => {
		const v = new Uint16Array(w * h);
		for (let i = 0; i < v.length; i++) v[i] = 40000 + (i % 1000);
		const { hdr, fetcher } = await open({ values: v, kind: "u16" });
		const out = await readWindow(hdr, 0, 0, 0, 4, 1, fetcher);
		expect(Array.from(out)).toEqual([40000, 40001, 40002, 40003]);
	});

	it("rejects an unsupported compression", async () => {
		const { hdr, fetcher } = await open();
		hdr.levels[0].compression = 7;
		await expect(readWindow(hdr, 0, 0, 0, 4, 4, fetcher)).rejects.toThrow(
			/unsupported/,
		);
	});
});

describe("stacTiles", () => {
	const item = (year: number, kx: number, ky: number, gsds: number[]) => ({
		id: `swisssurface3d-raster_${year}_${kx}-${ky}`,
		assets: Object.fromEntries(
			gsds.map((g) => [
				`a${g}`,
				{
					href: `https://x/${year}_${kx}-${ky}_${g}_2056_5728.tif`,
					"eo:gsd": g,
				},
			]),
		),
	});

	it("keeps the newest year per tile and the asset gsd closest to the request", async () => {
		const json: JsonFetcher = async () => ({
			features: [
				item(2018, 2600, 1200, [0.5, 2]),
				item(2021, 2600, 1200, [0.5, 2]),
				item(2019, 2601, 1200, [0.5]),
				{ id: "weird-id", assets: {} },
				{
					id: "swisssurface3d-raster_2020_2602-1200",
					assets: { a: { href: "x.xyz" } },
				},
			],
		});
		const stats = newStats();
		const t = await stacTiles(DSM_COLLECTION, [7, 46, 8, 47], 2, {
			json,
			stats,
		});
		const byKey = new Map(t.map((x) => [`${x.kx}-${x.ky}`, x]));
		expect(byKey.size).toBe(2);
		expect(byKey.get("2600-1200")).toMatchObject({ year: 2021, gsd: 2 });
		expect(byKey.get("2601-1200")).toMatchObject({ year: 2019, gsd: 0.5 });
		expect(stats.stacRequests).toBe(1);
		expect(stats.stacBytes).toBeGreaterThan(0);
	});

	it("derives the gsd from the filename when the asset has none and follows next links", async () => {
		const urls: string[] = [];
		const json: JsonFetcher = async (u) => {
			urls.push(u);
			return urls.length === 1
				? {
						features: [
							{
								id: "swissalti3d_2019_2600-1200",
								assets: {
									a: {
										href: "https://x/swissalti3d_2019_2600-1200_2_2056_5728.tif",
									},
								},
							},
						],
						links: [{ rel: "next", href: "https://next/page2" }],
					}
				: {
						features: [
							{
								id: "swissalti3d_2019_2601-1200",
								assets: {
									a: {
										href: "https://x/swissalti3d_2019_2601-1200_0.5_2056_5728.tif",
									},
								},
							},
						],
					};
		};
		const t = await stacTiles("c", [7.12345678, 46, 8, 47], 2, { json });
		expect(urls[0]).toBe(
			`${STAC_ROOT}/collections/c/items?bbox=7.123457,46.000000,8.000000,47.000000&limit=100`,
		);
		expect(urls[1]).toBe("https://next/page2");
		expect(t.map((x) => x.gsd).sort()).toEqual([0.5, 2]);
	});
});

describe("default HTTP transports", () => {
	it("httpRangeFetcher sends Range and slices a 200 full-body response", async () => {
		const body = Uint8Array.from({ length: 20 }, (_, i) => i);
		const f = vi.fn(async (_u: string, init?: RequestInit) => {
			expect((init?.headers as Record<string, string>).Range).toBe("bytes=5-9");
			return new Response(body, { status: 200 });
		});
		vi.stubGlobal("fetch", f);
		expect(Array.from(await httpRangeFetcher("u", 5, 9))).toEqual([
			5, 6, 7, 8, 9,
		]);
	});

	it("httpRangeFetcher returns a 206 body as is and throws on errors", async () => {
		vi.stubGlobal(
			"fetch",
			async () => new Response(new Uint8Array([1, 2]), { status: 206 }),
		);
		expect(Array.from(await httpRangeFetcher("u", 5, 6))).toEqual([1, 2]);
		vi.stubGlobal("fetch", async () => new Response("no", { status: 403 }));
		await expect(httpRangeFetcher("u", 0, 1)).rejects.toThrow(/403/);
	});

	it("httpJsonFetcher parses JSON and throws on non-OK", async () => {
		vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ a: 1 })));
		expect(await httpJsonFetcher("u")).toEqual({ a: 1 });
		vi.stubGlobal("fetch", async () => new Response("x", { status: 500 }));
		await expect(httpJsonFetcher("u")).rejects.toThrow(/500/);
	});
});
