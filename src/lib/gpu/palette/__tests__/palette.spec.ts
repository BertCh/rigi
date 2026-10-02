// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { kMeansCpu } from "../kmeans-cpu";
import {
	LOOK_DIMS,
	LOOK_PALETTE_SLOTS,
	paletteFromEmbedding,
	photoLookEmbedding,
} from "../look-embedding";
import { deltaEOk, oklabToSrgb8, srgb8ToOklab } from "../oklab";
import { type PhotoPixels, photoPaletteCpu } from "../palette";

const blocks = (colors: [number, number, number][], size = 16): PhotoPixels => {
	const data = new Uint8ClampedArray(size * size * 4);
	for (let y = 0; y < size; y++)
		for (let x = 0; x < size; x++) {
			const c = colors[Math.floor((x * colors.length) / size)];
			data.set([c[0], c[1], c[2], 255], (y * size + x) * 4);
		}
	return { width: size, height: size, data };
};

describe("OKLab", () => {
	it("round-trips sRGB bytes", () => {
		for (const rgb of [
			[0, 0, 0],
			[255, 255, 255],
			[200, 30, 90],
			[12, 240, 130],
			[128, 128, 128],
		] as [number, number, number][]) {
			const lab = srgb8ToOklab(...rgb);
			expect(oklabToSrgb8(...lab)).toEqual([...rgb]);
		}
	});
	it("puts white at L = 1 and black at L = 0, grey on the neutral axis", () => {
		expect(srgb8ToOklab(255, 255, 255)[0]).toBeCloseTo(1, 4);
		expect(srgb8ToOklab(0, 0, 0)[0]).toBeCloseTo(0, 6);
		const grey = srgb8ToOklab(120, 120, 120);
		expect(Math.hypot(grey[1], grey[2])).toBeLessThan(1e-4);
	});
});

describe("kMeansCpu", () => {
	const rows = Float32Array.from([
		0, 0, 0.1, 0, 10, 10, 10.1, 10, 0, 0.1, 10, 10.1,
	]);
	it("seeds evenly spaced rows and is deterministic", () => {
		const a = kMeansCpu(rows, 6, 2, 2, 2, 10);
		const b = kMeansCpu(rows, 6, 2, 2, 2, 10);
		expect([...a.labels]).toEqual([...b.labels]);
		expect([...a.counts]).toEqual([3, 3]);
		expect(a.converged).toBe(true);
	});
	it("honours a row stride, ties to the lowest cluster, empty clusters keep their seed", () => {
		const strided = Float32Array.from([1, 1, 9, 1, 1, 9, 1, 1, 9]);
		const r = kMeansCpu(strided, 3, 2, 3, 2, 5);
		// identical rows: every row is equidistant (0) from both seeds -> cluster 0
		expect([...r.counts]).toEqual([3, 0]);
		expect([...r.centroids]).toEqual([1, 1, 1, 1]);
	});
});

describe("photoPaletteCpu", () => {
	it("recovers a synthetic 3-colour image with its shares", () => {
		const colors: [number, number, number][] = [
			[220, 30, 30],
			[30, 160, 60],
			[30, 60, 220],
		];
		// horizontal bands on an 18 px square: the evenly spaced seeds (rows 0, 108, 216) land one per band
		const size = 18;
		const data = new Uint8ClampedArray(size * size * 4);
		for (let i = 0; i < size * size; i++)
			data.set([...colors[Math.floor(i / 108)], 255], i * 4);
		const palette = photoPaletteCpu(
			{ width: size, height: size, data },
			{ k: 3 },
		);
		expect(palette.colors).toHaveLength(3);
		for (const c of colors) {
			const want = srgb8ToOklab(...c);
			const best = Math.min(
				...palette.colors.map((p) => deltaEOk(p.oklab, want)),
			);
			expect(best).toBeLessThan(0.01);
		}
		for (const c of palette.colors) expect(c.share).toBeCloseTo(1 / 3, 1);
	});
	it("sorts by share and drops empty clusters", () => {
		const pixels = blocks([[250, 250, 250]]);
		const palette = photoPaletteCpu(pixels, { k: 5 });
		expect(palette.colors).toHaveLength(1);
		expect(palette.colors[0].share).toBe(1);
		const wide = photoPaletteCpu(
			blocks([
				[0, 0, 0],
				[255, 255, 255],
				[255, 255, 255],
				[255, 255, 255],
			]),
			{ k: 2 },
		);
		expect(wide.colors[0].share).toBeGreaterThan(wide.colors[1].share);
		expect(wide.colors[0].rgb).toEqual([255, 255, 255]);
	});
});

