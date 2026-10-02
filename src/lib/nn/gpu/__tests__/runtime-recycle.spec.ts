// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import type { Device } from "@luma.gl/core";
import { describe, expect, it } from "vitest";
import { bufferPoolStats, takeBuffer } from "#/lib/gpu/core/buffer-pool";
import { Runtime } from "../runtime";

function fakeDevice() {
	return {
		isLost: false,
		lost: new Promise<unknown>(() => {}),
		type: "webgpu",
		limits: { minStorageBufferOffsetAlignment: 256 },
		createBuffer: (p: { id: string; byteLength: number; usage: number }) => ({
			...p,
			destroyed: false,
			write() {},
			destroy() {
				this.destroyed = true;
			},
		}),
	} as unknown as Device;
}

describe("Runtime.recycle on the shared pool", () => {
	it("hands the buffer back only behind the queued steps", async () => {
		const device = fakeDevice();
		const rt = new Runtime(device);
		const b = rt.allocate(1000);
		expect(b.byteLength).toBe(1024);
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const step = rt.enqueue(() => gate); // a queued step that has not submitted yet
		rt.recycle(b);
		await Promise.resolve();
		expect(bufferPoolStats(device).idleBuffers).toBe(0); // not yet reusable by another owner
		expect(rt.stats.freeBuffers).toBe(1);
		release();
		await step;
		await rt.enqueue(() => {});
		expect(bufferPoolStats(device).idleBytes).toBe(1024);
		expect(rt.stats).toMatchObject({ freeBuffers: 0, liveBytes: 0 });
		// another owner of the shared pool now gets the same buffer
		expect(takeBuffer(device, 600, b.usage)).toBe(b);
	});

	it("trim purges the idle buffers", async () => {
		const device = fakeDevice();
		const rt = new Runtime(device);
		rt.recycle(rt.allocate(256));
		await rt.enqueue(() => {});
		expect(bufferPoolStats(device).idleBuffers).toBe(1);
		rt.trim();
		expect(bufferPoolStats(device).idleBuffers).toBe(0);
	});
});
