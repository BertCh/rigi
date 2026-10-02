// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import {
	bufferPoolStats,
	purgeBuffers,
	recycleBuffer,
	setBufferIdleCap,
	takeBuffer,
} from "../buffer-pool";
import { fakeDevice } from "./fake-device";

const U = 0x80; // any usage mask

describe("buffer-pool", () => {
	it("takes power-of-two capacities and reuses a recycled buffer of the same bucket", () => {
		const { device, created } = fakeDevice();
		const a = takeBuffer(device, 300, U);
		expect(a.byteLength).toBe(512);
		expect(bufferPoolStats(device)).toEqual({
			liveBytes: 512,
			idleBytes: 0,
			idleBuffers: 0,
		});
		recycleBuffer(device, a);
		expect(bufferPoolStats(device)).toEqual({
			liveBytes: 0,
			idleBytes: 512,
			idleBuffers: 1,
		});
		const b = takeBuffer(device, 500, U);
		expect(b).toBe(a);
		expect(created).toHaveLength(1);
	});

	it("keeps usage and size classes apart", () => {
		const { device, created } = fakeDevice();
		const a = takeBuffer(device, 256, U);
		recycleBuffer(device, a);
		expect(takeBuffer(device, 256, U | 1)).not.toBe(a);
		expect(takeBuffer(device, 257, U)).not.toBe(a);
		expect(created).toHaveLength(3);
		expect(takeBuffer(device, 1, U)).toBe(a);
	});

	it("ignores a double recycle and destroys a foreign buffer", () => {
		const { device } = fakeDevice();
		const a = takeBuffer(device, 256, U);
		recycleBuffer(device, a);
		recycleBuffer(device, a);
		expect(bufferPoolStats(device).idleBuffers).toBe(1);
		const foreign = device.createBuffer({ id: "x", usage: U, byteLength: 256 });
		recycleBuffer(device, foreign);
		expect((foreign as unknown as { destroyed: boolean }).destroyed).toBe(true);
	});

	it("destroys the oldest idle buffers over the idle cap", () => {
		const { device } = fakeDevice();
		setBufferIdleCap(device, 1024);
		const bs = [0, 1, 2].map((i) => takeBuffer(device, 512 << i, U)); // 512, 1024, 2048
		for (const b of bs) recycleBuffer(device, b);
		// 512 + 1024 > 1024 -> oldest (512) destroyed; adding 2048 -> 1024 destroyed too, 2048 alone > cap
		expect(bufferPoolStats(device).idleBytes).toBeLessThanOrEqual(1024);
		const destroyed = bs.map(
			(b) => (b as unknown as { destroyed: boolean }).destroyed,
		);
		expect(destroyed).toEqual([true, true, true]);
		setBufferIdleCap(device, 4096);
		const c = takeBuffer(device, 512, U);
		const d = takeBuffer(device, 1024, U);
		recycleBuffer(device, c);
		recycleBuffer(device, d);
		expect(bufferPoolStats(device).idleBuffers).toBe(2);
	});

	it("purgeBuffers destroys oldest first down to keepBytes", () => {
		const { device } = fakeDevice();
		const [a, b, c] = [256, 512, 1024].map((n) => takeBuffer(device, n, U));
		for (const x of [a, b, c]) recycleBuffer(device, x);
		purgeBuffers(device, { keepBytes: 1024 });
		const gone = (x: unknown) => (x as { destroyed: boolean }).destroyed;
		expect([gone(a), gone(b), gone(c)]).toEqual([true, true, false]);
		expect(bufferPoolStats(device).idleBytes).toBe(1024);
		purgeBuffers(device);
		expect(gone(c)).toBe(true);
		expect(bufferPoolStats(device).idleBuffers).toBe(0);
	});

	it("drops idle buffers when the device is lost", async () => {
		const f = fakeDevice();
		const a = takeBuffer(f.device, 256, U);
		const b = takeBuffer(f.device, 256, U);
		recycleBuffer(f.device, a);
		await f.lose();
		expect((a as unknown as { destroyed: boolean }).destroyed).toBe(true);
		expect(bufferPoolStats(f.device).idleBytes).toBe(0);
		recycleBuffer(f.device, b); // after loss: destroyed, not pooled
		expect((b as unknown as { destroyed: boolean }).destroyed).toBe(true);
	});
});
