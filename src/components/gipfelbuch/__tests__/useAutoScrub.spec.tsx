// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoScrub } from "../viz/hooks";

const setWebdriver = (on: boolean) =>
	Object.defineProperty(navigator, "webdriver", {
		value: on,
		configurable: true,
	});

describe("useAutoScrub", () => {
	beforeEach(() => {
		vi.useFakeTimers({
			toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance"],
		});
		vi.stubGlobal("matchMedia", (q: string) => ({
			matches: false,
			media: q,
			addEventListener: () => {},
			removeEventListener: () => {},
		}));
		setWebdriver(false);
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
		setWebdriver(false);
	});

	it("plays between min and max, then holds a manual value until resumed", () => {
		const { result } = renderHook(() =>
			useAutoScrub({ min: 0, max: 10, period: 1000 }),
		);
		expect(result.current.isManual).toBe(false);
		act(() => {
			vi.advanceTimersByTime(250);
		});
		expect(result.current.value).toBeGreaterThan(0);
		expect(result.current.value).toBeLessThan(10);
		act(() => result.current.setManual(7));
		expect(result.current.isManual).toBe(true);
		act(() => {
			vi.advanceTimersByTime(600);
		});
		expect(result.current.value).toBe(7);
		act(() => result.current.resume());
		expect(result.current.isManual).toBe(false);
		expect(result.current.value).toBe(7);
	});

	it("holds the still value under webdriver", () => {
		setWebdriver(true);
		const { result } = renderHook(() =>
			useAutoScrub({ min: 0, max: 10, period: 1000, still: 8 }),
		);
		act(() => {
			vi.advanceTimersByTime(500);
		});
		expect(result.current.value).toBe(8);
		act(() => result.current.setManual(2));
		expect(result.current.value).toBe(2);
	});
});