describe("photoLookEmbedding", () => {
	const pixels = blocks([
		[200, 60, 40],
		[40, 80, 200],
		[20, 20, 20],
	]);
	const palette = photoPaletteCpu(pixels);
	it("has the fixed length and finite values", () => {
		const e = photoLookEmbedding(pixels, palette);
		expect(e).toHaveLength(LOOK_DIMS);
		expect(e.every(Number.isFinite)).toBe(true);
	});
	it("is invariant to a horizontal mirror (band means and spread)", () => {
		const e = photoLookEmbedding(pixels, palette);
		const size = pixels.width;
		const mirrored = new Uint8ClampedArray(pixels.data.length);
		for (let y = 0; y < size; y++)
			for (let x = 0; x < size; x++)
				mirrored.set(
					pixels.data.subarray(
						(y * size + (size - 1 - x)) * 4,
						(y * size + (size - x)) * 4,
					),
					(y * size + x) * 4,
				);
		const flat = { ...pixels, data: mirrored };
		const e2 = photoLookEmbedding(flat, photoPaletteCpu(flat));
		for (let i = 0; i < 12; i++) expect(e2[i]).toBeCloseTo(e[i], 4);
	});
	it("separates a bright sky from a dark sky in the top third", () => {
		const bright = photoLookEmbedding(
			blocks([[240, 240, 250]]),
			photoPaletteCpu(blocks([[240, 240, 250]])),
		);
		const dark = photoLookEmbedding(
			blocks([[20, 20, 30]]),
			photoPaletteCpu(blocks([[20, 20, 30]])),
		);
		expect(bright[0]).toBeGreaterThan(dark[0] + 0.5);
	});
	it("decodes its palette slots back to the colours", () => {
		const e = photoLookEmbedding(pixels, palette);
		const back = paletteFromEmbedding(e);
		expect(back.length).toBeLessThanOrEqual(LOOK_PALETTE_SLOTS);
		expect(back.length).toBe(palette.colors.length);
		for (const c of palette.colors) {
			const best = Math.min(...back.map((b) => deltaEOk(b.oklab, c.oklab)));
			expect(best).toBeLessThan(1e-4);
		}
	});
});

describe("palette recovery with farthest-point seeds", () => {
	const PALETTE: [number, number, number][] = [
		[240, 240, 230],
		[30, 120, 50],
		[200, 40, 40],
		[30, 60, 200],
		[250, 200, 20],
		[10, 10, 10],
	];
	for (const count of [3, 4, 5, 6]) {
		it(`recovers ${count} column blocks (the layout plain even seeding merged)`, () => {
			const colors = PALETTE.slice(0, count);
			const size = 32;
			const data = new Uint8ClampedArray(size * size * 4);
			for (let i = 0; i < size * size; i++) {
				const c = colors[Math.floor(((i % size) * count) / size)];
				data.set([...c, 255], i * 4);
			}
			const palette = photoPaletteCpu(
				{ width: size, height: size, data },
				{ k: count },
			);
			expect(palette.colors).toHaveLength(count);
			let recovered = 0;
			for (const c of colors) {
				const want = srgb8ToOklab(...c);
				if (
					Math.min(...palette.colors.map((p) => deltaEOk(p.oklab, want))) < 0.02
				)
					recovered++;
			}
			expect(recovered / count).toBeGreaterThanOrEqual(0.95);
		});
	}
});
