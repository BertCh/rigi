// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { framedNotes } from "../live-notes";

describe("framedNotes", () => {
	it("keeps notes on the frame, edges included, in order", () => {
		const notes = [
			{ text: "a", at: [0, 0] as [number, number] },
			{ text: "b", at: [0.5, 0.7] as [number, number] },
			{ text: "c", at: [1, 1] as [number, number] },
		];
		expect(framedNotes(notes).map((n) => n.text)).toEqual(["a", "b", "c"]);
	});

	it("drops notes that point into the spill on any side", () => {
		const notes = [
			{ text: "right", at: [1.15, 0.5] as [number, number] },
			{ text: "left", at: [-0.1, 0.5] as [number, number] },
			{ text: "above", at: [0.5, -0.05] as [number, number] },
			{ text: "below", at: [0.5, 1.2] as [number, number] },
			{ text: "in", at: [0.42, 0.62] as [number, number] },
		];
		expect(framedNotes(notes).map((n) => n.text)).toEqual(["in"]);
	});

	it("returns a new array and leaves the input alone", () => {
		const notes = [{ at: [2, 2] as [number, number] }];
		const out = framedNotes(notes);
		expect(out).toEqual([]);
		expect(notes).toHaveLength(1);
	});
});
