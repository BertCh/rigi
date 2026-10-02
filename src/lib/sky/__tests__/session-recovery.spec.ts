// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { createSessionRecovery, isDeviceLossError } from "../session-recovery";

describe("isDeviceLossError", () => {
	it.each([
		new Error("Device is lost"),
		new Error(
			"Failed to execute 'submit' on 'GPUQueue': Parent device is lost",
		),
		new Error("GPUDevice was destroyed"),
		"the WebGPU device was lost",
		Object.assign(new Error("x"), { name: "GPUDeviceLostInfo" }),
	])("matches %s", (e) => expect(isDeviceLossError(e)).toBe(true));

	it.each([
		new Error("Session already started"),
		new Error("model: HTTP 404"),
		new Error("out of memory"),
		null,
		undefined,
		42,
	])("does not match %s", (e) => expect(isDeviceLossError(e)).toBe(false));
});

describe("createSessionRecovery", () => {
	it("passes the requested backend through until a loss", () => {
		const r = createSessionRecovery();
		expect(r.backendFor("webgpu")).toBe("webgpu");
		expect(r.backendFor(undefined)).toBeUndefined();
		expect(r.deviceLost).toBe(false);
	});

	it("ignores unrelated failures", () => {
		const r = createSessionRecovery();
		expect(r.noteFailure(new Error("Session already started"))).toBe(false);
		expect(r.deviceLost).toBe(false);
	});

	it("the first loss asks for a drop exactly once and pins everything to wasm", () => {
		const r = createSessionRecovery();
		expect(r.noteFailure(new Error("Device is lost"))).toBe(true);
		expect(r.noteFailure(new Error("Device is lost"))).toBe(false);
		expect(r.deviceLost).toBe(true);
		expect(r.backendFor("webgpu")).toBe("wasm");
		expect(r.backendFor(undefined)).toBe("wasm");
		expect(r.backendFor("wasm")).toBe("wasm");
	});
});
