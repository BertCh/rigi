// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { latToTileY, lonToTileX } from "#/lib/dem/tiles";
import { EnuFrame } from "#/lib/geodesy";
import type { HeightTile } from "#/lib/look/relief/heights";
import { planHeights } from "../relief-heights";

const LAT = 46.7;
const LON = 7.8;
const frame = new EnuFrame(LAT, LON, 1500);

const tileAt = (z: number, dx = 0, dy = 0, size = 256): HeightTile =>
	({
		key: {
			z,
			x: Math.floor(lonToTileX(LON, z)) + dx,
			y: Math.floor(latToTileY(LAT, z)) + dy,
		},
		size,
		heights: new Float32Array(0),
	}) as unknown as HeightTile;

const view = (rows: ArrayBuffer, r: number) => {
	const dv = new DataView(rows, r * 48);
	return {
		k: dv.getFloat32(8, true),
		size: dv.getUint32(12, true),
		stride: dv.getUint32(16, true),
		wordOffset: dv.getUint32(20, true),
		box: [24, 28, 32, 36].map((o) => dv.getInt32(o, true)),
	};
};

const small = () => ({ layer: 3, big: false });

describe("planHeights (relief height raster plan)", () => {
	it("centres the extent on the frame without a yaw, ahead of it with one", () => {
		const a = planHeights([tileAt(12)], frame, null, small);
		expect(a?.extent).toEqual([-20000, -20000, 20000, 20000]);
		const b = planHeights([tileAt(12)], frame, 90, small);
		expect(b?.extent[0]).toBeCloseTo(12000 - 20000, 6);
		expect(b?.extent[1]).toBeCloseTo(-20000, 6);
		expect(a?.px).toBeCloseTo(40000 / 1024, 12);
		expect(a?.hole).toBe(-1e6);
	});
	it("builds 33x33 relative mercator nodes starting at 0", () => {
		const p = planHeights([tileAt(12)], frame, null, small);
		expect(p?.nodes.length).toBe(33 * 33 * 2);
		expect(p?.nodes[0]).toBe(0);
		expect(p?.nodes[1]).toBe(0);
		// x grows east, y (tile row) grows south: node (1,0) east of the origin, (0,1) south of it
		expect(p?.nodes[2] ?? 0).toBeGreaterThan(0);
		expect(p?.nodes[2 * 33 + 1] ?? 0).toBeLessThan(0); // north is up: ny shrinks northward
	});
	it("orders rows finest first and records per-tile scale", () => {
		const coarse = tileAt(10);
		const fine = tileAt(12);
		const p = planHeights([fine, coarse], frame, null, small);
		expect(p?.nRows).toBe(2);
		const rows = p?.rows as ArrayBuffer;
		expect(view(rows, 0).k).toBe(2 ** 12 * 256);
		expect(view(rows, 1).k).toBe(2 ** 10 * 256);
		expect(view(rows, 0).size).toBe(256);
	});
	it("lays copies out in gather units, a big layer taking four", () => {
		const p = planHeights(
			[tileAt(12), tileAt(10, 0, 0, 512)],
			frame,
			null,
			(t) =>
				t.size === 512 ? { layer: 1, big: true } : { layer: 2, big: false },
		);
		expect(p?.copies).toEqual([
			{ big: false, layer: 2, byteOffset: 0 },
			{ big: true, layer: 1, byteOffset: 256 * 256 * 4 },
		]);
		expect(p?.units).toBe(1 + 4);
		const rows = p?.rows as ArrayBuffer;
		expect(view(rows, 1).stride).toBe(512);
		expect(view(rows, 1).wordOffset).toBe(256 * 256);
	});
	it("returns null when a tile is not resident or too large for its slot", () => {
		expect(planHeights([tileAt(12)], frame, null, () => null)).toBeNull();
		expect(planHeights([tileAt(12, 0, 0, 512)], frame, null, small)).toBeNull();
	});
	it("skips tiles outside the extent and keeps a one-row buffer", () => {
		const p = planHeights([tileAt(12, 40, 0)], frame, null, small);
		expect(p?.nRows).toBe(0);
		expect(p?.copies).toEqual([]);
		expect(p?.rows.byteLength).toBe(48);
	});
	it("clamps each tile's texel box to the raster", () => {
		const p = planHeights([tileAt(8)], frame, null, small);
		const [i0, i1, j0, j1] = view(p?.rows as ArrayBuffer, 0).box;
		expect(i0).toBe(0);
		expect(j0).toBe(0);
		expect(i1).toBe(1023);
		expect(j1).toBe(1023);
	});
});
