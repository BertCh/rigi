// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import {
	ancestorWindow,
	atlasBytes,
	compactPlan,
	decodeImageryLayer,
	encodeImageryLayer,
	growCopies,
	grownCapacity,
	IMAGERY_SMALL_TIER_BASE,
	imageryTierOf,
	LayerAllocator,
	leaseFits,
} from "../atlas-layout";

describe("LayerAllocator", () => {
	it("hands out 0,1,2 then reuses the most recently released layer", () => {
		const a = new LayerAllocator(4);
		expect([a.alloc(), a.alloc(), a.alloc()]).toEqual([0, 1, 2]);
		a.release(0);
		a.release(1);
		expect(a.alloc()).toBe(1);
		expect(a.alloc()).toBe(0);
		expect(a.used()).toBe(3);
	});
	it("allocWithin refuses past capacity, alloc does not", () => {
		const a = new LayerAllocator(2);
		expect(a.allocWithin()).toBe(0);
		expect(a.allocWithin()).toBe(1);
		expect(a.allocWithin()).toBeUndefined();
		expect(a.alloc()).toBe(2);
		expect(a.available()).toBe(0);
	});
	it("resetPacked clears the free list", () => {
		const a = new LayerAllocator(8);
		a.alloc();
		a.alloc();
		a.release(0);
		a.resetPacked(3);
		expect(a.used()).toBe(3);
		expect(a.available()).toBe(5);
		expect(a.alloc()).toBe(3);
	});
});

describe("grownCapacity", () => {
	it("is unchanged when need fits or capacity is at max", () => {
		expect(grownCapacity(10, 10, 100, { factor: 2 })).toBe(10);
		expect(grownCapacity(100, 150, 100, { chunk: 8 })).toBe(100);
	});
	it("factor growth takes the larger of need and scaled capacity, capped", () => {
		expect(grownCapacity(10, 11, 100, { factor: 1.5 })).toBe(15);
		expect(grownCapacity(10, 40, 100, { factor: 1.5 })).toBe(40);
		expect(grownCapacity(60, 61, 100, { factor: 2 })).toBe(100);
	});
	it("chunk growth takes the smallest number of chunks reaching need", () => {
		expect(grownCapacity(16, 17, 256, { chunk: 16 })).toBe(32);
		expect(grownCapacity(16, 50, 256, { chunk: 16 })).toBe(64);
		expect(grownCapacity(250, 251, 256, { chunk: 16 })).toBe(256);
	});
});

describe("growCopies / atlasBytes", () => {
	it("halves extents per mip with a floor of 1", () => {
		const c = growCopies(8, 5, 3);
		expect(c.map((x) => x.width)).toEqual([8, 4, 2, 1, 1]);
		expect(
			c.every((x) => x.depthOrArrayLayers === 3 && x.width === x.height),
		).toBe(true);
		expect(c.map((x) => x.mipLevel)).toEqual([0, 1, 2, 3, 4]);
	});
	it("atlasBytes sums the mip chain", () => {
		expect(atlasBytes(4, 1, 1, 4)).toBe(64);
		expect(atlasBytes(4, 3, 2, 1)).toBe((16 + 4 + 1) * 2);
		expect(atlasBytes(256, 9, 0, 4)).toBe(0);
	});
});

describe("compactPlan", () => {
	it("moves live layers to 0..n-1 in order, as runs", () => {
		const { remap, runs, capacity } = compactPlan([7, 3, 4, 9, 0], 4);
		expect([...remap]).toEqual([
			[0, 0],
			[3, 1],
			[4, 2],
			[7, 3],
			[9, 4],
		]);
		expect(runs).toEqual([
			{ from: 0, to: 0, count: 1 },
			{ from: 3, to: 1, count: 2 },
			{ from: 7, to: 3, count: 1 },
			{ from: 9, to: 4, count: 1 },
		]);
		expect(capacity).toBe(8);
	});
	it("keeps already packed layers in a single run and handles none live", () => {
		expect(compactPlan([0, 1, 2], 2).runs).toEqual([
			{ from: 0, to: 0, count: 3 },
		]);
		expect(compactPlan([], 8)).toEqual({
			remap: new Map(),
			runs: [],
			capacity: 0,
		});
	});
});

describe("leaseFits", () => {
	it("needs min(64, max/4) layers of headroom", () => {
		expect(leaseFits(192, 256)).toBe(false); // headroom 64
		expect(leaseFits(191, 256)).toBe(true);
		expect(leaseFits(1900, 2048)).toBe(true);
		expect(leaseFits(1984, 2048)).toBe(false);
	});
});

describe("imagery layer encoding", () => {
	it("tier picks by source size", () => {
		expect(imageryTierOf(256, 256)).toBe(256);
		expect(imageryTierOf(257, 100)).toBe(512);
		expect(imageryTierOf(100, 300)).toBe(512);
	});
	it("encode/decode round-trips both tiers", () => {
		expect(encodeImageryLayer(512, 7)).toBe(7);
		expect(encodeImageryLayer(256, 7)).toBe(IMAGERY_SMALL_TIER_BASE + 7);
		expect(decodeImageryLayer(7)).toEqual({ tier: 512, layer: 7 });
		expect(decodeImageryLayer(IMAGERY_SMALL_TIER_BASE + 7)).toEqual({
			tier: 256,
			layer: 7,
		});
		expect(decodeImageryLayer(-1)).toBeNull();
	});
	it("encoded values are exact f32 integers", () => {
		const e = encodeImageryLayer(256, 2047);
		expect(Math.fround(e)).toBe(e);
	});
});

describe("ancestorWindow", () => {
	it("is the identity for the same tile", () => {
		expect(ancestorWindow({ z: 5, x: 3, y: 4 }, { z: 5, x: 3, y: 4 })).toEqual({
			offsetX: 0,
			offsetY: 0,
			scale: 1,
		});
	});
	it("picks the quadrant of the ancestor", () => {
		const src = { z: 3, x: 2, y: 5 };
		expect(ancestorWindow(src, { z: 4, x: 5, y: 10 })).toEqual({
			offsetX: 0.5,
			offsetY: 0,
			scale: 0.5,
		});
		expect(ancestorWindow(src, { z: 5, x: 11, y: 22 })).toEqual({
			offsetX: 0.75,
			offsetY: 0.5,
			scale: 0.25,
		});
	});
});
