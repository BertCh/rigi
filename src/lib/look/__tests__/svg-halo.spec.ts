// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { CLASSIC } from "../../style/defaults";
import { svgHaloWidth } from "../labels/css";

describe("svgHaloWidth", () => {
	const halo = CLASSIC.labels.halo;
	it("a stroke halo keeps its own width at any size", () => {
		const stroke = { ...halo, kind: "stroke" as const, strokePx: 3 };
		expect(svgHaloWidth(stroke, 10)).toBe(3);
		expect(svgHaloWidth(stroke, 40)).toBe(3);
	});
	it("a shadow halo grows with the type, never below 2.5 px", () => {
		const shadow = { ...halo, kind: "shadow" as const };
		expect(svgHaloWidth(shadow, 8)).toBe(2.5);
		expect(svgHaloWidth(shadow, 20)).toBeCloseTo(3.8);
	});
	it("'none' draws no halo", () => {
		expect(svgHaloWidth({ ...halo, kind: "none" }, 20)).toBe(0);
	});
});
