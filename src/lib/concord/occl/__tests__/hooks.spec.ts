// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import {
	drapeMaskFromOccluder,
	type OccluderGrid,
	occludedLabels,
} from "../hooks";

const INF = Number.POSITIVE_INFINITY;

/** w×h grid, occluder range from `occ(i, j)`, terrain 1000 m everywhere. */
const grid = (
	w: number,
	h: number,
	occ: (i: number, j: number) => number,
): OccluderGrid => {
	const range = new Float32Array(w * h);
	for (let j = 0; j < h; j++)
		for (let i = 0; i < w; i++) range[j * w + i] = occ(i, j);
	return {
		width: w,
		height: h,
		range,
		terrain: new Float32Array(w * h).fill(1000),
	};
};
const geom = (g: OccluderGrid, sky?: (n: number) => boolean) => ({
	w: g.width,
	h: g.height,
	range: g.terrain,
	sky: Uint8Array.from({ length: g.width * g.height }, (_, n) =>
		sky?.(n) ? 1 : 0,
	),
});
const label = (id: string, u: number, v: number, rangeM: number) => ({
	id,
	u,
	v,
	rangeM,
});

describe("occludedLabels", () => {
	const g = grid(10, 10, (i) => (i < 5 ? 100 : INF)); // object in front on the left half

	it("hides a label behind the object and keeps a visible one", () => {
		const ids = occludedLabels(
			[label("a", 0.2, 0.5, 1000), label("b", 0.8, 0.5, 1000)],
			g,
		);
		expect([...ids]).toEqual(["a"]);
	});

	it("uses the shared rule r > o*1.05 + 3: a target just behind the occluder stays", () => {
		const near = grid(10, 10, () => 100);
		expect(occludedLabels([label("a", 0.5, 0.5, 108)], near).size).toBe(0);
		expect(occludedLabels([label("a", 0.5, 0.5, 109)], near).size).toBe(1);
	});

	it("needs k of the 9 cells (default 6)", () => {
		// column i = 4 is the last occluded one: a label at i=4 sees 3 occluded columns of 3 at i=3..5? no: i=3,4 = 6 cells
		expect(occludedLabels([label("e", 0.45, 0.5, 1000)], g).size).toBe(1); // cells i=3,4 occlude (6)
		expect(occludedLabels([label("e", 0.55, 0.5, 1000)], g).size).toBe(0); // only i=4 occludes (3)
		expect(
			occludedLabels([label("e", 0.55, 0.5, 1000)], g, { k: 3 }).size,
		).toBe(1);
	});

	it("never counts sky or no-data cells, nor cells outside the grid", () => {
		const sky = grid(10, 10, () => INF);
		expect(occludedLabels([label("a", 0.5, 0.5, 5000)], sky).size).toBe(0);
		const nan = grid(10, 10, () => Number.NaN);
		expect(occludedLabels([label("a", 0.5, 0.5, 5000)], nan).size).toBe(0);
		// corner: only 4 in-grid cells, so k = 6 is unreachable even when all occlude
		const all = grid(10, 10, () => 50);
		expect(occludedLabels([label("c", 0.01, 0.01, 5000)], all).size).toBe(0);
		expect(
			occludedLabels(
				[label("o", 1.5, 0.5, 5000), label("n", Number.NaN, 0.5, 5000)],
				all,
			).size,
		).toBe(0);
	});

	it("ignores labels without a positive range", () => {
		expect(occludedLabels([label("a", 0.2, 0.5, 0)], g).size).toBe(0);
	});
});

describe("drapeMaskFromOccluder", () => {
	const g = grid(8, 8, (i, j) => (i === 3 && j === 3 ? 100 : INF));

	it("marks only cells whose occluder is in front of the terrain", () => {
		const m = drapeMaskFromOccluder(g, geom(g), { dilate: false });
		expect(m.width).toBe(8);
		expect(m.height).toBe(8);
		expect([...m.data].filter(Boolean).length).toBe(1);
		expect(m.data[3 * 8 + 3]).toBe(255);
	});

	it("dilates by one cell (4-neighbourhood) by default", () => {
		const m = drapeMaskFromOccluder(g, geom(g));
		expect([...m.data].filter(Boolean).length).toBe(5);
		expect(m.data[3 * 8 + 4]).toBe(255);
		expect(m.data[4 * 8 + 4]).toBe(0);
	});

	it("never marks sky pixels, and clips the dilation at the border", () => {
		const e = grid(4, 4, (i, j) => (i === 0 && j === 0 ? 100 : INF));
		expect(
			drapeMaskFromOccluder(
				e,
				geom(e, () => true),
			).data.some(Boolean),
		).toBe(false);
		expect(
			[...drapeMaskFromOccluder(e, geom(e)).data].filter(Boolean).length,
		).toBe(3);
	});

	it("leaves an object that is not in front of the terrain unmarked", () => {
		const e = grid(4, 4, () => 999); // 999*1.05+3 > 1000
		expect(drapeMaskFromOccluder(e, geom(e)).data.some(Boolean)).toBe(false);
	});
});
