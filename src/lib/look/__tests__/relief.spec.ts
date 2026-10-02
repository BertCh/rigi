// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { lonLatToTile } from "#/lib/dem/tiles";
import { EnuFrame } from "#/lib/geodesy";
import { CLASSIC } from "#/lib/style/defaults";
import { mergeStyle } from "#/lib/style/schema";
import type { Vec3 } from "../atmosphere";
import {
	buildReliefField,
	ReliefController,
	reliefValues,
} from "../relief/field";
import { type HeightTile, rasterizeHeights } from "../relief/heights";

const LAT = 46.7;
const LON = 7.8;
const frame = new EnuFrame(LAT, LON, 600);
const SIZE = 64;
const tileAt = (z: number) => {
	const t = lonLatToTile(LON, LAT, z);
	return { x: Math.floor(t.x), y: Math.floor(t.y) };
};

/** One z8 tile (about 100 x 70 km) around the origin, heights from `f(col, row)`. */
function tileWith(f: (col: number, row: number) => number): HeightTile {
	const t = tileAt(8);
	const heights = new Float32Array(SIZE * SIZE);
	for (let r = 0; r < SIZE; r++)
		for (let c = 0; c < SIZE; c++) heights[r * SIZE + c] = f(c, r);
	return { key: { z: 8, x: t.x, y: t.y }, size: SIZE, heights };
}

describe("rasterizeHeights", () => {
	const extent: [number, number, number, number] = [-1000, -1000, 1000, 1000];
	it("reproduces a constant surface and fills holes outside every tile", () => {
		const out = rasterizeHeights([tileWith(() => 1234)], frame, extent, 8);
		expect(out.length).toBe(64);
		for (const v of out) expect(v).toBeCloseTo(1234, 3);
		const far: [number, number, number, number] = [
			500000, 500000, 502000, 502000,
		];
		const none = rasterizeHeights([tileWith(() => 1)], frame, far, 4, -7);
		for (const v of none) expect(v).toBe(-7);
	});
	it("defaults the hole to NaN and keeps an empty tile list all-hole", () => {
		const out = rasterizeHeights([], frame, extent, 4);
		for (const v of out) expect(v).toBeNaN();
	});
	it("follows an east-rising ramp: east texels higher than west, same along a row's north-south", () => {
		const out = rasterizeHeights(
			[tileWith((c) => c * 100)],
			frame,
			[-20000, -20000, 20000, 20000],
			16,
		);
		for (let j = 0; j < 16; j++) {
			expect(out[j * 16 + 15]).toBeGreaterThan(out[j * 16]);
		}
		// no north-south dependence at the same easting (within the mercator skew)
		expect(Math.abs(out[15 * 16 + 8] - out[8])).toBeLessThan(60);
	});
	it("lets a finer tile overwrite a coarser one", () => {
		const coarse = tileWith(() => 100);
		const t = tileAt(12);
		const fine: HeightTile = {
			key: { z: 12, x: t.x, y: t.y },
			size: 8,
			heights: new Float32Array(64).fill(900),
		};
		const out = rasterizeHeights(
			[fine, coarse],
			frame,
			[-500, -500, 500, 500],
			4,
		);
		const values = new Set(Array.from(out, (v) => Math.round(v)));
		expect(values.has(900)).toBe(true);
	});
});

