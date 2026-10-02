// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it, vi } from "vitest";
import * as recovery from "../session-recovery";

vi.mock("#/lib/nn", async (orig) => ({
	...(await orig<typeof import("#/lib/nn")>()),
	getNn: vi.fn(async () => null),
}));

import { createSkyModel } from "../model";
import { tinyU2netpBytes } from "./u2netp-fixture";

describe("sky device loss", () => {
	it("session-recovery no longer exports a CPU pin", () => {
		expect("createSessionRecovery" in recovery).toBe(false);
		expect(recovery.isDeviceLossError(new Error("Device is lost"))).toBe(true);
	});

	it("the webgpu model asks the registry for its runtime and fails without one", async () => {
		const device = { type: "webgpu" } as never;
		await expect(
			createSkyModel({
				device,
				bytes: tinyU2netpBytes(),
				backends: ["webgpu"],
			}),
		).rejects.toThrow("no GPU nn runtime");
		const { getNn } = await import("#/lib/nn");
		expect(getNn).toHaveBeenCalledWith("sky", device);
	});

	it("falls to the cpu model when the webgpu runtime is gone", async () => {
		const m = await createSkyModel({
			device: { type: "webgpu" } as never,
			bytes: tinyU2netpBytes(),
		});
		expect(m.backend).toBe("cpu");
		m.dispose();
	});
});
