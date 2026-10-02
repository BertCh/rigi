// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import {
	createRandom,
	hashSeed,
	sketchArrow,
	sketchCircle,
	sketchCurve,
	sketchLine,
} from "../notebook/sketch";

describe("createRandom", () => {
	it("is deterministic and within [0, 1)", () => {
		const a = createRandom(42);
		const b = createRandom(42);
		for (let i = 0; i < 100; i++) {
			const v = a();
			expect(v).toBe(b());
			expect(v).toBeGreaterThanOrEqual(0);
			expect(v).toBeLessThan(1);
		}
	});
	it("differs by seed", () => {
		expect(createRandom(1)()).not.toBe(createRandom(2)());
	});
});

describe("hashSeed", () => {
	it("is stable and distinguishes keys", () => {
		expect(hashSeed("abc")).toBe(hashSeed("abc"));
		expect(hashSeed("abc")).not.toBe(hashSeed("abd"));
		expect(hashSeed("")).toBe(0x811c9dc5);
	});
});

describe("sketchLine", () => {
	it("is a seeded quadratic path near its endpoints", () => {
		const d = sketchLine([0, 0], [100, 0], 7);
		expect(d).toBe(sketchLine([0, 0], [100, 0], 7));
		expect(d).not.toBe(sketchLine([0, 0], [100, 0], 8));
		expect(d).toMatch(/^M-?[\d.]+ -?[\d.]+Q/);
		const nums = (d.match(/-?\d+\.\d/g) ?? []).map(Number);
		expect(Math.abs(nums[0])).toBeLessThan(2);
		expect(Math.abs(nums[1])).toBeLessThan(2);
	});
	it("copes with a zero-length line", () => {
		expect(sketchLine([5, 5], [5, 5], 1)).not.toContain("NaN");
	});
});

describe("sketchCurve", () => {
	it("returns empty for fewer than two points", () => {
		expect(sketchCurve([[0, 0]], 1)).toBe("");
	});
	it("emits one cubic per segment and keeps the end knots exact", () => {
		const d = sketchCurve(
			[
				[0, 0],
				[10, 5],
				[20, 0],
			],
			3,
		);
		expect(d.startsWith("M0.0 0.0")).toBe(true);
		expect(d.match(/C/g)).toHaveLength(2);
		expect(d.endsWith("20.0 0.0")).toBe(true);
	});
});

describe("sketchCircle and sketchArrow", () => {
	it("circle is a valid, seeded path", () => {
		const d = sketchCircle([50, 50], 10, 8, 4);
		expect(d).toBe(sketchCircle([50, 50], 10, 8, 4));
		expect(d).not.toContain("NaN");
	});
	it("arrow returns a shaft and a head", () => {
		const a = sketchArrow([0, 0], [40, 20], 2);
		expect(a.shaft.startsWith("M")).toBe(true);
		expect(a.head.length).toBeGreaterThan(0);
		expect(`${a.shaft}${a.head}`).not.toContain("NaN");
	});
});
