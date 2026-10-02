// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { expectArrayClose } from "#/test/helpers";
import {
	hazeColorAsRendered,
	hexToLinearLikeThree,
	hexToRgb01,
	hexToRgba01,
	isHex,
	srgbToLinear,
	toCss,
	toHexString,
} from "../color";

describe("isHex", () => {
	it("accepts #rrggbb and #rrggbbaa", () => {
		expect(isHex("#a1B2c3")).toBe(true);
		expect(isHex("#a1b2c3d4")).toBe(true);
	});
	it("rejects shorthand, missing hash and non-hex digits", () => {
		for (const bad of ["#abc", "a1b2c3", "#gggggg", "#a1b2c", "", "#a1b2c3d"])
			expect(isHex(bad)).toBe(false);
	});
	it("accepts finite 3 or 4 number tuples only", () => {
		expect(isHex([0, 0.5, 1])).toBe(true);
		expect(isHex([0, 0.5, 1, 0.2])).toBe(true);
		expect(isHex([0, 1])).toBe(false);
		expect(isHex([0, 1, Number.NaN])).toBe(false);
		expect(isHex([0, 1, 2, 3, 4])).toBe(false);
		expect(isHex(["a", "b", "c"])).toBe(false);
		expect(isHex(null)).toBe(false);
		expect(isHex(12)).toBe(false);
	});
});

describe("hexToRgba01", () => {
	it("decodes bytes to 0..1 with alpha defaulting to 1", () => {
		expect(hexToRgba01("#000000")).toEqual([0, 0, 0, 1]);
		expect(hexToRgba01("#ffffff")).toEqual([1, 1, 1, 1]);
		expectArrayClose(hexToRgba01("#ff8000"), [1, 128 / 255, 0, 1]);
	});
	it("reads the alpha byte", () => {
		expectArrayClose(hexToRgba01("#00000080"), [0, 0, 0, 128 / 255]);
	});
	it("passes float tuples through exactly", () => {
		expect(hexToRgba01([0.1, 0.2, 0.3])).toEqual([0.1, 0.2, 0.3, 1]);
		expect(hexToRgba01([0.1, 0.2, 0.3, 0.4])).toEqual([0.1, 0.2, 0.3, 0.4]);
		expect(hexToRgb01([0.1, 0.2, 0.3, 0.4])).toEqual([0.1, 0.2, 0.3]);
	});
});

describe("toHexString / toCss", () => {
	it("round-trips every byte value", () => {
		for (let v = 0; v < 256; v++) {
			const hex = `#${v.toString(16).padStart(2, "0")}${(255 - v).toString(16).padStart(2, "0")}7f`;
			expect(toHexString(hex as `#${string}`)).toBe(hex);
		}
	});
	it("omits alpha when opaque or when asked", () => {
		expect(toHexString([1, 0, 0])).toBe("#ff0000");
		expect(toHexString([1, 0, 0, 1])).toBe("#ff0000");
		expect(toHexString([1, 0, 0, 0.5])).toBe("#ff000080");
		expect(toHexString([1, 0, 0, 0.5], false)).toBe("#ff0000");
	});
	it("clamps out-of-range floats", () => {
		expect(toHexString([2, -1, 0.5])).toBe("#ff0080");
		expect(toCss([2, -1, 0.5])).toBe("rgb(255,0,128)");
	});
	it("keeps float alphas exact in CSS", () => {
		expect(toCss([1, 1, 1, 0.75])).toBe("rgba(255,255,255,0.75)");
		expect(toCss("#ffffff")).toBe("rgb(255,255,255)");
	});
});

describe("srgb transfer", () => {
	it("known answers", () => {
		expect(srgbToLinear(0)).toBe(0);
		expect(srgbToLinear(1)).toBeCloseTo(1, 12);
		expect(srgbToLinear(0.5)).toBeCloseTo(0.21404114, 7);
		// linear toe
		expect(srgbToLinear(0.04)).toBeCloseTo(0.04 / 12.92, 12);
	});
	it("is monotone and continuous across the toe", () => {
		let prev = -1;
		for (let x = 0; x <= 1; x += 0.001) {
			const y = srgbToLinear(x);
			expect(y).toBeGreaterThan(prev);
			prev = y;
		}
		expect(
			Math.abs(srgbToLinear(0.04045) - srgbToLinear(0.040451)),
		).toBeLessThan(1e-5);
	});
	it("haze colour double-linearises as documented", () => {
		const lin = hexToLinearLikeThree("#808080");
		const out = hazeColorAsRendered("#808080");
		for (let i = 0; i < 3; i++) expect(out[i]).toBeCloseTo(lin[i] ** 2.2, 12);
		expect(hazeColorAsRendered("#ffffff")).toEqual([1, 1, 1]);
		expect(hazeColorAsRendered("#000000")).toEqual([0, 0, 0]);
	});
});
