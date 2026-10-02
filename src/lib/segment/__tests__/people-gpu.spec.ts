// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import {
	dilationRadius,
	MASK_LONG_SIDE,
	maskSize,
	toByteMask,
} from "../people-gpu";

describe("people-gpu helpers", () => {
	it("sizes the working copy to the long side, keeping aspect", () => {
		expect(maskSize(1024, 768)).toEqual({ w: MASK_LONG_SIDE, h: 384 });
		expect(maskSize(768, 1024)).toEqual({ w: 384, h: MASK_LONG_SIDE });
		expect(maskSize(4000, 1)).toEqual({ w: MASK_LONG_SIDE, h: 1 });
	});
	it("dilates by 1% of the width, at least one pixel", () => {
		expect(dilationRadius(512)).toBe(5);
		expect(dilationRadius(384)).toBe(4);
		expect(dilationRadius(20)).toBe(1);
	});
	it("rounds and clamps 0..255 floats to bytes", () => {
		expect([
			...toByteMask([0, 0.4, 0.5, 127.5, 254.6, 255, 256.2, -3]),
		]).toEqual([0, 0, 1, 128, 255, 255, 255, 0]);
	});
});
