// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { seededRandom } from "#/test/helpers";
import type { DemRaster } from "../../../dem";
import {
	decodeImagerySeed,
	decodePhotoSeeds,
	decodeTerrainSeed,
	encodeImagerySeed,
	encodePhotoSeeds,
	encodeTerrainSeed,
	fetchGzip,
	type PhotoSeed,
	photoSeedMatches,
} from "../roll-seed";

const key = (z: number, x: number, y: number) => ({ z, x, y });

function raster(
	size: number,
	fill: (x: number, y: number) => number,
): DemRaster {
	const heights = new Float32Array(size * size);
	for (let y = 0; y < size; y++)
		for (let x = 0; x < size; x++) heights[y * size + x] = fill(x, y);
	return {
		key: key(12, 2150, 1432),
		source: key(11, 1075, 716),
		size,
		heights,
	};
}

describe("terrain seed", () => {
	it("round-trips 1/128 m heights exactly through the planar predictor", async () => {
		const rnd = seededRandom(7);
		const a = raster(
			16,
			(x, y) => 1500 + x * 3.5 + y * -2 + Math.round(rnd() * 40) / 128,
		);
		const b = raster(8, (x, y) => -12.25 + (x ^ y));
		const m = new Map([
			["12/2150/1432", a],
			["12/2151/1432", { ...b, key: key(12, 2151, 1432) }],
		]);
		const out = await decodeTerrainSeed(encodeTerrainSeed(m));
		expect([...out.keys()]).toEqual([...m.keys()]);
		for (const [id, r] of m) {
			const d = out.get(id) as DemRaster;
			expect(d.size).toBe(r.size);
			expect(d.key).toEqual(r.key);
			expect(d.source).toEqual(r.source);
			expect(Array.from(d.heights)).toEqual(Array.from(r.heights));
		}
	});

	it("compresses smooth terrain below raw float32", () => {
		const r = raster(64, (x, y) => 1000 + x + y);
		const bytes = encodeTerrainSeed(new Map([["t", r]]));
		expect(bytes.length).toBeLessThan(64 * 64 * 4 * 0.4);
	});

	it("falls back to raw float32 for heights off the 1/128 grid, bit-exact", async () => {
		const r = raster(4, (x, y) => 100.1 + x * 0.3 + y * 0.01);
		r.heights[5] = Number.NaN;
		const out = await decodeTerrainSeed(encodeTerrainSeed(new Map([["t", r]])));
		const d = (out.get("t") as DemRaster).heights;
		expect(Number.isNaN(d[5])).toBe(true);
		d[5] = r.heights[5] = 0;
		expect(Array.from(d)).toEqual(Array.from(r.heights));
	});

	it("handles an empty set and rejects a foreign file", async () => {
		expect((await decodeTerrainSeed(encodeTerrainSeed(new Map()))).size).toBe(
			0,
		);
		await expect(
			decodeTerrainSeed(new Uint8Array([1, 2, 3, 4, 0, 0, 0, 0])),
		).rejects.toThrow(/bad magic/);
	});

	it("rejects an imagery file read as terrain", async () => {
		await expect(
			decodeTerrainSeed(encodeImagerySeed("swissimage" as never, new Map())),
		).rejects.toThrow(/bad magic \(want RMT1\)/);
	});
});

describe("imagery seed", () => {
	it("round-trips the source and every tile's bytes as typed blobs", async () => {
		const tiles = new Map([
			["12/1/1", new Uint8Array([1, 2, 3, 4, 5])],
			["12/1/2", new Uint8Array([])],
			["12/2/1", Uint8Array.from({ length: 300 }, (_, i) => i & 255)],
		]);
		const seed = decodeImagerySeed(
			encodeImagerySeed("swissimage" as never, tiles),
			"image/webp",
		);
		expect(seed.source).toBe("swissimage");
		expect([...seed.tiles.keys()]).toEqual([...tiles.keys()]);
		for (const [id, bytes] of tiles) {
			const blob = seed.tiles.get(id) as Blob;
			expect(blob.type).toBe("image/webp");
			expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes);
		}
	});
	it("rejects a terrain file", () => {
		expect(() =>
			decodeImagerySeed(encodeTerrainSeed(new Map()), "image/webp"),
		).toThrow(/bad magic/);
	});
});

describe("photo seeds", () => {
	const seed = (n: number): PhotoSeed => ({
		pose: { yaw: 123.456789012345 + n, pitch: -3.5, roll: 0.25, vfov: 55.5 },
		eye: [10.5, -20.25, 1500.125 + n],
		coarse: {
			width: 3,
			height: 2,
			data: new Float32Array([1, 2.5, 3, NaN, 5, 6e5].map((v) => v + n)),
		},
		clear: new Float32Array(16).map((_, i) => i / 7),
	});
	it("round-trips pose, eye, coarse range and clear texels bit-for-bit", () => {
		const m = new Map([
			["a", seed(0)],
			["b", seed(1)],
		]);
		const out = decodePhotoSeeds(encodePhotoSeeds(m));
		expect([...out.keys()]).toEqual(["a", "b"]);
		for (const [id, s] of m) {
			const d = out.get(id) as PhotoSeed;
			expect(d.pose).toEqual(s.pose);
			expect(d.eye).toEqual(s.eye);
			expect(d.coarse.width).toBe(3);
			expect(d.coarse.height).toBe(2);
			expect(Array.from(d.coarse.data)).toEqual(Array.from(s.coarse.data));
			expect(Array.from(d.clear)).toEqual(Array.from(s.clear));
		}
	});
	it("rejects other magics", () => {
		expect(() => decodePhotoSeeds(encodeTerrainSeed(new Map()))).toThrow(
			/bad magic/,
		);
	});
	it("photoSeedMatches only for the same pose and eye", () => {
		const s = seed(0);
		expect(photoSeedMatches(s, { ...s.pose }, [...s.eye])).toBe(true);
		expect(
			photoSeedMatches(s, { ...s.pose, yaw: s.pose.yaw + 1e-6 }, s.eye),
		).toBe(false);
		expect(
			photoSeedMatches(s, { ...s.pose, yaw: s.pose.yaw + 1e-11 }, s.eye),
		).toBe(true);
		expect(
			photoSeedMatches(s, s.pose, [s.eye[0], s.eye[1], s.eye[2] + 0.01]),
		).toBe(false);
	});
});

describe("fetchGzip", () => {
	afterEach(() => vi.unstubAllGlobals());
	it("gunzips the response body", async () => {
		const payload = Uint8Array.from({ length: 500 }, (_, i) => (i * 7) & 255);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(gzipSync(payload))),
		);
		expect(await fetchGzip("/seed.bin.gz")).toEqual(payload);
	});
	it("throws with the url and status on HTTP failure", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("nope", { status: 404 })),
		);
		await expect(fetchGzip("/missing.gz")).rejects.toThrow(
			"/missing.gz: HTTP 404",
		);
	});
});
