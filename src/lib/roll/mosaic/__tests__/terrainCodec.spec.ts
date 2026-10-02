// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { seededRandom, uniform } from "#/test/helpers";
import type { ViewpointTerrain } from "../ridgelines";
import { decodeTerrain, encodeTerrain, terrainKey } from "../terrainCodec";

function makeTerrain(strokes: number, seed = 5): ViewpointTerrain {
	const r = seededRandom(seed);
	const start = new Uint32Array(strokes + 1);
	for (let i = 0; i < strokes; i++) start[i + 1] = start[i] + 2 + (i % 3);
	const n = start[strokes];
	return {
		eye: { lat: 46.71, lon: 7.77, h: 1960.5 },
		slabs: 12,
		dMin: 200,
		dMax: 80_000,
		pts: Float32Array.from({ length: 2 * n }, () => uniform(r, -180, 360)),
		start,
		slab: Uint8Array.from({ length: strokes }, (_, i) => i % 12),
		ridge: Uint8Array.from({ length: strokes }, (_, i) => i & 1),
		cuePts: Float32Array.from({ length: 6 }, () => uniform(r, 0, 1)),
		cueStart: Uint32Array.from([0, 3]),
		cueSlab: Uint8Array.from([4]),
		skyline: Float32Array.from({ length: 721 }, () => uniform(r, -90, 40)),
		step: 0.5,
		peaks: [{ name: "Niederhorn", az: 12.5, el: 3.2, d: 1000 } as never],
	};
}

describe("terrain codec", () => {
	it.each([
		0, 1, 7, 100,
	])("round-trips a terrain with %i strokes", (strokes) => {
		const t = makeTerrain(strokes);
		const bytes = encodeTerrain(t);
		expect(bytes.byteLength % 4).toBe(0);
		const back = decodeTerrain(
			bytes.buffer.slice(
				bytes.byteOffset,
				bytes.byteOffset + bytes.byteLength,
			) as ArrayBuffer,
		);
		expect(back).toEqual(t);
		expect(back.pts).toBeInstanceOf(Float32Array);
		expect(back.start).toBeInstanceOf(Uint32Array);
		expect(back.slab).toBeInstanceOf(Uint8Array);
	});

	it("decoded arrays own aligned, independent buffers (transferable)", () => {
		const t = makeTerrain(5);
		const bytes = encodeTerrain(t);
		const buf = bytes.buffer.slice(0) as ArrayBuffer;
		const back = decodeTerrain(buf);
		for (const a of [back.pts, back.start, back.skyline])
			expect(a.buffer).not.toBe(buf);
		expect(back.pts.byteOffset).toBe(0);
	});

	it("handles Uint8 arrays whose length is not a multiple of 4 between wide arrays", () => {
		const t = makeTerrain(3); // slab/ridge are 3 bytes: forces padding before cuePts
		const bytes = encodeTerrain(t);
		const back = decodeTerrain(bytes.buffer.slice(0) as ArrayBuffer);
		expect([...back.slab]).toEqual([...t.slab]);
		expect([...back.cuePts]).toEqual([...t.cuePts]);
	});
});

describe("terrainKey", () => {
	it("rounds the eye to 5 decimals and the altitude to 0.1 m", () => {
		expect(terrainKey({ lat: 46.710712, lon: 7.77241, eyeAlt: 1923.46 })).toBe(
			"46.71071,7.77241,1923.5",
		);
	});
	it("uses 'dem' for an unknown altitude, distinguishing it from 0", () => {
		expect(terrainKey({ lat: 1, lon: 2, eyeAlt: null })).toBe(
			"1.00000,2.00000,dem",
		);
		expect(terrainKey({ lat: 1, lon: 2, eyeAlt: 0 })).toBe(
			"1.00000,2.00000,0.0",
		);
	});
	it("merges positions closer than ~1 m", () => {
		const a = terrainKey({ lat: 46.710001, lon: 7.7, eyeAlt: 10 });
		const b = terrainKey({ lat: 46.710004, lon: 7.7, eyeAlt: 10 });
		expect(a).toBe(b);
	});
});
