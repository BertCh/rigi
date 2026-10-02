// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { bufferPoolStats, takeBuffer } from "../buffer-pool";
import {
	acquire,
	afterSubmit,
	isPooled,
	poolStats,
	releasePool,
} from "../pool";
import { asBuffer, fakeDevice } from "./fake-device";

const U = 0x80;

describe("named pool on the shared free pool", () => {
	it("hands a grown-out buffer to the free pool at the next submit, where another owner can take it", () => {
		const { device, created } = fakeDevice();
		const small = acquire(device, "k/a", 300, U);
		const big = acquire(device, "k/a", 5000, U);
		expect(big).not.toBe(small);
		expect(bufferPoolStats(device).idleBuffers).toBe(0); // not before the submit
		afterSubmit(device);
		expect(bufferPoolStats(device).idleBytes).toBe(512);
		expect(isPooled(small)).toBe(false);
		expect(isPooled(big)).toBe(true);
		expect(takeBuffer(device, 400, U)).toBe(small);
		expect(created).toHaveLength(2);
		expect(poolStats(device)).toEqual({ slots: 1, bytes: 8192 });
	});

	it("releasePool recycles instead of destroying", () => {
		const { device } = fakeDevice();
		const b = acquire(device, "k/b", 256, U);
		releasePool(device, "k/");
		expect(asBuffer(b as never)).toBe(b);
		expect((b as unknown as { destroyed: boolean }).destroyed).toBe(false);
		expect(bufferPoolStats(device)).toMatchObject({
			liveBytes: 0,
			idleBytes: 256,
		});
		// a named slot is always fresh (zeroed); the recycled buffer serves takeBuffer
		expect(acquire(device, "k/c", 256, U)).not.toBe(b);
		expect(takeBuffer(device, 256, U)).toBe(b);
	});

	it("destroys the slots on device loss", async () => {
		const f = fakeDevice();
		const b = acquire(f.device, "k/d", 256, U);
		await f.lose();
		expect((b as unknown as { destroyed: boolean }).destroyed).toBe(true);
		expect(poolStats(f.device).slots).toBe(0);
	});
});
