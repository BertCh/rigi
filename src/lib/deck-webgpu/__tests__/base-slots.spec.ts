// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import {
	BaseSlotAllocator,
	baseSlotVec4,
	PACK_FILL,
	type PlacedSlot,
	packedCapacity,
	placeSlots,
} from "../base-slots";

describe("baseSlotVec4 / packedCapacity", () => {
	it("is 2 (G+1)^2", () => {
		expect(baseSlotVec4(32)).toBe(2 * 33 * 33);
		expect(baseSlotVec4(64)).toBe(2 * 65 * 65);
	});
	it("keeps capacity while need is within the fill", () => {
		expect(packedCapacity(1000, 850, 5000)).toBe(1000);
	});
	it("grows to the larger of need/fill and 1.5x, capped at max", () => {
		expect(packedCapacity(1000, 900, 5000)).toBe(1500);
		expect(packedCapacity(1000, 3000, 5000)).toBe(Math.ceil(3000 / PACK_FILL));
		expect(packedCapacity(1000, 3000, 2000)).toBe(2000);
	});
});

describe("BaseSlotAllocator", () => {
	it("bumps then reuses a same-size released slot", () => {
		const a = new BaseSlotAllocator(100);
		expect(a.alloc(10)).toBe(0);
		expect(a.alloc(10)).toBe(10);
		a.release(0, 10);
		expect(a.alloc(10)).toBe(0);
		expect(a.used).toBe(20);
	});
	it("returns undefined when full with no hole", () => {
		const a = new BaseSlotAllocator(20);
		a.alloc(10);
		a.alloc(10);
		expect(a.alloc(1)).toBeUndefined();
	});
	it("splits the smallest larger hole when the bump region is full", () => {
		const a = new BaseSlotAllocator(40);
		const o1 = a.alloc(20) as number;
		a.alloc(20);
		a.release(o1, 20);
		expect(a.alloc(5)).toBe(o1);
		// remainder 15 is now a hole at o1 + 5
		expect(a.alloc(15)).toBe(o1 + 5);
		expect(a.alloc(1)).toBeUndefined();
	});
	it("reset forgets everything and can change capacity", () => {
		const a = new BaseSlotAllocator(10);
		a.alloc(10);
		a.reset(30);
		expect(a.capacity).toBe(30);
		expect(a.used).toBe(0);
		expect(a.alloc(25)).toBe(0);
	});
});

describe("placeSlots", () => {
	const slot = (size: number, base = -1): PlacedSlot => ({ size, base });
	it("places fresh slots without a repack when they fit", () => {
		const a = new BaseSlotAllocator(100);
		const s = [slot(10), slot(20)];
		expect(placeSlots(a, s, s, 1000)).toEqual({
			repacked: false,
			capacity: 100,
		});
		expect(s.map((x) => x.base)).toEqual([0, 10]);
	});
	it("repacks all slots and grows capacity when a fresh slot does not fit", () => {
		const a = new BaseSlotAllocator(30);
		const live = [slot(10), slot(10)];
		placeSlots(a, live, live, 1000);
		const fresh = slot(20);
		const all = [...live, fresh];
		const r = placeSlots(a, all, [fresh], 1000);
		expect(r.repacked).toBe(true);
		expect(r.capacity).toBe(packedCapacity(30, 40, 1000));
		expect(all.map((x) => x.base)).toEqual([0, 10, 20]);
	});
	it("marks slots -1 past the device max", () => {
		const a = new BaseSlotAllocator(10);
		const all = [slot(10), slot(10)];
		const r = placeSlots(a, all, all, 12);
		expect(r.repacked).toBe(true);
		expect(r.capacity).toBe(12);
		expect(all.map((x) => x.base)).toEqual([0, -1]);
	});
});
