// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { afterEach, describe, expect, it, vi } from "vitest";
import { fallbackIntervalMs, LiveSplatBridge } from "../bridge";
import type { LiveNearField } from "../session";

afterEach(() => vi.useRealTimers());

function fakeLive(version: { v: number }) {
	const readCloud = vi.fn(async () => ({
		count: 2,
		frame: "enu" as const,
		positions: new Float32Array(6),
		scales: new Float32Array(6),
		rotations: new Float32Array(8),
		colors: new Uint8Array(8),
		provenance: new Uint8Array(2),
		cells: new Uint32Array(2),
	}));
	const live = {
		width: 4,
		height: 4,
		calibration: null,
		source: { getVersion: () => version.v },
		readCloud,
	} as unknown as LiveNearField;
	return { live, readCloud };
}

describe("LiveSplatBridge", () => {
	it("clamps the fallback rate to 2 Hz", () => {
		expect(fallbackIntervalMs(undefined)).toBe(500);
		expect(fallbackIntervalMs(30)).toBe(500);
		expect(fallbackIntervalMs(1)).toBe(1000);
	});

	it("hands the GPU source to a WebGPU host and reads nothing back", () => {
		const { live, readCloud } = fakeLive({ v: 0 });
		const host = { setNearFieldLive: vi.fn(), setNearField: vi.fn() };
		const b = new LiveSplatBridge(host, live);
		expect(b.mode).toBe("gpu");
		b.start();
		expect(host.setNearFieldLive).toHaveBeenCalledWith(live.source, undefined);
		expect(readCloud).not.toHaveBeenCalled();
		b.stop();
		expect(host.setNearFieldLive).toHaveBeenLastCalledWith(null);
	});

	it("reads back at most every 500 ms on a host without setNearFieldLive, and only on a new version", async () => {
		vi.useFakeTimers();
		const version = { v: 1 };
		const { live, readCloud } = fakeLive(version);
		const host = { setNearField: vi.fn() };
		const b = new LiveSplatBridge(host, live, { hz: 60 });
		expect(b.mode).toBe("readback");
		b.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(readCloud).toHaveBeenCalledTimes(1);
		expect(host.setNearField).toHaveBeenCalledTimes(1);
		const scene = host.setNearField.mock.calls[0][0];
		expect(scene.splats.count).toBe(2);
		// same version: polls but does not read
		await vi.advanceTimersByTimeAsync(2000);
		expect(readCloud).toHaveBeenCalledTimes(1);
		// a new version: one read within the next interval
		version.v = 2;
		await vi.advanceTimersByTimeAsync(499);
		expect(readCloud.mock.calls.length).toBeLessThanOrEqual(2);
		await vi.advanceTimersByTimeAsync(600);
		expect(readCloud).toHaveBeenCalledTimes(2);
		b.stop();
		expect(host.setNearField).toHaveBeenLastCalledWith(null);
		await vi.advanceTimersByTimeAsync(5000);
		expect(readCloud).toHaveBeenCalledTimes(2);
	});
});
