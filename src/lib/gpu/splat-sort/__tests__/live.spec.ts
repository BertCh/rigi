// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { liveOrderByKey, splatKeysF32 } from "../cpu";
import { TILE } from "../live.wgsl";
import {
	LIVE_ARGS_BYTES,
	liveDispatchArgs,
	liveDrawArgs,
	packLiveSplatSortParams,
	workgroupCount,
} from "../uniforms";

describe("live splat sort helpers", () => {
	it("workgroupCount rounds up", () => {
		expect(workgroupCount(0, TILE)).toBe(0);
		expect(workgroupCount(1, TILE)).toBe(1);
		expect(workgroupCount(TILE, TILE)).toBe(1);
		expect(workgroupCount(TILE + 1, TILE)).toBe(2);
		expect(workgroupCount(50000, TILE)).toBe(196);
	});

	it("dispatch args clamp the counter to the capacity", () => {
		expect(Array.from(liveDispatchArgs(50000, 400000, TILE))).toEqual([
			196, 1, 1, 50000,
		]);
		expect(Array.from(liveDispatchArgs(999999, 1000, TILE))).toEqual([
			4, 1, 1, 1000,
		]);
		// x = 0 skips the indirect dispatches
		expect(liveDispatchArgs(0, 1000, TILE)[0]).toBe(0);
		expect(liveDispatchArgs(1, 1000, TILE).byteLength).toBe(LIVE_ARGS_BYTES);
	});

	it("draw args are drawIndirect's [vertexCount, instanceCount, 0, 0]", () => {
		expect(Array.from(liveDrawArgs(123))).toEqual([6, 123, 0, 0]);
	});

	it("params block is 32 B: row, near 0, capacity, vertexCount 6", () => {
		const b = packLiveSplatSortParams([0, 0, 1, 0.5], 400000);
		expect(b.byteLength).toBe(32);
		const f = new Float32Array(b);
		const u = new Uint32Array(b);
		expect(Array.from(f.subarray(0, 4))).toEqual([0, 0, 1, 0.5]);
		expect(f[4]).toBe(0);
		expect(u[5]).toBe(400000);
		expect(u[6]).toBe(6);
	});
});

describe("liveOrderByKey (CPU twin of the live counting sort)", () => {
	const positions = new Float32Array(3 * 2000);
	let seed = 3;
	const rnd = () => {
		seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
		return seed / 4294967296;
	};
	for (let i = 0; i < 2000; i++) {
		positions[3 * i] = rnd() * 10 - 5;
		positions[3 * i + 1] = rnd() * 10 - 5;
		// a tenth at or behind the camera plane, with masses of equal depth
		positions[3 * i + 2] = rnd() < 0.1 ? 3 : -Math.round(1 + rnd() * 50);
	}
	const row = [0, 0, 1, 0] as const;
	const { keys, kept } = splatKeysF32(positions, 2000, row);

	it("orders exactly the kept splats, ascending key, with an empty tail", () => {
		const { order, kept: k, starts } = liveOrderByKey(keys, 2000);
		expect(k).toBe(kept);
		expect(order.length).toBe(kept);
		expect(new Set(order).size).toBe(kept);
		for (let i = 1; i < order.length; i++)
			expect(keys[order[i]]).toBeGreaterThanOrEqual(keys[order[i - 1]]);
		for (const i of order) expect(keys[i]).toBeLessThan(65536);
		// the scan table: start of the first non-empty bin is 0, starts never decrease
		expect(starts[keys[order[0]]]).toBe(0);
		for (let b = 1; b < starts.length; b++)
			expect(starts[b]).toBeGreaterThanOrEqual(starts[b - 1]);
	});

	it("any claim order within a key gives a valid order (atomics are unordered)", () => {
		const reversed = Array.from({ length: 2000 }, (_, i) => 1999 - i);
		const a = liveOrderByKey(keys, 2000);
		const b = liveOrderByKey(keys, 2000, reversed);
		expect(b.kept).toBe(a.kept);
		expect(Array.from(b.order.map((i) => keys[i]))).toEqual(
			Array.from(a.order.map((i) => keys[i])),
		);
	});

	it("only the first `count` splats count (the dead tail is never read)", () => {
		const { order, kept: k } = liveOrderByKey(keys, 500);
		expect(order.length).toBe(k);
		for (const i of order) expect(i).toBeLessThan(500);
	});
});
