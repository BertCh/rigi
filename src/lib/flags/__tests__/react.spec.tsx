// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { routerMock, routerState } from "#/test/dom";

vi.mock("@tanstack/react-router", () => routerMock());

import { useFlag } from "../react";

function Probe() {
	return <span data-testid="v">{useFlag("theme")}</span>;
}

afterEach(() => {
	cleanup();
	routerState.searchStr = "";
});

describe("useFlag", () => {
	it("defaults when the URL has no flag", () => {
		render(<Probe />);
		expect(screen.getByTestId("v").textContent).toBe("auto");
	});
	it("reads the router search string", () => {
		routerState.searchStr = "?theme=light";
		render(<Probe />);
		expect(screen.getByTestId("v").textContent).toBe("light");
	});
	it("ignores invalid values", () => {
		routerState.searchStr = "?theme=purple";
		render(<Probe />);
		expect(screen.getByTestId("v").textContent).toBe("auto");
	});
	it("prefers a per-realm override over the URL", () => {
		routerState.searchStr = "?theme=light";
		(globalThis as { __RIGI_FLAGS__?: unknown }).__RIGI_FLAGS__ = {
			theme: "dark",
		};
		render(<Probe />);
		expect(screen.getByTestId("v").textContent).toBe("dark");
	});
});
