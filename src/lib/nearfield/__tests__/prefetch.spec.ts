// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { prefetchAllowed } from "../prefetch";

describe("nearfield prefetch policy", () => {
	it("allows without connection info and on fast links", () => {
		expect(prefetchAllowed(undefined)).toBe(true);
		expect(prefetchAllowed({ effectiveType: "4g" })).toBe(true);
		expect(prefetchAllowed({})).toBe(true);
	});

	it("skips save-data and slow links", () => {
		expect(prefetchAllowed({ saveData: true, effectiveType: "4g" })).toBe(
			false,
		);
		for (const t of ["slow-2g", "2g", "3g"])
			expect(prefetchAllowed({ effectiveType: t })).toBe(false);
	});
});
