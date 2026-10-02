// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { defineScript, stepTime } from "../viz/script";
import { useScript } from "../viz/useScript";

const SCRIPT = defineScript([
	{ id: "guess", kind: "setup", dur: 1 },
	{ id: "turn", kind: "change", dur: 2 },
	{ id: "done", kind: "result", dur: 1 },
]);

describe("useScript", () => {
	// happy-dom reports navigator.webdriver, the harness case: the figure is static
	it("shows the settled result frame under automation and never plays", () => {
		const { result } = renderHook(() => useScript(SCRIPT));
		expect(result.current.still).toBe(true);
		expect(result.current.t).toBe(SCRIPT.settle);
		expect(result.current.beat.beat.id).toBe("done");
		expect(result.current.beat.settled).toBe(true);
		expect(result.current.playing).toBe(false);
	});

	it("lets a static reader step: each step shows its own beat, finished", () => {
		const { result } = renderHook(() => useScript(SCRIPT));
		for (const i of [0, 1, 2]) {
			act(() => result.current.seek(i));
			expect(result.current.manual).toBe(true);
			expect(result.current.beat.index).toBe(i);
			expect(result.current.beat.u).toBeGreaterThan(0.99);
		}
	});

	it("play keeps the static frame on the result", () => {
		const { result } = renderHook(() => useScript(SCRIPT));
		act(() => result.current.play());
		expect(result.current.t).toBe(SCRIPT.settle);
	});
});

describe("stepTime (the stepper's targets)", () => {
	it("lands each step on its beat's finished picture", () => {
		expect([0, 1, 2].map((i) => stepTime(SCRIPT, i))).toEqual([1, 3, 4]);
	});
});