describe("buildReliefField", () => {
	const flat = [tileWith(() => 500)];
	const sunHigh: Vec3 = [0.3, 0.3, 0.9];
	const field = buildReliefField(flat, frame, sunHigh, null);
	const mid = (512 * 1024 + 512) * 4;

	it("returns res 1024 RGBA field and gen textures centred on the camera for null yaw", () => {
		expect(field.res).toBe(1024);
		expect(field.field.length).toBe(1024 * 1024 * 4);
		expect(field.gen.length).toBe(1024 * 1024 * 4);
		expect(field.extent).toEqual([-20000, -20000, 20000, 20000]);
	});
	it("flat lit ground: full sun, full sky, planar curvature, covered, generalised normal pointing up", () => {
		expect(field.field[mid]).toBe(255);
		expect(field.field[mid + 1]).toBe(255);
		expect(Math.abs(field.field[mid + 2] - 128)).toBeLessThanOrEqual(1);
		expect(field.field[mid + 3]).toBe(255);
		expect(Math.abs(field.gen[mid] - 128)).toBeLessThanOrEqual(1);
		expect(Math.abs(field.gen[mid + 1] - 128)).toBeLessThanOrEqual(1);
		expect(field.gen[mid + 3]).toBe(255);
	});
	it("shifts the extent ahead of the camera along a yaw", () => {
		const f = buildReliefField(flat, frame, sunHigh, 90);
		expect(f.extent[0]).toBeCloseTo(12000 - 20000, 6);
		expect(f.extent[1]).toBeCloseTo(-20000, 6);
	});
	it("has no shadow when the sun is below the horizon", () => {
		const night = buildReliefField(flat, frame, [0.2, 0.2, -0.5], null);
		expect(night.field[mid]).toBe(0);
	});
	it("a low sun casts the shadow of a ridge to its lee but not on its sunward side", () => {
		// a north-south ridge 1500 m high at column 32 over a 500 m plain; sun low in the east
		const ridge = [tileWith((c) => (Math.abs(c - 32) <= 1 ? 2500 : 500))];
		const f = buildReliefField(ridge, frame, [0.97, 0, 0.17], null);
		const row = 512 * 1024;
		let shadowed = 0;
		let lit = 0;
		for (let i = 0; i < 1024; i++) {
			const r = f.field[(row + i) * 4];
			if (r < 30) shadowed++;
			if (r > 225) lit++;
		}
		expect(shadowed).toBeGreaterThan(20);
		expect(lit).toBeGreaterThan(20);
	});
	it("marks holes as uncovered", () => {
		const empty = buildReliefField([], frame, sunHigh, null);
		expect(empty.field[mid + 3]).toBe(0);
		expect(empty.gen[mid + 3]).toBe(0);
	});
});

describe("ReliefController", () => {
	it("builds once for a key, skips an unchanged key, and ignores an empty tile list", () => {
		const c = new ReliefController();
		const tiles = [tileWith(() => 500)];
		const sun: Vec3 = [0.3, 0.3, 0.9];
		expect(
			c.update({ tiles: [], frame, sunDir: sun, yawDeg: null }),
		).toBeNull();
		const f = c.update({ tiles, frame, sunDir: sun, yawDeg: 14 });
		expect(f).not.toBeNull();
		expect(c.current).toBe(f);
		// yaw snaps to 30 degrees: 14 and 20 are the same key
		expect(c.update({ tiles, frame, sunDir: sun, yawDeg: 10 })).toBeNull();
		// a different sun rebuilds
		expect(
			c.update({ tiles, frame, sunDir: [0.5, 0.1, 0.8], yawDeg: 20 }),
		).not.toBeNull();
	});
	it("bytes() returns the CPU field", async () => {
		const c = new ReliefController();
		expect(await c.bytes()).toBeNull();
		c.update({
			tiles: [tileWith(() => 1)],
			frame,
			sunDir: [0, 0, 1],
			yawDeg: null,
		});
		expect((await c.bytes())?.res).toBe(1024);
	});
});

describe("reliefValues", () => {
	const sun: Vec3 = [0.3, 0.3, 0.9];
	it("is null for lambert", () => {
		expect(reliefValues(CLASSIC, false, sun)).toBeNull();
	});
	it("swiss keeps the Imhof terms at 0 and widens the edge for the world view", () => {
		const s = mergeStyle(CLASSIC, {
			terrain: {
				relief: {
					mode: "swiss",
					realism: 0.4,
					generalize: 0.5,
					curvature: 0.2,
				},
			},
		});
		const v = reliefValues(s, true, sun);
		expect(v?.imhof).toBe(0);
		expect(v?.swing).toBe(0);
		expect(v?.edge).toBe(0.22);
		expect(reliefValues(s, false, sun)?.edge).toBe(0.08);
		expect(v?.extent).toEqual([0, 0, 1, 1]);
		expect(v?.realism).toBe(0.4);
	});
	it("imhof passes swing, tint and aerial and the given extent", () => {
		const s = mergeStyle(CLASSIC, {
			terrain: {
				relief: {
					mode: "imhof",
					realism: 0.1,
					generalize: 0.6,
					curvature: 0.3,
					swing: 0.7,
					tint: 0.5,
					aerial: 0.9,
				},
			},
		});
		const v = reliefValues(s, false, sun, [1, 2, 3, 4]);
		expect(v?.imhof).toBe(1);
		expect([v?.swing, v?.tint, v?.aerial]).toEqual([0.7, 0.5, 0.9]);
		expect(v?.extent).toEqual([1, 2, 3, 4]);
	});
});
