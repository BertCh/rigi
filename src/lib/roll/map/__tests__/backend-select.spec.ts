// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import {
	failBackend,
	initialBackendState,
	rendererAttrFor,
	rollBackendFor,
} from "../backend-select";

describe("roll backend selection", () => {
	it("maps the resolved renderer to a backend", () => {
		expect(rollBackendFor({ renderer: "webgpu", reason: "pinned" })).toBe(
			"webgpu",
		);
		expect(rollBackendFor({ renderer: "deck", reason: "pinned" })).toBe(
			"webgl",
		);
		expect(rendererAttrFor("webgpu")).toBe("webgpu");
		expect(rendererAttrFor("webgl")).toBe("deck");
	});

	it("keeps the renderer reason at start", () => {
		const s = initialBackendState({ renderer: "webgpu", reason: "auto: x" });
		expect(s).toEqual({ kind: "webgpu", reason: "auto: x", fellBack: false });
	});

	it("falls back to webgl once with the reason, then stays", () => {
		const s0 = initialBackendState({ renderer: "webgpu", reason: "pinned" });
		const s1 = failBackend(s0, new Error("WebGPU device lost: x"));
		expect(s1).toEqual({
			kind: "webgl",
			reason: "fallback: WebGPU device lost: x",
			fellBack: true,
		});
		expect(failBackend(s1, new Error("again"))).toBe(s1);
	});

	it("does nothing when already on webgl", () => {
		const s = initialBackendState({ renderer: "deck", reason: "webgpu=off" });
		expect(failBackend(s, "boom")).toBe(s);
	});
});
