// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it, vi } from "vitest";
import {
	evictImagery,
	imageryBytes,
	touchImagery,
} from "#/lib/deck/imagery-cache";

const bmp = (n = 1) => ({ width: 16 * n, height: 16 * n }); // 1024 * n² bytes

describe("imagery cache LRU", () => {
	it("is a no-op under the cap", () => {
		const m = new Map([["a", bmp()]]);
		const release = vi.fn();
		expect(evictImagery(m, new Set(), 1e6, release)).toEqual([]);
		expect(release).not.toHaveBeenCalled();
	});

	it("evicts oldest first until under the cap and releases each", () => {
		const m = new Map([
			["a", bmp()],
			["b", bmp()],
			["c", bmp()],
		]);
		const release = vi.fn();
		const out = evictImagery(m, new Set(), 2 * imageryBytes(bmp()), release);
		expect(out).toEqual(["a"]);
		expect([...m.keys()]).toEqual(["b", "c"]);
		expect(release).toHaveBeenCalledTimes(1);
	});

	it("never evicts kept ids, even over the cap", () => {
		const m = new Map([
			["a", bmp()],
			["b", bmp()],
			["c", bmp()],
		]);
		const out = evictImagery(m, new Set(["a", "b", "c"]), 0, () => {});
		expect(out).toEqual([]);
		expect(m.size).toBe(3);
	});

	it("skips kept entries and takes the next oldest", () => {
		const m = new Map([
			["a", bmp()],
			["b", bmp()],
			["c", bmp()],
		]);
		const out = evictImagery(m, new Set(["a"]), imageryBytes(bmp()), () => {});
		expect(out).toEqual(["b", "c"]);
		expect([...m.keys()]).toEqual(["a"]);
	});

	it("touch moves entries to the most-recent end and ignores unknown ids", () => {
		const m = new Map([
			["a", bmp()],
			["b", bmp()],
			["c", bmp()],
		]);
		touchImagery(m, ["a", "zzz"]);
		expect([...m.keys()]).toEqual(["b", "c", "a"]);
		const out = evictImagery(m, new Set(), 2 * imageryBytes(bmp()), () => {});
		expect(out).toEqual(["b"]);
	});
});
