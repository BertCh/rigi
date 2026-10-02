// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { liveStepOnMessage, liveStepUnavailableReason } from "../liveStep";

describe("liveStepUnavailableReason", () => {
	it("is available on the WebGPU engine with setNearFieldLive", () => {
		expect(
			liveStepUnavailableReason("webgpu", {
				onRender: () => () => {},
				setNearFieldLive: () => {},
			}),
		).toBeNull();
	});
	it("is available on the WebGL2 engine at a low rate when a compute device exists", () => {
		const host = { onRender: () => () => {}, setNearField: () => {} };
		expect(liveStepUnavailableReason("deck", host, true)).toBeNull();
		expect(liveStepOnMessage(host)).toMatch(/low rate/);
		expect(liveStepOnMessage({ setNearFieldLive: () => {} })).not.toMatch(
			/low rate/,
		);
	});
	it("explains a WebGL2 engine without WebGPU compute", () => {
		expect(
			liveStepUnavailableReason(
				"deck",
				{ onRender: () => () => {}, setNearField: () => {} },
				false,
			),
		).toMatch(/WebGPU/);
	});
});
