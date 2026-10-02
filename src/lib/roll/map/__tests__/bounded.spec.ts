// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { mapBounded } from "../bounded";

describe("mapBounded", () => {
	it("keeps input order and passes the index", async () => {
		const out = await mapBounded([5, 6, 7, 8], 2, async (x, i) => {
			await new Promise((r) => setTimeout(r, (4 - i) * 3));
			return `${i}:${x}`;
		});
		expect(out).toEqual(["0:5", "1:6", "2:7", "3:8"]);
	});
	it("never runs more than `limit` at once", async () => {
		let running = 0;
		let peak = 0;
		await mapBounded(
			Array.from({ length: 12 }, (_, i) => i),
			3,
			async () => {
				peak = Math.max(peak, ++running);
				await new Promise((r) => setTimeout(r, 2));
				running--;
			},
		);
		expect(peak).toBe(3);
	});
	it("handles an empty list and a limit of zero", async () => {
		expect(await mapBounded([], 4, async (x) => x)).toEqual([]);
		expect(await mapBounded([1, 2], 0, async (x) => x * 2)).toEqual([2, 4]);
	});
	it("rejects when a task rejects", async () => {
		await expect(
			mapBounded([1, 2, 3], 2, async (x) => {
				if (x === 2) throw new Error("boom");
				return x;
			}),
		).rejects.toThrow("boom");
	});
});
