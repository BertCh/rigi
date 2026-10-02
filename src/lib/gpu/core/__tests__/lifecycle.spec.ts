// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import type { Device } from "@luma.gl/core";
import { describe, expect, it } from "vitest";
import {
	busy,
	done,
	GpuDeviceLostError,
	idleFor,
	onLost,
	untilLost,
} from "../lifecycle";

type FakeDevice = {
	device: Device;
	loseNow: () => void;
};

function fakeDevice(): FakeDevice {
	let lose!: () => void;
	const lost = new Promise<unknown>((r) => {
		lose = () => r({ reason: "destroyed" });
	});
	const dev = { isLost: false, lost } as unknown as { isLost: boolean };
	return {
		device: dev as unknown as Device,
		loseNow: () => {
			dev.isLost = true;
			lose();
		},
	};
}

describe("onLost", () => {
	it("runs each hook once when the device is lost, in order", async () => {
		const { device, loseNow } = fakeDevice();
		const calls: string[] = [];
		onLost(device, () => calls.push("a"));
		onLost(device, () => calls.push("b"));
		expect(calls).toEqual([]);
		loseNow();
		await Promise.resolve();
		await Promise.resolve();
		expect(calls).toEqual(["a", "b"]);
	});
	it("runs a late hook in a microtask on an already lost device", async () => {
		const { device, loseNow } = fakeDevice();
		onLost(device, () => {});
		loseNow();
		await new Promise((r) => setTimeout(r, 0));
		let ran = false;
		onLost(device, () => {
			ran = true;
		});
		expect(ran).toBe(false);
		await Promise.resolve();
		expect(ran).toBe(true);
	});
	it("a throwing hook does not stop the others", async () => {
		const { device, loseNow } = fakeDevice();
		const warn = console.warn;
		console.warn = () => {};
		try {
			let ran = false;
			onLost(device, () => {
				throw new Error("boom");
			});
			onLost(device, () => {
				ran = true;
			});
			loseNow();
			await new Promise((r) => setTimeout(r, 0));
			expect(ran).toBe(true);
		} finally {
			console.warn = warn;
		}
	});
});

describe("untilLost", () => {
	it("resolves with the promise while the device lives", async () => {
		const { device } = fakeDevice();
		await expect(untilLost(device, Promise.resolve(5))).resolves.toBe(5);
	});
	it("rejects at once on an already lost device", async () => {
		const { device, loseNow } = fakeDevice();
		loseNow();
		await expect(
			untilLost(device, new Promise(() => {})),
		).rejects.toBeInstanceOf(GpuDeviceLostError);
	});
	it("rejects a pending promise when the device is lost later", async () => {
		const { device, loseNow } = fakeDevice();
		const p = untilLost(device, new Promise(() => {}));
		loseNow();
		await expect(p).rejects.toThrow(/device was lost/);
	});
});

describe("busy / idleFor", () => {
	it("reports 0 while anything is in flight and never underflows", () => {
		busy();
		busy();
		expect(idleFor()).toBe(0);
		done();
		expect(idleFor()).toBe(0);
		done();
		done(); // extra done clamps at zero
		expect(idleFor()).toBeGreaterThanOrEqual(0);
		busy();
		expect(idleFor()).toBe(0);
		done();
	});
});
