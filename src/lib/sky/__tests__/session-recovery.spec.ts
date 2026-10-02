// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { isDeviceLossError } from "../session-recovery";

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
