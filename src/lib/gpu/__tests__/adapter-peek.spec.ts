// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { afterEach, describe, expect, it, vi } from "vitest";
import {
	adapterLimits,
	navigatorGpu,
	peekWebGPUAdapter,
} from "../adapter-peek";

const fakeAdapter = (limits: Record<string, unknown>) =>
	({ limits }) as unknown as GPUAdapter;

describe("adapter-peek", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("adapterLimits keeps numeric limits only, for the keys asked", () => {
		const a = fakeAdapter({
			maxTextureArrayLayers: 2048,
			maxStorageBufferBindingSize: 1 << 30,
			maxBufferSize: "big",
		});
		expect(
			adapterLimits(a, [
				"maxTextureArrayLayers",
				"maxBufferSize",
				"maxComputeWorkgroupSizeX",
			]),
		).toEqual({ maxTextureArrayLayers: 2048 });
	});

	it("peekWebGPUAdapter is null without navigator.gpu", async () => {
		vi.stubGlobal("navigator", {});
		expect(navigatorGpu()).toBeUndefined();
		expect(
			await peekWebGPUAdapter({ powerPreference: "high-performance" }),
		).toBeNull();
	});

	it("peekWebGPUAdapter forwards the options to requestAdapter verbatim", async () => {
		const adapter = fakeAdapter({});
		const requestAdapter = vi.fn(async () => adapter);
		vi.stubGlobal("navigator", { gpu: { requestAdapter } });
		const options = {
			powerPreference: "high-performance",
			featureLevel: "core",
		} as GPURequestAdapterOptions;
		expect(await peekWebGPUAdapter(options)).toBe(adapter);
		expect(requestAdapter).toHaveBeenCalledWith(options);
	});
});
