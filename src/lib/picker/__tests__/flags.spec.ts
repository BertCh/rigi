// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { parsePickerFlag } from "../flags";

describe("parsePickerFlag", () => {
	it("is off by default and for unknown values", () => {
		expect(parsePickerFlag("")).toBe("off");
		expect(parsePickerFlag("?x=1")).toBe("off");
		expect(parsePickerFlag("?picker=maybe")).toBe("off");
	});
	it("reads on and always", () => {
		expect(parsePickerFlag("?picker=on")).toBe("on");
		expect(parsePickerFlag("?a=b&picker=always")).toBe("always");
	});
});
