// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** RGBA of a Terrarium pixel at height h (whole metres). */
const px = (h: number) => {
	const v = h + 32768;
	return [Math.floor(v / 256), v % 256, 0, 255];
};

type Noise = (
	data: Uint8ClampedArray<ArrayBufferLike>,
) => Uint8ClampedArray<ArrayBufferLike>;

/**
 * Stand-ins for ImageData / createImageBitmap / OffscreenCanvas: a "bitmap" carries its RGBA bytes
 * (a Blob's bytes are the pixels, as in load.spec.ts); putImageData / drawImage set the canvas
 * pixels, getImageData returns them through `noise`.
 */
function stubCanvas(noise: Noise) {
	vi.stubGlobal(
		"ImageData",
		class {
			constructor(
				public data: Uint8ClampedArray,
				public width: number,
				public height: number,
			) {}
		},
	);
	vi.stubGlobal(
		"createImageBitmap",
		async (src: Blob | { data: Uint8ClampedArray }) => {
			const data =
				src instanceof Blob
					? new Uint8ClampedArray(await src.arrayBuffer())
					: src.data;
			const w = Math.sqrt(data.length / 4);
			return { width: w, height: w, close() {}, data };
		},
	);
	vi.stubGlobal(
		"OffscreenCanvas",
		class {
			getContext() {
				let src: Uint8ClampedArray<ArrayBufferLike> = new Uint8ClampedArray(0);
				return {
					clearRect() {},
					putImageData: (d: { data: Uint8ClampedArray }) => {
						src = d.data;
					},
					drawImage: (b: { data: Uint8ClampedArray }) => {
						src = b.data;
					},
					getImageData: () => ({ data: noise(src.slice()) }),
				};
			}
		},
	);
}

/** Farbling-like noise: R of one pixel (index 5) is off by one. */
const bumpR: Noise = (d) => {
	d[5 * 4] += 1;
	return d;
};

beforeEach(() => {
	vi.resetModules();
	vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("bitmapHeights scratch canvas", () => {
	it("reuses one canvas per size, clears it before each draw, and decodes as before", async () => {
		let made = 0;
		let cleared = 0;
		stubCanvas((d) => d);
		const Base = globalThis.OffscreenCanvas as unknown as new () => {
			getContext(): Record<string, unknown>;
		};
		vi.stubGlobal(
			"OffscreenCanvas",
			class extends Base {
				constructor() {
					super();
					made++;
				}
				getContext() {
					const c = super.getContext();
					c.clearRect = () => cleared++;
					return c;
				}
			},
		);
		const { bitmapHeights } = await import("../image");
		const bitmap = (n: number, h: number) => ({
			width: n,
			height: n,
			close() {},
			data: new Uint8ClampedArray(
				Array.from({ length: n * n }, () => px(h)).flat(),
			),
		});
		for (let i = 0; i < 3; i++) {
			const h = bitmapHeights(bitmap(4, 1000 + i) as unknown as ImageBitmap);
			expect(h[7]).toBe(1000 + i);
		}
		// the readback probe's 512 px canvas, then one 4 px canvas for all three tiles
		expect(made).toBe(2);
		expect(cleared).toBe(3);
		bitmapHeights(bitmap(8, 500) as unknown as ImageBitmap);
		expect(made).toBe(3);
	});
});

describe("readback probe helpers", () => {
	it("the probe pattern is opaque and covers every byte value per channel", async () => {
		const { readbackProbePattern } = await import("../image");
		const p = readbackProbePattern(64);
		expect(p.length).toBe(64 * 64 * 4);
		for (let c = 0; c < 3; c++) {
			const seen = new Set<number>();
			for (let i = c; i < p.length; i += 4) seen.add(p[i]);
			expect(seen.size).toBe(256);
		}
		for (let i = 3; i < p.length; i += 4) expect(p[i]).toBe(255);
	});
	it("counts differing bytes, a length mismatch as all", async () => {
		const { countReadbackMismatches } = await import("../image");
		expect(countReadbackMismatches([1, 2, 3], [1, 2, 3])).toBe(0);
		expect(countReadbackMismatches([1, 2, 3], [1, 0, 0])).toBe(2);
		expect(countReadbackMismatches([1, 2, 3], [])).toBe(3);
	});
});

describe("probeCanvasReadback / blobHeights", () => {
	it("is unknown where there is no canvas (Node), and decode is unchanged", async () => {
		const { probeCanvasReadback, canvasReadback } = await import("../image");
		expect(probeCanvasReadback()).toBe("unknown");
		expect(canvasReadback()).toBe("unknown");
	});
	it("an exact readback leaves heights bit for bit decodeTerrarium's", async () => {
		stubCanvas((d) => d);
		const { blobHeights, canvasReadback } = await import("../image");
		const tile = new Uint8Array(
			Array.from({ length: 16 }, () => px(1500)).flat(),
		);
		tile.set(px(1800), 5 * 4); // a real 300 m step stays
		const h = await blobHeights(new Blob([tile]));
		expect(canvasReadback()).toBe("exact");
		expect(h[5]).toBe(1800);
		expect(h[0]).toBe(1500);
		expect(console.warn).not.toHaveBeenCalled();
	});
	it("a noised readback is detected once and the 256 m spike it causes is repaired", async () => {
		stubCanvas(bumpR);
		const { blobHeights, canvasReadback, probeCanvasReadback } = await import(
			"../image"
		);
		const tile = new Uint8Array(
			Array.from({ length: 64 }, () => px(2000)).flat(),
		);
		const h = await blobHeights(new Blob([tile]));
		expect(canvasReadback()).toBe("noised");
		expect(console.warn).toHaveBeenCalledTimes(1);
		// without the repair pixel 5 would read 2256 m
		for (const v of h) expect(v).toBe(2000);
		probeCanvasReadback();
		expect(console.warn).toHaveBeenCalledTimes(1);
	});
	it("bitmapHeights alone (the GPU ingest's lazy CPU heights) runs the probe and repairs", async () => {
		stubCanvas(bumpR);
		const { bitmapHeights } = await import("../image");
		const n = 8;
		const bmp = {
			width: n,
			height: n,
			close() {},
			data: new Uint8ClampedArray(
				Array.from({ length: n * n }, () => px(3000)).flat(),
			),
		};
		const h = bitmapHeights(bmp as unknown as ImageBitmap);
		for (const v of h) expect(v).toBe(3000);
	});
	it("a readback of the wrong size throws instead of decoding garbage", async () => {
		stubCanvas(() => new Uint8ClampedArray(0));
		const { bitmapHeights } = await import("../image");
		const bmp = {
			width: 2,
			height: 2,
			close() {},
			data: new Uint8ClampedArray(16),
		};
		expect(() => bitmapHeights(bmp as unknown as ImageBitmap)).toThrow(
			/wrong size/,
		);
	});
	it("a blanked readback (all white) is detected as noised", async () => {
		stubCanvas((d) => d.fill(255));
		const { probeCanvasReadback } = await import("../image");
		expect(probeCanvasReadback()).toBe("noised");
	});
});
