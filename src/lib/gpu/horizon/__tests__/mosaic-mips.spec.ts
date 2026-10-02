// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import {
	buildMips,
	MIP_MAX_LEVEL,
	MIP_MIN_LEVEL,
	type Mosaic,
} from "#/lib/horizon-fast/mosaic";
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

describe("mipDims vs the CPU pyramid", () => {
	// buildMosaic caps the top level at min(MIP_MAX_LEVEL, log2 tileSize), so a tile size below 256 builds
	// fewer levels than the defaults here (intentional); for T >= 256 the cap is MIP_MAX_LEVEL, which is
	// what the GPU path uses, so those are the sizes compared.
	for (const T of [256, 512, 1024]) {
		for (const [w, h] of [
			[T, T],
			[T + 1, T - 1],
			[2 * T - 3, 700],
			[1000, 333],
		]) {
			it(`T ${T}, window ${w} x ${h}`, () => {
				const maxLevel = Math.min(MIP_MAX_LEVEL, Math.log2(T) | 0);
				expect(maxLevel).toBe(MIP_MAX_LEVEL);
				const cpu = buildMips({
					data: new Float32Array(w * h),
					width: w,
					height: h,
				} as Mosaic);
				const gpu = mipDims(w, h);
				expect(gpu.minLevel).toBe(cpu.minLevel);
				expect(gpu.widths).toEqual(cpu.widths);
				expect(gpu.heights).toEqual(cpu.heights);
			});
		}
	}
});
