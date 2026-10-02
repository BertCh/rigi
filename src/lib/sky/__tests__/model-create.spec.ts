// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// createSkyModel backend selection (nn CPU backend; no WebGPU device in node specs).
import { describe, expect, it, vi } from "vitest";
import { createSkyModel } from "../model";
import { tinyU2netpBytes } from "./u2netp-fixture";

describe("createSkyModel", () => {
	it("defaults to the cpu backend without a WebGPU device", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const m = await createSkyModel({ bytes: tinyU2netpBytes() });
		expect(m.backend).toBe("cpu");
		expect(m.device).toBeUndefined();
		expect(m.net.stages).toEqual(["e"]);
		m.dispose();
	});
	it("a webgpu-only request without a device fails (the caller falls back to the classical segmenter)", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		await expect(
			createSkyModel({ bytes: tinyU2netpBytes(), backends: ["webgpu"] }),
		).rejects.toThrow(/WebGPU device/);
	});
	it("a webgl device does not enable the webgpu backend", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const m = await createSkyModel({
			bytes: tinyU2netpBytes(),
			device: { type: "webgl" } as never,
		});
		expect(m.backend).toBe("cpu");
	});
	it("rejects bytes that are not a u2netp program", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		await expect(
			createSkyModel({ bytes: new Uint8Array(8), backends: ["cpu"] }),
		).rejects.toThrow();
	});
});
