// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { beforeEach, describe, expect, it, vi } from "vitest";

const getNn = vi.fn();
vi.mock("#/lib/nn", async (orig) => ({
	...(await orig<typeof import("#/lib/nn")>()),
	getNn: (...a: unknown[]) => getNn(...a),
}));

import { extractFeatures, featuresAvailable, matchFeatures } from "../index";

const image = { width: 2, height: 2, data: new Uint8ClampedArray(16) };

describe("features without WebGPU", () => {
	beforeEach(() => {
		getNn.mockReset();
		getNn.mockResolvedValue(null);
	});

	it("is unavailable when the registry has no GPU runtime", async () => {
		expect(await featuresAvailable()).toBe(false);
		expect(getNn).toHaveBeenCalledWith("features");
	});

	it("extract and match reject with a clear error (no CPU fallback)", async () => {
		await expect(extractFeatures(image)).rejects.toThrow(
			"features: needs WebGPU",
		);
		const set = {
			width: 1,
			height: 1,
			keypoints: new Float32Array(0),
			scores: new Float32Array(0),
			descriptors: new Float32Array(0),
			dim: 128,
			count: 0,
		};
		await expect(matchFeatures(set, set)).rejects.toThrow(
			"features: needs WebGPU",
		);
	});

	it("re-resolves the runtime on every call (a lost device is retried)", async () => {
		await featuresAvailable();
		await featuresAvailable();
		expect(getNn).toHaveBeenCalledTimes(2);
	});
});
