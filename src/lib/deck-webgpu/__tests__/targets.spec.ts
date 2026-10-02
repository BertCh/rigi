// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import {
	applyColorTargetFormat,
	colorPassBytes,
	geometrySize,
	getColorTargetFormat,
	TARGET_FORMATS,
	USAGE,
} from "../targets";

const deviceWith = (...features: string[]) =>
	({ features: new Set(features) }) as never;

describe("geometrySize", () => {
	it("pins the long side and rounds the short one", () => {
		expect(geometrySize(1)).toEqual({ width: 1024, height: 1024 });
		expect(geometrySize(1.5)).toEqual({ width: 1024, height: 683 });
		expect(geometrySize(0.5)).toEqual({ width: 512, height: 1024 });
		expect(geometrySize(2, 100)).toEqual({ width: 100, height: 50 });
	});
	it("never returns a zero side", () => {
		expect(geometrySize(10000, 1024).height).toBe(1);
		expect(geometrySize(0.0001, 1024).width).toBe(1);
	});
});

describe("colour target format", () => {
	it("honours rg11b10 only when the device is renderable for it", () => {
		expect(applyColorTargetFormat(deviceWith(), "rg11b10")).toBe("rgba16float");
		expect(
			applyColorTargetFormat(deviceWith("rg11b10ufloat-renderable"), "rg11b10"),
		).toBe("rg11b10ufloat");
		expect(getColorTargetFormat()).toBe("rg11b10ufloat");
		expect(
			applyColorTargetFormat(deviceWith("rg11b10ufloat-renderable"), "rgba16"),
		).toBe("rgba16float");
	});
	it("TARGET_FORMATS follow it, and rg11b10 loses STORAGE on the resolve", () => {
		applyColorTargetFormat(deviceWith("rg11b10ufloat-renderable"), "rg11b10");
		expect(TARGET_FORMATS.colorMS.format).toBe("rg11b10ufloat");
		expect(TARGET_FORMATS.color.usage & USAGE.STORAGE).toBe(0);
		expect(TARGET_FORMATS.color.usage & USAGE.SAMPLE).toBe(USAGE.SAMPLE);
		applyColorTargetFormat(deviceWith(), "rgba16");
		expect(TARGET_FORMATS.color.usage & USAGE.STORAGE).toBe(USAGE.STORAGE);
	});
});

describe("colorPassBytes", () => {
	it("counts MSAA samples plus the resolve", () => {
		expect(colorPassBytes(100, 100, "rgba16float")).toBe(100 * 100 * 8 * 5);
		expect(colorPassBytes(100, 100, "rg11b10ufloat")).toBe(100 * 100 * 4 * 5);
		expect(colorPassBytes(10, 10, "rgba16float", 1)).toBe(10 * 10 * 8 * 2);
	});
});
