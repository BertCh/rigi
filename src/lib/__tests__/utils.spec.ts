// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { cn } from "../utils";

describe("cn", () => {
	it("joins class names and drops falsy values", () => {
		expect(cn("a", false && "b", null, undefined, "c")).toBe("a c");
	});
	it("flattens arrays and object maps (clsx)", () => {
		expect(cn(["a", ["b"]], { c: true, d: false })).toBe("a b c");
	});
	it("lets a later Tailwind utility win over a conflicting earlier one", () => {
		expect(cn("p-2 text-sm", "p-4")).toBe("text-sm p-4");
		expect(cn("text-red-500", "text-blue-500")).toBe("text-blue-500");
	});
	it("keeps non-conflicting utilities", () => {
		expect(cn("px-2", "py-4")).toBe("px-2 py-4");
	});
	it("returns an empty string for no input", () => {
		expect(cn()).toBe("");
	});
});
