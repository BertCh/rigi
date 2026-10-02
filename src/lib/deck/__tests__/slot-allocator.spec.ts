// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { SlotAllocator } from "#/lib/deck/slot-allocator";

describe("SlotAllocator", () => {
	it("hands out 0..n-1 in order and counts usage", () => {
		const a = new SlotAllocator();
		expect([a.alloc(), a.alloc(), a.alloc()]).toEqual([0, 1, 2]);
		expect(a.used).toBe(3);
	});

	it("recycles released indices before growing", () => {
		const a = new SlotAllocator();
		a.alloc();
		a.alloc();
		a.release(0);
		expect(a.used).toBe(1);
		expect(a.alloc()).toBe(0);
		expect(a.alloc()).toBe(2);
	});

	it("returns -1 at the limit and never an index >= limit", () => {
		const a = new SlotAllocator(2);
		expect([a.alloc(), a.alloc(), a.alloc(), a.alloc()]).toEqual([
			0, 1, -1, -1,
		]);
		expect(a.used).toBe(2);
	});

	it("a failed alloc at the limit does not leak: release then alloc succeeds with the freed index", () => {
		const a = new SlotAllocator(1);
		const i = a.alloc();
		expect(a.alloc()).toBe(-1);
		a.release(i);
		expect(a.alloc()).toBe(i);
		expect(a.used).toBe(1);
	});

	it("stays bounded under repeated alloc-fail churn (the CR-45 leak)", () => {
		const a = new SlotAllocator(4);
		for (let k = 0; k < 100; k++) {
			const got = [a.alloc(), a.alloc(), a.alloc(), a.alloc(), a.alloc()];
			expect(got.filter((i) => i >= 0)).toHaveLength(4);
			expect(Math.max(...got)).toBeLessThan(4);
			for (const i of got) if (i >= 0) a.release(i);
		}
	});
});
