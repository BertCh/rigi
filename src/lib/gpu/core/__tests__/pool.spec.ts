// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import type { Device } from "@luma.gl/core";
import { describe, expect, it } from "vitest";
import {
	acquire,
	afterSubmit,
	capacityFor,
	isPooled,
	pooledStorage,
	pooledUniform,
	poolStats,
	range,
	releasePool,
	withLease,
} from "../pool";

class FakeBuffer {
	destroyed = false;
	writes: Uint8Array[] = [];
	byteLength: number;
	id: string;
	constructor(props: { id: string; byteLength: number }) {
		this.byteLength = props.byteLength;
		this.id = props.id;
	}
	write(d: ArrayBufferView) {
		this.writes.push(
			new Uint8Array(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength)),
		);
	}
	destroy() {
		this.destroyed = true;
	}
}

function fakeDevice() {
	const created: FakeBuffer[] = [];
	const lost = new Promise<unknown>(() => {});
	const device = {
		isLost: false,
		lost,
		createBuffer: (p: { id: string; byteLength: number }) => {
			const b = new FakeBuffer(p);
			created.push(b);
			return b;
		},
	} as unknown as Device;
	return { device, created };
}

describe("capacityFor", () => {
	it("is a power of two with a 256 byte floor", () => {
		expect(capacityFor(0)).toBe(256);
		expect(capacityFor(256)).toBe(256);
		expect(capacityFor(257)).toBe(512);
		expect(capacityFor(5000)).toBe(8192);
	});
});

describe("acquire", () => {
	it("returns the same buffer until a larger size is asked, then grows", () => {
		const { device, created } = fakeDevice();
		const a = acquire(device, "k", 100, 1);
		expect(acquire(device, "k", 256, 1)).toBe(a);
		const b = acquire(device, "k", 257, 1);
		expect(b).not.toBe(a);
		expect(b.byteLength).toBe(512);
		expect(created.length).toBe(2);
		expect(isPooled(b)).toBe(true);
	});
	it("keys slots by usage too", () => {
		const { device } = fakeDevice();
		expect(acquire(device, "k", 16, 1)).not.toBe(acquire(device, "k", 16, 2));
	});
	it("destroys a grown-out buffer once its lease ends, not before", async () => {
		const { device, created } = fakeDevice();
		await withLease("grow", () => {
			acquire(device, "grow/x", 16, 1);
			acquire(device, "grow/x", 1000, 1);
			expect(created[0].destroyed).toBe(false);
		});
		expect(created[0].destroyed).toBe(true);
		expect(created[1].destroyed).toBe(false);
	});
});

describe("pooledStorage / pooledUniform / range", () => {
	it("zeroes a size request and pads data to 4 bytes", () => {
		const { device } = fakeDevice();
		const z = pooledStorage(device, "s", 10) as unknown as FakeBuffer;
		expect(z.writes[0].length).toBe(16);
		const d = pooledStorage(
			device,
			"t",
			new Uint8Array([1, 2, 3, 4, 5]),
		) as unknown as FakeBuffer;
		expect(Array.from(d.writes[0])).toEqual([1, 2, 3, 4, 5, 0, 0, 0]);
	});
	it("skips zeroing when asked", () => {
		const { device } = fakeDevice();
		const z = pooledStorage(device, "s", 64, {
			zero: false,
		}) as unknown as FakeBuffer;
		expect(z.writes.length).toBe(0);
	});
	it("pads a uniform to a multiple of 16 bytes", () => {
		const { device } = fakeDevice();
		const u = pooledUniform(
			device,
			"u",
			new Float32Array([1, 2, 3, 4, 5]),
		) as unknown as FakeBuffer;
		expect(u.writes[0].length).toBe(32);
		expect(new Float32Array(u.writes[0].buffer)[4]).toBe(5);
	});
	it("range rounds size up to 4 bytes", () => {
		const b = { byteLength: 64 } as never;
		expect(range(b, 5)).toEqual({ buffer: b, offset: 0, size: 8 });
		expect(range(b, 16, 32).offset).toBe(32);
	});
});

describe("releasePool / poolStats", () => {
	it("releases by prefix and counts bytes", () => {
		const { device, created } = fakeDevice();
		acquire(device, "a/one", 100, 1);
		acquire(device, "a/two", 300, 1);
		acquire(device, "b/one", 100, 1);
		expect(poolStats(device)).toEqual({ slots: 3, bytes: 256 + 512 + 256 });
		releasePool(device, "a/");
		expect(poolStats(device).slots).toBe(1);
		expect(created.filter((b) => b.destroyed).length).toBe(2);
		releasePool(device);
		expect(poolStats(device)).toEqual({ slots: 0, bytes: 0 });
	});
	it("reports an empty pool for an unknown device", () => {
		expect(poolStats(fakeDevice().device)).toEqual({ slots: 0, bytes: 0 });
	});
});

describe("withLease", () => {
	it("runs same-key callers one at a time in call order", async () => {
		const log: string[] = [];
		const slow = (name: string, ms: number) =>
			withLease("order", async () => {
				log.push(`${name}:start`);
				await new Promise((r) => setTimeout(r, ms));
				log.push(`${name}:end`);
			});
		await Promise.all([slow("a", 15), slow("b", 1)]);
		expect(log).toEqual(["a:start", "a:end", "b:start", "b:end"]);
	});
	it("a rejection propagates and releases the lease", async () => {
		await expect(
			withLease("rej", () => {
				throw new Error("x");
			}),
		).rejects.toThrow("x");
		await expect(withLease("rej", () => 3)).resolves.toBe(3);
	});
	it("different keys do not wait for each other", async () => {
		let release!: () => void;
		const held = withLease(
			"one",
			() => new Promise<void>((r) => (release = r)),
		);
		await expect(withLease("two", () => "ok")).resolves.toBe("ok");
		release();
		await held;
	});
});

describe("afterSubmit (CR-39: unleased growth)", () => {
	it("destroys a grown-out buffer of an unleased slot only at the next submit", () => {
		const { device, created } = fakeDevice();
		acquire(device, "unleased/x", 16, 1);
		acquire(device, "unleased/x", 1000, 1);
		expect(created[0].destroyed).toBe(false);
		afterSubmit(device);
		expect(created[0].destroyed).toBe(true);
		expect(created[1].destroyed).toBe(false);
	});
	it("never destroys a slot a lease holds, even at a submit from another caller", async () => {
		const { device, created } = fakeDevice();
		await withLease("held", async () => {
			acquire(device, "held/x", 16, 1);
			acquire(device, "held/x", 1000, 1);
			afterSubmit(device);
			await Promise.resolve();
			afterSubmit(device);
			expect(created[0].destroyed).toBe(false);
		});
		expect(created[0].destroyed).toBe(true);
	});
});
