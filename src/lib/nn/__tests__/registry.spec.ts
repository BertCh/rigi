// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import type { Device } from "@luma.gl/core";
import { describe, expect, it, vi } from "vitest";

const released = vi.hoisted(() => ({
	nn: [] as unknown[],
	groups: [] as string[],
}));
vi.mock("#/lib/gpu/core/graph", () => ({
	releaseCachedGraphs: async (_d: unknown, group?: string) => {
		released.groups.push(group ?? "");
	},
}));
vi.mock("../gpu/gpu-nn", () => ({
	GpuNn: class {
		async release() {
			released.nn.push(this);
		}
		constructor(
			readonly device: unknown,
			readonly opts: { graphGroup?: string },
		) {}
	},
}));

const { getNn, nnGraphGroup, perNn, releaseNn } = await import("../registry");

/** A fake luma device whose `lost` promise the test resolves. */
function fakeDevice(type = "webgpu") {
	let lose: () => void = () => {};
	const device = {
		type,
		isLost: false,
		lost: new Promise<void>((r) => {
			lose = r;
		}),
	};
	return {
		device: device as unknown as Device,
		lose: async () => {
			device.isLost = true;
			lose();
			await new Promise((r) => setTimeout(r, 0));
		},
	};
}

describe("getNn", () => {
	it("is null without a WebGPU device", async () => {
		expect(await getNn("x", null)).toBeNull();
		expect(await getNn("x", fakeDevice("webgl").device)).toBeNull();
	});

	it("caches one runtime per (device, consumer) with its own graph group", async () => {
		const { device } = fakeDevice();
		const a = await getNn("people", device);
		expect(await getNn("people", device)).toBe(a);
		const b = await getNn("sky", device);
		expect(b).not.toBe(a);
		expect(
			(a as unknown as { opts: { graphGroup: string } }).opts.graphGroup,
		).toBe(nnGraphGroup("people"));
	});

	it("drops the runtimes of a lost device", async () => {
		const { device, lose } = fakeDevice();
		const a = await getNn("features", device);
		expect(a).not.toBeNull();
		await lose();
		expect(await getNn("features", device)).toBeNull();
		const next = fakeDevice();
		const b = await getNn("features", next.device);
		expect(b).not.toBeNull();
		expect(b).not.toBe(a);
	});
});

describe("perNn", () => {
	it("builds once per runtime and retries a failed build", async () => {
		const { device } = fakeDevice();
		const nn = await getNn("memo", device);
		if (!nn) throw new Error("no runtime");
		let calls = 0;
		const of = perNn(async () => {
			calls++;
			if (calls === 1) throw new Error("first load fails");
			return calls;
		});
		await expect(of(nn)).rejects.toThrow("first load fails");
		await Promise.resolve();
		expect(await of(nn)).toBe(2);
		expect(await of(nn)).toBe(2);
		expect(calls).toBe(2);
	});
});

describe("releaseNn", () => {
	it("drops the consumer's runtime, trims it and releases its graph group; others stay", async () => {
		const { device } = fakeDevice();
		const a = await getNn("nearfield", device);
		const other = await getNn("sky", device);
		released.nn.length = 0;
		released.groups.length = 0;
		await releaseNn("nearfield", device);
		expect(released.nn).toEqual([a]);
		expect(released.groups).toEqual([nnGraphGroup("nearfield")]);
		expect(await getNn("sky", device)).toBe(other);
		const fresh = await getNn("nearfield", device);
		expect(fresh).not.toBe(a);
	});

	it("is a no-op for an unknown consumer or without a device", async () => {
		released.nn.length = 0;
		await releaseNn("never-made", fakeDevice().device);
		await releaseNn("x", null);
		expect(released.nn).toEqual([]);
	});
});
