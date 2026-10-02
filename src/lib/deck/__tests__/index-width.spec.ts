// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { narrowIndices } from "../index-width";

describe("narrowIndices", () => {
	it("narrows to Uint16Array when the vertex count fits", () => {
		const src = Uint32Array.from([0, 1, 2, 65535]);
		const out = narrowIndices(src, 65536);
		expect(out).toBeInstanceOf(Uint16Array);
		expect(Array.from(out)).toEqual([0, 1, 2, 65535]);
	});
	it("caches per source array", () => {
		const src = Uint32Array.from([0, 1, 2]);
		expect(narrowIndices(src, 10)).toBe(narrowIndices(src, 10));
	});
	it("keeps Uint32 past 65536 vertices or when empty", () => {
		const src = Uint32Array.from([0, 1, 70000]);
		expect(narrowIndices(src, 65537)).toBe(src);
		const empty = new Uint32Array(0);
		expect(narrowIndices(empty, 4)).toBe(empty);
	});
});
