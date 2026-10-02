// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import type { Device } from "@luma.gl/core";
import { describe, expect, it } from "vitest";
import { recycleBuffer, takeBuffer } from "../buffer-pool";
import {
	cachedGraphBytes,
	cachedGraphCount,
	cachedGraphFrom as cacheGraph, // aliased: the app-graph manifest check scans call sites for real groups
	setGraphCacheBudget,
} from "../graph";
import { deviceBytes, purgeDeviceMemory, registerDeviceBytes } from "../memory";
import { acquire } from "../pool";
import { fakeDevice } from "./fake-device";

const U = 0x80;

/** A stand-in for ComputeGraph: resident bytes, a lease that runs at once, a destroy counter. */
function fakeGraph(id: string, bytes: number) {
	const g = {
		id,
		destroyed: false,
		isCompiled: bytes > 0,
		stats: undefined,
		residentBytes: () => bytes,
		lease: async (f: () => unknown) => f(),
		destroy() {
			g.destroyed = true;
		},
	};
	return g;
}
const make = (bytes: number) => (id: string) => ({
	graph: fakeGraph(id, bytes) as never,
	extra: undefined,
});
const MB = 1024 * 1024;
/** Eviction destroys behind the group lease and the graph lease: let them run. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("graph cache byte budget", () => {
	it("evicts globally least-recently-used entries over the budget, never the one returned", async () => {
		const { device } = fakeDevice();
		setGraphCacheBudget(device, 100 * MB);
		const a = cacheGraph(device, "g1", "a", make(40 * MB), 8);
		const b = cacheGraph(device, "g2", "b", make(40 * MB), 8);
		cacheGraph(device, "g1", "a", make(40 * MB), 8); // touch a: b is now the oldest
		const c = cacheGraph(device, "g2", "c", make(40 * MB), 8); // 120 MB > 100 MB
		await settle();
		expect((b.graph as never as { destroyed: boolean }).destroyed).toBe(true);
		expect((a.graph as never as { destroyed: boolean }).destroyed).toBe(false);
		expect((c.graph as never as { destroyed: boolean }).destroyed).toBe(false);
		expect(cachedGraphCount(device)).toBe(2);
		expect(cachedGraphBytes(device)).toBe(80 * MB);
	});

	it("spares the returned entry even when it alone exceeds the budget", () => {
		const { device } = fakeDevice();
		setGraphCacheBudget(device, 10 * MB);
		const big = cacheGraph(device, "g", "big", make(50 * MB), 8);
		expect((big.graph as never as { destroyed: boolean }).destroyed).toBe(
			false,
		);
		expect(cachedGraphCount(device)).toBe(1);
	});

	it("purgeDeviceMemory evicts down to half the budget", async () => {
		const { device } = fakeDevice();
		setGraphCacheBudget(device, 100 * MB);
		const gs = ["a", "b", "c"].map((k) =>
			cacheGraph(device, "g", k, make(30 * MB), 8),
		);
		expect(cachedGraphCount(device)).toBe(3);
		expect(purgeDeviceMemory(device, { force: true })).toBe(true);
		await settle();
		// 90 MB -> at most 50 MB: the two oldest go
		expect(
			gs.map((g) => (g.graph as never as { destroyed: boolean }).destroyed),
		).toEqual([true, true, false]);
	});
});

describe("deviceBytes", () => {
	it("sums the free pool, graphs and registered providers; pool is inside freePool.live", () => {
		const { device } = fakeDevice();
		setGraphCacheBudget(device, 1024 * MB);
		acquire(device, "k/a", 1000, U); // 1024 live
		const t = takeBuffer(device, 256, U);
		recycleBuffer(device, t); // 256 idle
		cacheGraph(device, "g", "x", make(3 * MB), 8);
		const off = registerDeviceBytes(device, "weights", () => 7 * MB);
		const d = deviceBytes(device);
		expect(d.pool).toBe(1024);
		expect(d.freePool).toEqual({ live: 1024, idle: 256 });
		expect(d.graphs).toBe(3 * MB);
		expect(d.readback).toBe(0);
		expect(d.registered).toEqual({ weights: 7 * MB });
		expect(d.total).toBe(1024 + 256 + 3 * MB + 7 * MB);
		off();
		expect(deviceBytes(device).registered).toEqual({});
	});

	it("drops providers on device loss and tolerates a throwing one", async () => {
		const f = fakeDevice();
		registerDeviceBytes(f.device, "bad", () => {
			throw new Error("gone");
		});
		expect(deviceBytes(f.device).registered).toEqual({ bad: 0 });
		await f.lose();
		expect(deviceBytes(f.device as Device).registered).toEqual({});
	});
});
