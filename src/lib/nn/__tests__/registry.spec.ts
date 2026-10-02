// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import type { Device } from "@luma.gl/core";
import { describe, expect, it, vi } from "vitest";

vi.mock("../gpu/gpu-nn", () => ({
	GpuNn: class {
		constructor(
			readonly device: unknown,
			readonly opts: { graphGroup?: string },
		) {}
	},
}));

const { getNn, nnGraphGroup, perNn } = await import("../registry");

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
