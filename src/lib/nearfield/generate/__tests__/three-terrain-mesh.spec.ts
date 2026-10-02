// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { tileBounds } from "#/lib/dem/tiles";
import { EnuFrame } from "#/lib/geodesy";
import { seededRandom } from "#/test/helpers";
import {
	buildTile,
	downsample,
	edgeVertex,
	sampleGrid,
	tileArrays,
} from "../three-terrain-mesh";

describe("downsample", () => {
	it("returns the input when the target is not smaller", () => {
		const h = new Float32Array(16);
		expect(downsample(h, 4, 4)).toBe(h);
		expect(downsample(h, 4, 8)).toBe(h);
	});
	it("box-averages f x f blocks", () => {
		const h = Float32Array.from([
			1, 3, 0, 4, 5, 7, 8, 8, 1, 1, 2, 2, 1, 1, 2, 2,
		]);
		expect(Array.from(downsample(h, 4, 2))).toEqual([4, 5, 1, 2]);
	});
	it("preserves the mean", () => {
		const r = seededRandom(1);
		const h = Float32Array.from({ length: 256 }, () => r() * 100);
		const d = downsample(h, 16, 4);
		const mean = (a: Float32Array) => a.reduce((s, v) => s + v, 0) / a.length;
		expect(mean(d)).toBeCloseTo(mean(h), 3);
	});
});

describe("sampleGrid (uv variant)", () => {
	const S = 4;
	const h = Float32Array.from(
		{ length: 16 },
		(_, i) => (i % 4) * 10 + ((i / 4) | 0),
	);
	it("hits sample values at pixel centres", () => {
		expect(sampleGrid(h, S, 0.5 / S, 0.5 / S)).toBe(0);
		expect(sampleGrid(h, S, 2.5 / S, 1.5 / S)).toBeCloseTo(21, 5);
	});
	it("clamps outside [0,1]", () => {
		expect(sampleGrid(h, S, -1, -1)).toBe(h[0]);
		expect(sampleGrid(h, S, 2, 2)).toBe(h[15]);
	});
	it("interpolates linearly between centres", () => {
		expect(sampleGrid(h, S, 1 / S, 0.5 / S)).toBeCloseTo(5, 5);
	});
	it("is the former inline copy bit for bit (now dem/grid.ts sampleGrid at px = fu·S)", () => {
		const old = (g: Float32Array, n: number, fu: number, fv: number) => {
			const m = n - 1;
			const x = Math.min(Math.max(fu * n - 0.5, 0), m);
			const y = Math.min(Math.max(fv * n - 0.5, 0), m);
			const x0 = Math.floor(x);
			const y0 = Math.floor(y);
			const x1 = Math.min(x0 + 1, m);
			const y1 = Math.min(y0 + 1, m);
			const fx = x - x0;
			const fy = y - y0;
			const a = g[y0 * n + x0] * (1 - fx) + g[y0 * n + x1] * fx;
			const b = g[y1 * n + x0] * (1 - fx) + g[y1 * n + x1] * fx;
			return a * (1 - fy) + b * fy;
		};
		const r = seededRandom(3);
		const n = 17;
		const g = Float32Array.from({ length: n * n }, () => 500 + r() * 900);
		for (let i = 0; i < 300; i++) {
			const fu = r() * 1.2 - 0.1;
			const fv = r() * 1.2 - 0.1;
			expect(sampleGrid(g, n, fu, fv)).toBe(old(g, n, fu, fv));
		}
	});
});

describe("edgeVertex", () => {
	it("indexes the four edges of an n x n grid", () => {
		const n = 5;
		expect([0, 1, 2, 3, 4].map((t) => edgeVertex(0, t, n))).toEqual([
			0, 1, 2, 3, 4,
		]); // north row
		expect([0, 4].map((t) => edgeVertex(1, t, n))).toEqual([20, 24]); // south row
		expect([0, 4].map((t) => edgeVertex(2, t, n))).toEqual([0, 20]); // west column
		expect([0, 4].map((t) => edgeVertex(3, t, n))).toEqual([4, 24]); // east column
	});
	it("corners are shared between edges", () => {
		const n = 4;
		expect(edgeVertex(0, 0, n)).toBe(edgeVertex(2, 0, n));
		expect(edgeVertex(0, n - 1, n)).toBe(edgeVertex(3, 0, n));
		expect(edgeVertex(1, 0, n)).toBe(edgeVertex(2, n - 1, n));
		expect(edgeVertex(1, n - 1, n)).toBe(edgeVertex(3, n - 1, n));
	});
});

const key = { z: 12, x: 2144, y: 1435 };
const b = tileBounds(key);
const frame = new EnuFrame((b.north + b.south) / 2, (b.east + b.west) / 2, 0);

