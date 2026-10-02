// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { galleryVerdict, TONE_TAG, toneGlyph, trioClasses } from "../tiles";

describe("galleryVerdict", () => {
	it("draws no circle for a result or a neutral tile", () => {
		expect(galleryVerdict("result")).toBeUndefined();
		expect(galleryVerdict("result", "guess")).toBeUndefined();
		expect(galleryVerdict("neutral")).toBeUndefined();
		expect(galleryVerdict("neutral", "x")).toBeUndefined();
	});
	it("defaults a failure to rejected and takes the page's word", () => {
		expect(galleryVerdict("failure")?.text).toBe("rejected");
		expect(galleryVerdict("failure", "guess")?.text).toBe("guess");
		expect(galleryVerdict("failure")?.color).toBe("var(--gb-red)");
	});
	it("takes a caution's word and falls back to check", () => {
		expect(galleryVerdict("caution", "240 m off")?.text).toBe("240 m off");
		expect(galleryVerdict("caution")?.text).toBe("check");
		expect(galleryVerdict("caution")?.color).toBe(TONE_TAG.caution?.color);
	});
});

describe("tone tags", () => {
	it("has a tag for every tone but neutral", () => {
		expect(TONE_TAG.neutral).toBeNull();
		expect(TONE_TAG.caution?.text).toBe("check");
		expect(toneGlyph("caution")).toBe("! ");
		expect(toneGlyph("result")).toBe("✓ ");
		expect(toneGlyph("failure")).toBe("✗ ");
	});
});

describe("trioClasses", () => {
	it("keeps one column on a phone and three on sm for three steps", () => {
		const c = trioClasses(3);
		expect(c.grid).toContain("sm:grid-cols-3");
		expect(c.grid).not.toContain("lg:grid-cols-4");
	});
	it("wraps four steps to two columns, then four on lg", () => {
		const c = trioClasses(4);
		expect(c.grid).toContain("sm:grid-cols-2");
		expect(c.grid).toContain("lg:grid-cols-4");
	});
	it("spans each step over two subgrid rows and bottom-aligns the visual", () => {
		const c = trioClasses(3);
		expect(c.step).toContain("sm:row-span-2");
		expect(c.step).toContain("sm:grid-rows-subgrid");
		expect(c.visual).toContain("sm:self-end");
	});
});
