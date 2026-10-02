// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { reliefGradientShape, reliefWords } from "../relief";
import { defaultGradientShape, reliefScratchBytes } from "../relief-graph";

describe("relief gradient shape", () => {
	for (const res of [64, 256, 512, 1024, 2048]) {
		it(`is read back from reliefWords at res ${res}`, () => {
			const px = 40000 / res;
			const { words } = reliefWords(res, px, [0.9, 0.3, 0.2]);
			expect(reliefGradientShape(words)).toEqual(defaultGradientShape(res));
		});
	}
	it("uses a ring radius of 2 texels at the app's 1024 grid, 1 below", () => {
		expect(defaultGradientShape(1024).ra).toBe(2);
		expect(defaultGradientShape(512).ra).toBe(1);
	});
	it("sizes the phase planes and gradients to cover every texel once (padded to ceil(res / ra))", () => {
		for (const [res, ra] of [
			[1024, 2],
			[2048, 3],
			[64, 1],
		] as const) {
			const bytes = reliefScratchBytes(res, { ra });
			const cells = ra * ra * Math.ceil(res / ra) ** 2;
			expect(bytes.phase).toBe(cells * 4);
			expect(bytes.grad).toBe(cells * 8);
			expect(cells).toBeGreaterThanOrEqual(res * res);
		}
	});
});
