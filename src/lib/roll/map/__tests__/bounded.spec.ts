// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { mapBounded } from "../bounded";

describe("mapBounded", () => {
	it("never exceeds the limit and keeps order", async () => {
		let live = 0;
		let peak = 0;
		const out = await mapBounded([5, 4, 3, 2, 1, 0], 2, async (x) => {
			peak = Math.max(peak, ++live);
			await new Promise((r) => setTimeout(r, x));
			live--;
			return x * 2;
		});
		expect(out).toEqual([10, 8, 6, 4, 2, 0]);
		expect(peak).toBe(2);
	});
	it("handles empty input", async () => {
		expect(await mapBounded([], 3, async (x) => x)).toEqual([]);
	});
});
