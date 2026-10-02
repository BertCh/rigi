// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it, vi } from "vitest";
import { withFlags } from "#/test/helpers";
import { horizonPrecisionOptIn } from "../opt-in";

// gpuEnabled() reads the `gpu` flag (and WebGPU presence); stub it to the flag alone.
vi.mock("../../device", async () => {
	const { getFlag } = await import("#/lib/flags");
	return { gpuEnabled: () => getFlag("gpu") === "on" };
});

describe("horizonPrecisionOptIn", () => {
	it("is certified-f32 while the GPU is on", () => {
		withFlags({ gpu: "on" });
		expect(horizonPrecisionOptIn()).toBe("certified-f32");
	});

	it("falls back to f64 under ?gpu=off", () => {
		withFlags({ gpu: "off" });
		expect(horizonPrecisionOptIn()).toBe("f64");
	});
});
