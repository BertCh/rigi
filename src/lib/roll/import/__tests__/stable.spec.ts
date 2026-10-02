// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { reuseIfSame } from "../stable";

describe("reuseIfSame", () => {
	const a = { k: 1 };
	const b = { k: 2 };
	it("returns prev when elements are identical", () => {
		const prev = [a, b];
		expect(reuseIfSame(prev, [a, b])).toBe(prev);
	});
	it("returns next when membership or order changes", () => {
		const prev = [a, b];
		const next = [b, a];
		expect(reuseIfSame(prev, next)).toBe(next);
		const longer = [a, b, { k: 3 }];
		expect(reuseIfSame(prev, longer)).toBe(longer);
		const first = [a];
		expect(reuseIfSame(null, first)).toBe(first);
	});
});
