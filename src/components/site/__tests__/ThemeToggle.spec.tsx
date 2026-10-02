// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { navigateSpy, routerMock, routerState } from "#/test/dom";

vi.mock("@tanstack/react-router", () => routerMock());

import { THEME_STORAGE_KEY } from "#/lib/theme";
import { ThemeToggle } from "../ThemeToggle";

beforeEach(() => {
	localStorage.clear();
	routerState.searchStr = "";
	navigateSpy.mockReset();
	vi.stubGlobal("matchMedia", () => ({
		matches: false,
		addEventListener() {},
		removeEventListener() {},
	}));
});
afterEach(cleanup);

describe("ThemeToggle", () => {
	it("cycles auto, light, dark, auto", () => {
		render(<ThemeToggle />);
		const btn = () => screen.getByTestId("theme-toggle");
		expect(btn().title).toBe("Theme: follow system");
		fireEvent.click(btn());
		expect(btn().title).toBe("Theme: light");
		expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
		fireEvent.click(btn());
		expect(btn().title).toBe("Theme: dark");
		fireEvent.click(btn());
		expect(btn().title).toBe("Theme: follow system");
		expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
	});
	it("labels the next state for assistive tech", () => {
		render(<ThemeToggle />);
		expect(screen.getByRole("button").getAttribute("aria-label")).toContain(
			"click for light",
		);
	});
	it("does not navigate without a ?theme= flag", () => {
		render(<ThemeToggle />);
		fireEvent.click(screen.getByRole("button"));
		expect(navigateSpy).not.toHaveBeenCalled();
	});
	it("clears an explicit ?theme= from the URL", () => {
		(globalThis as { __RIGI_FLAGS__?: unknown }).__RIGI_FLAGS__ = {
			theme: "dark",
		};
		render(<ThemeToggle />);
		act(() => {
			fireEvent.click(screen.getByRole("button"));
		});
		expect(navigateSpy).toHaveBeenCalledTimes(1);
		const arg = navigateSpy.mock.calls[0][0];
		expect(arg.replace).toBe(true);
		expect(arg.search({ a: 1, theme: "dark" })).toEqual({
			a: 1,
			theme: undefined,
		});
	});
});
