// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import type { Device } from "@luma.gl/core";
import { describe, expect, it, vi } from "vitest";
import { withFlags } from "#/test/helpers";
import {
	attachFrameTimings,
	currentFrameTimings,
	deckFrameTimingsProps,
	type FrameTimings,
	recordDeckFrameTimings,
} from "../frame-timings";

const fakeDevice = () =>
	({
		type: "webgpu",
		features: new Set(["timestamp-query"]),
		createQuerySet: vi.fn(() => ({
			destroy() {},
			readResults: async () => [],
		})),
	}) as unknown as Device;

describe("deck frame timings", () => {
	it("props are empty with the flag off and a callback with it on", () => {
		expect(deckFrameTimingsProps()).toEqual({});
		withFlags({ gpuFrameTimings: "on" });
		const props = deckFrameTimingsProps(() => undefined);
		expect(typeof props._onFrameTimings).toBe("function");
	});

	it("feeds an attached timer: deck-layers pass, source deck, cpu mean", () => {
		withFlags({ gpuFrameTimings: "on" });
		const device = fakeDevice();
		const timer = attachFrameTimings(device);
		if (!timer) throw new Error("no timer");
		const seen: FrameTimings[] = [];
		timer.onFrameTimings((t) => seen.push(t));
		timer.beginFrame(7);
		const props = deckFrameTimingsProps(() => device);
		props._onFrameTimings?.({ cpuTime: 2, gpuTime: 1.5 });
		props._onFrameTimings?.({ cpuTime: 4 });
		expect(seen).toEqual([
			{
				frame: 7,
				passes: [{ name: "deck-layers", gpuMs: 1.5 }],
				totalGpuMs: 1.5,
				source: "deck",
				cpuMs: 2,
			},
		]);
		expect(timer.deckCpuMs).toBe(3);
		const view = currentFrameTimings();
		expect(view?.mean.passes).toEqual([{ name: "deck-layers", gpuMs: 1.5 }]);
		expect(view?.mean.frames).toBe(0);
		expect(view?.deck).toEqual({ cpuMs: 3, gpuMs: 1.5, frames: 2 });
		timer.destroy();
	});

	it("without a timer keeps a deck-only view", () => {
		expect(currentFrameTimings()).toBeNull();
		recordDeckFrameTimings({ cpuTime: 2 });
		recordDeckFrameTimings({ cpuTime: 4 });
		expect(currentFrameTimings()).toEqual({
			latest: null,
			mean: { passes: [], totalGpuMs: 0, frames: 0 },
			disabledReason: null,
			deck: { cpuMs: 3, gpuMs: null, frames: 2 },
		});
	});
});
