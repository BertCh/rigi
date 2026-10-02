// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import demo01 from "#/components/site/surround/demo-01.json";
import demo09 from "#/components/site/surround/demo-09.json";
import {
	COMPARE_START,
	compareLeftSpill,
	mirrorRevealRadius,
	PHOTO_FULL,
	surroundFullRadius,
	surroundRevealAt,
	surroundRevealMasks,
} from "../live-reveal";

const UNIT = { x: 0, y: 0, w: 1, h: 1 };

describe("surroundRevealAt", () => {
	it("is RevealLoop's photo ellipse when the canvas is the photo", () => {
		expect(surroundRevealAt(UNIT)).toBe(
			"ellipse 140.00% 120.00% at 50.00% 115.00%",
		);
	});

	it("scales and shifts the ellipse with the photo's place in the canvas", () => {
		const at = surroundRevealAt({ x: 0.25, y: 0.1, w: 0.5, h: 0.8 });
		expect(at).toBe("ellipse 70.00% 96.00% at 50.00% 102.00%");
	});
});

describe("surroundRevealMasks", () => {
	it("falls back to fully lit when the var is unset (poster, print, webdriver)", () => {
		const { fill, front } = surroundRevealMasks("ellipse 1% 1% at 0% 0%");
		expect(fill).toContain("var(--gb-reveal, 999%)");
		expect(front).toContain("var(--gb-reveal, 999%)");
	});
});

describe("surroundFullRadius", () => {
	it("is RevealLoop's FULL for the photo alone", () => {
		expect(surroundFullRadius(UNIT)).toBe(PHOTO_FULL);
	});

	it("rests at PHOTO_FULL for demo-01 and reaches past it for the wider demo-09", () => {
		expect(surroundFullRadius(demo01.photo)).toBe(PHOTO_FULL);
		const wide = surroundFullRadius(demo09.photo);
		expect(wide).toBeGreaterThan(PHOTO_FULL);
		expect(wide).toBeLessThan(200);
	});
});

describe("mirrorRevealRadius", () => {
	it("copies the photo's front while the bloom runs", () => {
		for (const r of [0, 10, 57.3, 134.9])
			expect(mirrorRevealRadius(r, 148)).toEqual({ radius: r, settle: false });
	});

	it("settles on the margin's full radius once the photo rests lit", () => {
		expect(mirrorRevealRadius(PHOTO_FULL, 148)).toEqual({
			radius: 148,
			settle: true,
		});
	});

	it("does not settle when the margin is already lit at the photo's rest", () => {
		expect(mirrorRevealRadius(PHOTO_FULL, PHOTO_FULL)).toEqual({
			radius: PHOTO_FULL,
			settle: false,
		});
	});

	it("drops back with the replay (the radius falls, the settle ends)", () => {
		expect(mirrorRevealRadius(0, 148)).toEqual({ radius: 0, settle: false });
	});
});

describe("compareLeftSpill", () => {
	it("is off at the wipe's start and on at the far left", () => {
		expect(compareLeftSpill(COMPARE_START)).toBe(0);
		expect(compareLeftSpill(0.12)).toBe(0);
		expect(compareLeftSpill(0.07)).toBeCloseTo(0.5);
		expect(compareLeftSpill(0.02)).toBeCloseTo(1);
		expect(compareLeftSpill(0)).toBe(1);
	});

	it("never leaves 0..1", () => {
		for (let v = -0.5; v <= 1.5; v += 0.05) {
			const t = compareLeftSpill(v);
			expect(t).toBeGreaterThanOrEqual(0);
			expect(t).toBeLessThanOrEqual(1);
		}
	});
});
