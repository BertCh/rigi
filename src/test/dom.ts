// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Shared helpers for DOM specs.

import { vi } from "vitest";

/** Mock factory for "@tanstack/react-router" with a settable search string and a navigate spy. */
export const routerState = { searchStr: "" };
export const navigateSpy = vi.fn();
export function routerMock() {
	return {
		useRouterState: ({
			select,
		}: {
			select: (s: { location: { searchStr: string } }) => unknown;
		}) => select({ location: { searchStr: routerState.searchStr } }),
		useNavigate: () => navigateSpy,
	};
}
