// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { MIP_MAX_LEVEL, MIP_MIN_LEVEL } from "#/lib/horizon-fast/mosaic";
import { mipDims } from "../mosaic-mips";

describe("mipDims", () => {
	it("defaults to the CPU buildMips levels", () => {
		const d = mipDims(1000, 500);
		expect(d.minLevel).toBe(MIP_MIN_LEVEL);
		expect(d.widths.length).toBe(MIP_MAX_LEVEL - MIP_MIN_LEVEL + 1);
		expect(d.heights.length).toBe(d.widths.length);
	});
	it("ceil-divides by 2^level", () => {
		const d = mipDims(1000, 500, 2, 4);
		expect(d.widths).toEqual([250, 125, 63]);
		expect(d.heights).toEqual([125, 63, 32]);
	});
	it("never reaches zero for small mosaics", () => {
		const d = mipDims(1, 1, 2, 8);
		expect(d.widths.every((w) => w === 1)).toBe(true);
	});
});
