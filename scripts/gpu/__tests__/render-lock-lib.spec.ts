// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { isStaleOwner } from "../render-lock-lib.mjs";

describe("isStaleOwner", () => {
	it("never reclaims a live owner when the current start time is unknown", () => {
		expect(
			isStaleOwner({ pid: 42, alive: true, recorded: "Mon 1", current: "" }),
		).toBe(false);
	});
	it("reclaims a recycled pid whose start time differs", () => {
		expect(
			isStaleOwner({
				pid: 42,
				alive: true,
				recorded: "Mon 1",
				current: "Tue 2",
			}),
		).toBe(true);
	});
	it("keeps a live owner whose start time matches", () => {
		expect(
			isStaleOwner({
				pid: 42,
				alive: true,
				recorded: "Mon 1",
				current: "Mon 1",
			}),
		).toBe(false);
	});
	it("reclaims a dead owner whatever the start times", () => {
		expect(
			isStaleOwner({ pid: 42, alive: false, recorded: "", current: "" }),
		).toBe(true);
		expect(
			isStaleOwner({
				pid: 42,
				alive: false,
				recorded: "Mon 1",
				current: "Mon 1",
			}),
		).toBe(true);
	});
	it("falls back to the pid-only check without a recorded start", () => {
		expect(
			isStaleOwner({ pid: 42, alive: true, recorded: "", current: "Tue 2" }),
		).toBe(false);
	});
});
