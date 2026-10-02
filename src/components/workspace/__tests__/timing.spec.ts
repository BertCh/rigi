// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { afterEach, describe, expect, it, vi } from "vitest";
import { markWorkspace, workspaceTimings } from "../timing";

afterEach(() => {
	vi.unstubAllGlobals();
	performance.clearMarks();
});

describe("markWorkspace", () => {
	it("records phases in order with their detail", () => {
		const a = markWorkspace("start");
		const b = markWorkspace("first-overlay");
		const c = markWorkspace("certified", { verdict: "verified" });
		expect(a).not.toBeNull();
		expect(b as number).toBeGreaterThanOrEqual(a as number);
		expect(c as number).toBeGreaterThanOrEqual(b as number);
		const t = workspaceTimings();
		expect(Object.keys(t).sort()).toEqual(
			["certified", "first-overlay", "start"].sort(),
		);
		const [m] = performance.getEntriesByName(
			"photo-workspace:certified",
			"mark",
		);
		expect((m as PerformanceMark).detail).toEqual({ verdict: "verified" });
	});

	it("a new start clears the previous photo's marks", () => {
		markWorkspace("start");
		markWorkspace("engine");
		markWorkspace("certified");
		markWorkspace("start");
		const t = workspaceTimings();
		expect(t.start).toBeTypeOf("number");
		expect(t.engine).toBeUndefined();
		expect(t.certified).toBeUndefined();
		expect(performance.getEntriesByName("photo-workspace:start")).toHaveLength(
			1,
		);
	});

	it("never throws without User Timing", () => {
		vi.stubGlobal("performance", undefined);
		expect(markWorkspace("start")).toBeNull();
		expect(workspaceTimings()).toEqual({});
		vi.stubGlobal("performance", {
			mark: () => {
				throw new Error("nope");
			},
		});
		expect(markWorkspace("engine")).toBeNull();
	});
});
