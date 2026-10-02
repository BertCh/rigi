// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { liveStepUnavailableReason } from "../liveStep";

describe("liveStepUnavailableReason", () => {
	it("is available on the WebGPU engine with setNearFieldLive", () => {
		expect(
			liveStepUnavailableReason("webgpu", {
				onRender: () => () => {},
				setNearFieldLive: () => {},
			}),
		).toBeNull();
	});
	it("explains the WebGL2 engine", () => {
		expect(
			liveStepUnavailableReason("deck", { onRender: () => () => {} }),
		).toMatch(/WebGPU/);
	});
});
