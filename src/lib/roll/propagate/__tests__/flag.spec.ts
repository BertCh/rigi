// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { withFlags } from "#/test/helpers";
import { propagateMode } from "../flag";

describe("propagateMode", () => {
	it("is off by default", () => {
		expect(propagateMode()).toBe("off");
	});
	it.each(["on", "dev", "off"])("reads ?propagate=%s", (v) => {
		withFlags({ propagate: v });
		expect(propagateMode()).toBe(v);
	});
	it("falls back to off for an unknown value", () => {
		withFlags({ propagate: "banana" });
		expect(propagateMode()).toBe("off");
	});
});
