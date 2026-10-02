// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { NeedPixels, PREP_VERIFY, prepGate, prepStatus } from "../prep";

describe("prepGate", () => {
	it("a translucent photo always takes the CPU path", () => {
		expect(prepGate(false, 0, true)).toBe("cpu");
		expect(prepGate(false, 1000, true)).toBe("cpu");
	});
	it("verifies the first PREP_VERIFY opaque photos when CPU pixels are present", () => {
		for (let v = 0; v < PREP_VERIFY; v++)
			expect(prepGate(true, v, true)).toBe("verify");
	});
	it("asks for pixels when verification is due but none were sent", () => {
		expect(prepGate(true, 0, false)).toBe("need-pixels");
		expect(prepGate(true, PREP_VERIFY - 1, false)).toBe("need-pixels");
	});
	it("trusts the GPU once verified, with or without pixels", () => {
		expect(prepGate(true, PREP_VERIFY, false)).toBe("gpu");
		expect(prepGate(true, PREP_VERIFY + 5, true)).toBe("gpu");
	});
});

describe("prepStatus", () => {
	it("without a device reports nothing verified", () => {
		expect(prepStatus(null, "cpu")).toEqual({
			on: "cpu",
			verified: 0,
			disabled: undefined,
		});
		expect(prepStatus(undefined, "gpu").verified).toBe(0);
	});
	it("an unseen device is unverified and enabled", () => {
		const s = prepStatus({} as never, "gpu");
		expect(s).toEqual({ on: "gpu", verified: 0, disabled: undefined });
	});
});

describe("NeedPixels", () => {
	it("is an Error with a stable message", () => {
		const e = new NeedPixels();
		expect(e).toBeInstanceOf(Error);
		expect(e.message).toMatch(/RGBA pixels needed/);
	});
});
