// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { fusedGraphKey } from "#/lib/gpu/sky/fused-graph";
import { canFuse, type FusedEligibility, MAX_FUSED_ERRORS } from "../fused";

const steady: FusedEligibility = {
	refine: true,
	forceFallback: undefined,
	modelLongSide: undefined,
	hasBitmap: true,
	modelBackend: "webgpu",
	sameDevice: true,
	prepVerified: true,
	fusedErrors: 0,
};

describe("canFuse", () => {
	it("takes the steady state", () => {
		expect(canFuse(steady)).toBe(true);
	});
	it.each([
		["no refine", { refine: false }],
		["refine unset", { refine: undefined }],
		["forced fallback", { forceFallback: true }],
		["model long side override", { modelLongSide: 384 }],
		["no bitmap (CPU pixels)", { hasBitmap: false }],
		["cpu model", { modelBackend: "cpu" }],
		["model on another device", { sameDevice: false }],
		["prep not verified or disabled", { prepVerified: false }],
		["too many fused errors", { fusedErrors: MAX_FUSED_ERRORS }],
	])("falls back to the three steps: %s", (_, patch) => {
		expect(canFuse({ ...steady, ...patch })).toBe(false);
	});
	it("tolerates fewer errors than the cap", () => {
		expect(canFuse({ ...steady, fusedErrors: MAX_FUSED_ERRORS - 1 })).toBe(
			true,
		);
	});
});

describe("fusedGraphKey", () => {
	it("separates shape, model size, radius and model identity", () => {
		const base = fusedGraphKey(1024, 768, 512, 384, 3, "m1");
		expect(fusedGraphKey(1024, 768, 512, 384, 3, "m1")).toBe(base);
		for (const other of [
			fusedGraphKey(768, 1024, 512, 384, 3, "m1"),
			fusedGraphKey(1024, 768, 384, 288, 3, "m1"),
			fusedGraphKey(1024, 768, 512, 384, 4, "m1"),
			fusedGraphKey(1024, 768, 512, 384, 3, "m2"),
		])
			expect(other).not.toBe(base);
	});
});
