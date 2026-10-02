// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { isLowConfidence, MIN_CONFIDENCE } from "../confidence";

describe("isLowConfidence (fail closed)", () => {
	it("is LOW for missing input", () => {
		expect(isLowConfidence(null)).toBe(true);
		expect(isLowConfidence(undefined)).toBe(true);
		expect(isLowConfidence({})).toBe(true);
	});
	it("is LOW when explicitly rejected or low-level, whatever the confidence", () => {
		expect(isLowConfidence({ level: "low", confidence: 0.99 })).toBe(true);
		expect(
			isLowConfidence({ accepted: false, confidence: 0.99, level: "high" }),
		).toBe(true);
	});
	it("uses the confidence threshold inclusively", () => {
		expect(isLowConfidence({ confidence: MIN_CONFIDENCE })).toBe(false);
		expect(isLowConfidence({ confidence: MIN_CONFIDENCE - 1e-9 })).toBe(true);
		expect(isLowConfidence({ level: "high", confidence: 0.3 })).toBe(true);
		expect(isLowConfidence({ level: "medium", confidence: 0.8 })).toBe(false);
	});
	it("treats NaN confidence as LOW", () => {
		expect(isLowConfidence({ confidence: Number.NaN })).toBe(true);
		expect(isLowConfidence({ level: "high", confidence: Number.NaN })).toBe(
			true,
		);
	});
	it("a high/medium level without a number needs an explicit accept", () => {
		expect(isLowConfidence({ level: "high" })).toBe(true);
		expect(isLowConfidence({ level: "high", accepted: true })).toBe(false);
	});
	it("accepted alone is not enough without confidence or level", () => {
		expect(isLowConfidence({ accepted: true })).toBe(true);
	});
});
