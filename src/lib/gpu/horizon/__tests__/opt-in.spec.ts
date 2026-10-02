// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it, vi } from "vitest";
import { withFlags } from "#/test/helpers";
import { gpuHorizonOptIn, horizonPrecisionOptIn } from "../opt-in";

// gpuEnabled() reads the `gpu` flag (and WebGPU presence); stub it to the flag alone.
vi.mock("../../device", async () => {
	const { getFlag } = await import("#/lib/flags");
	return { gpuEnabled: () => getFlag("gpu") === "on" };
});

type OnOff = "on" | "off";
const onOff: OnOff[] = ["on", "off"];
const precisions = ["f64", "certified-f32"] as const;

describe("gpuHorizonOptIn", () => {
	for (const gpuHorizon of onOff)
		for (const gpu of onOff)
			it(`gpuHorizon=${gpuHorizon} gpu=${gpu}`, () => {
				withFlags({ gpuHorizon, gpu });
				expect(gpuHorizonOptIn()).toBe(gpuHorizon === "on" && gpu === "on");
			});
});

describe("horizonPrecisionOptIn", () => {
	for (const gpuHorizon of onOff)
		for (const gpu of onOff)
			for (const horizonPrecision of precisions)
				it(`gpuHorizon=${gpuHorizon} gpu=${gpu} horizonPrecision=${horizonPrecision}`, () => {
					withFlags({ gpuHorizon, gpu, horizonPrecision });
					const marchOn = gpuHorizon === "on" && gpu === "on";
					expect(horizonPrecisionOptIn()).toBe(
						horizonPrecision === "certified-f32" && marchOn
							? "certified-f32"
							: "f64",
					);
				});

	it("certified-f32 with the GPU march off falls back to f64", () => {
		withFlags({ gpuHorizon: "off", horizonPrecision: "certified-f32" });
		expect(horizonPrecisionOptIn()).toBe("f64");
	});
});