describe("tileArrays", () => {
	const seg = 8;
	const size = 16;
	const flat = new Float32Array(size * size).fill(1500);
	const t = tileArrays(frame, key, flat, size, seg);
	const n = seg + 1;
	const vCount = n * n + 4 * n;

	it("allocates the grid plus four skirts", () => {
		expect(t.pos.length).toBe(vCount * 3);
		expect(t.uv.length).toBe(vCount * 2);
		expect(t.elev.length).toBe(vCount);
		expect(t.nor.length).toBe(vCount * 3);
	});
	it("uv spans [0,1] with v flipped", () => {
		expect(t.uv[0]).toBe(0);
		expect(t.uv[1]).toBe(1); // NW corner: u=0, v=1
		const last = (n * n - 1) * 2;
		expect(t.uv[last]).toBe(1);
		expect(t.uv[last + 1]).toBe(0);
	});
	it("elevations equal the (constant) sampled height", () => {
		for (let i = 0; i < n * n; i++) expect(t.elev[i]).toBeCloseTo(1500, 3);
	});
	it("tile centre sits at the origin of the camera frame when the camera is at its centre", () => {
		expect(t.center[0]).toBeCloseTo(0, 6);
		expect(t.center[1]).toBeCloseTo(0, 6);
		// pos is relative to center: the middle vertex is above it by ~height (minus curvature drop)
		const mid = (n >> 1) * n + (n >> 1);
		// the grid midpoint is the Mercator midpoint, within a few metres of the lat/lon one
		expect(Math.abs(t.pos[mid * 3])).toBeLessThan(5);
		expect(Math.abs(t.pos[mid * 3 + 1])).toBeLessThan(5);
		expect(t.pos[mid * 3 + 2]).toBeCloseTo(1500, 0);
	});
	it("normals are unit length and point mostly up on flat ground", () => {
		for (let i = 0; i < n * n; i++) {
			const x = t.nor[i * 3];
			const y = t.nor[i * 3 + 1];
			const z = t.nor[i * 3 + 2];
			expect(Math.hypot(x, y, z)).toBeCloseTo(1, 5);
			expect(z).toBeGreaterThan(0.99);
		}
	});
	it("x increases east and y north across the grid", () => {
		const east = t.pos[(n - 1) * 3] - t.pos[0];
		const south = t.pos[n * (n - 1) * 3 + 1] - t.pos[1];
		expect(east).toBeGreaterThan(1000);
		expect(south).toBeLessThan(-1000); // row j grows southward
	});
	it("skirts copy their edge vertex and drop by at least 30 m", () => {
		for (let e = 0; e < 4; e++)
			for (let k = 0; k < n; k++) {
				const src = edgeVertex(e, k, n);
				const v = n * n + e * n + k;
				expect(t.pos[v * 3]).toBe(t.pos[src * 3]);
				expect(t.pos[v * 3 + 1]).toBe(t.pos[src * 3 + 1]);
				expect(t.pos[src * 3 + 2] - t.pos[v * 3 + 2]).toBeGreaterThanOrEqual(
					30,
				);
				expect(t.elev[src] - t.elev[v]).toBeGreaterThanOrEqual(30);
				expect(t.nor[v * 3 + 2]).toBe(t.nor[src * 3 + 2]);
			}
	});
	it("a west-to-east ramp tilts normals westward-up consistently", () => {
		const ramp = new Float32Array(size * size);
		for (let y = 0; y < size; y++)
			for (let x = 0; x < size; x++) ramp[y * size + x] = 100 * x;
		const r = tileArrays(frame, key, ramp, size, seg);
		const mid = (n >> 1) * n + (n >> 1);
		// height rises to the east, so the surface normal leans west (negative x)
		expect(r.nor[mid * 3]).toBeLessThan(-0.1);
		expect(Math.abs(r.nor[mid * 3 + 1])).toBeLessThan(0.05);
	});
});

describe("buildTile", () => {
	const mkJob = (extra = {}) => ({
		buf: new ArrayBuffer(1),
		source: key,
		key,
		seg: 4,
		keepDiv: 2,
		origin: { lat: frame.lat, lon: frame.lon, h: 0 },
		...extra,
	});
	it("is null when decoding fails", async () => {
		expect(
			await buildTile(mkJob(), async () => Promise.reject(new Error("x"))),
		).toBeNull();
	});
	it("meshes the decoded heights and keeps size/keepDiv of them", async () => {
		const size = 16;
		const res = await buildTile(mkJob(), async () =>
			new Float32Array(size * size).fill(800),
		);
		expect(res?.size).toBe(8);
		expect(res?.heights.length).toBe(64);
		expect(res?.heights[0]).toBeCloseTo(800, 3);
		expect(res?.pos.length).toBe((25 + 20) * 3);
	});
	it("fills no-data pits before meshing", async () => {
		const size = 8;
		const h = new Float32Array(size * size).fill(1000);
		h[27] = -32768;
		const res = await buildTile(mkJob({ keepDiv: 1 }), async () => h);
		expect(res?.heights[27]).toBeCloseTo(1000, 3);
	});
});
