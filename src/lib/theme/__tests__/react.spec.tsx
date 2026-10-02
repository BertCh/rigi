// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routerMock, routerState } from "#/test/dom";

vi.mock("@tanstack/react-router", () => routerMock());

import { THEME_STORAGE_KEY } from "../index";
import { ThemeSync, useTheme } from "../react";

let api: ReturnType<typeof useTheme>;
function Probe() {
	api = useTheme();
	return (
		<span data-testid="v">
			{api.choice}/{api.resolved}
		</span>
	);
}

beforeEach(() => {
	localStorage.clear();
	routerState.searchStr = "";
	document.documentElement.removeAttribute("data-theme");
	vi.stubGlobal("matchMedia", () => ({
		matches: false,
		addEventListener() {},
		removeEventListener() {},
	}));
});
afterEach(cleanup);

describe("useTheme", () => {
	it("auto + dark OS by default", () => {
		render(<Probe />);
		expect(screen.getByTestId("v").textContent).toBe("auto/dark");
	});
	it("setChoice persists and re-renders", () => {
		render(<Probe />);
		act(() => api.setChoice("light"));
		expect(screen.getByTestId("v").textContent).toBe("light/light");
		expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
		act(() => api.setChoice("auto"));
		expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
		expect(screen.getByTestId("v").textContent).toBe("auto/dark");
	});
	it("the ?theme= flag shows as the choice", () => {
		routerState.searchStr = "?theme=light";
		render(<Probe />);
		// the router search drives the choice; the resolved theme reads the page URL (none here)
		expect(api.choice).toBe("light");
	});
});

describe("ThemeSync", () => {
	it("writes data-theme on <html> and follows changes", () => {
		render(
			<>
				<ThemeSync />
				<Probe />
			</>,
		);
		expect(document.documentElement.dataset.theme).toBe("dark");
		act(() => api.setChoice("light"));
		expect(document.documentElement.dataset.theme).toBe("light");
	});
});
