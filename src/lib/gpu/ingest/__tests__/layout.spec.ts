// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import {
	bufferByteLength,
	bytesPerTexel,
	copyBytesPerRow,
	isCopyAligned,
	rasterFormatOf,
	rasterLength,
	texelWorkgroups,
} from "../layout";

describe("rasterFormatOf", () => {
	it("maps typed array kind and band count to a format", () => {
		expect(rasterFormatOf(new Float32Array(1))).toBe("r32float");
		expect(rasterFormatOf(new Float32Array(1), 2)).toBe("rg32float");
		expect(rasterFormatOf(new Float32Array(1), 4)).toBe("rgba32float");
		expect(rasterFormatOf(new Uint16Array(1))).toBe("r16uint");
		expect(rasterFormatOf(new Int16Array(1))).toBe("r16sint");
		expect(rasterFormatOf(new Uint32Array(1))).toBe("r32uint");
		expect(rasterFormatOf(new Int32Array(1))).toBe("r32sint");
	});
	it("treats Uint8 as normalised unless integer is requested", () => {
		expect(rasterFormatOf(new Uint8Array(1))).toBe("r8unorm");
		expect(rasterFormatOf(new Uint8ClampedArray(4), 4)).toBe("rgba8unorm");
		expect(rasterFormatOf(new Uint8Array(1), 1, true)).toBe("r8uint");
		expect(rasterFormatOf(new Uint8Array(4), 4, true)).toBe("rgba8uint");
	});
	it("throws for unsupported combinations", () => {
		expect(() => rasterFormatOf(new Uint16Array(1), 2)).toThrow(
			/no texture format/,
		);
		expect(() => rasterFormatOf(new Uint8Array(1), 2, true)).toThrow(/integer/);
	});
});

describe("sizes and alignment", () => {
	it("bytesPerTexel", () => {
		expect(bytesPerTexel("r8unorm")).toBe(1);
		expect(bytesPerTexel("r16sint")).toBe(2);
		expect(bytesPerTexel("rgba8unorm-srgb")).toBe(4);
		expect(bytesPerTexel("rgba32float")).toBe(16);
	});
	it("rasterLength multiplies bands and layers", () => {
		expect(rasterLength(4, 3)).toBe(12);
		expect(rasterLength(4, 3, 4, 2)).toBe(96);
	});
	it("copyBytesPerRow rounds up to 256", () => {
		expect(copyBytesPerRow(1, "r8unorm")).toBe(256);
		expect(copyBytesPerRow(256, "r8unorm")).toBe(256);
		expect(copyBytesPerRow(257, "r8unorm")).toBe(512);
		expect(copyBytesPerRow(100, "rgba8unorm")).toBe(512);
		expect(copyBytesPerRow(256, "r32float")).toBe(1024);
	});
	it("isCopyAligned is true for DEM tile sizes, false for odd widths", () => {
		expect(isCopyAligned(256, "r32float")).toBe(true);
		expect(isCopyAligned(512, "rgba8unorm")).toBe(true);
		expect(isCopyAligned(100, "rgba8unorm")).toBe(false);
		expect(isCopyAligned(64, "r32float")).toBe(true);
		expect(isCopyAligned(63, "r32float")).toBe(false);
	});
	it("bufferByteLength pads to 4 bytes with a 4-byte floor", () => {
		expect(bufferByteLength(0)).toBe(4);
		expect(bufferByteLength(1)).toBe(4);
		expect(bufferByteLength(4)).toBe(4);
		expect(bufferByteLength(5)).toBe(8);
	});
	it("texelWorkgroups ceilings per axis", () => {
		expect(texelWorkgroups(256, 256)).toEqual([32, 32]);
		expect(texelWorkgroups(257, 1)).toEqual([33, 1]);
		expect(texelWorkgroups(10, 10, 4)).toEqual([3, 3]);
	});
});
