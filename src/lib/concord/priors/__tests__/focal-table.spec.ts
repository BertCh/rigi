// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { focalPxFromF35 } from "../../../camera/focal";
import {
	DEFAULT_LENS,
	focalPrior,
	LENS_TABLE,
	lensEntry,
	lensModelFromCamera,
} from "../focal-table";

const MAIN = "iPhone 11 Pro back triple camera 4.25mm f/1.8";
const ULTRA = "iPhone 11 Pro back triple camera 1.54mm f/2.4";

describe("lensEntry", () => {
	it("falls back to the default for unknown or missing lenses", () => {
		expect(lensEntry(undefined, 26)).toBe(DEFAULT_LENS);
		expect(lensEntry("", 26)).toBe(DEFAULT_LENS);
		expect(lensEntry("Pixel 8 main", 24)).toBe(DEFAULT_LENS);
	});
	it("matches the native-26 main-lens entry only at f35 = 26", () => {
		const e = lensEntry(MAIN, 26);
		expect(e.f35).toBe(26);
		expect(e.sigma).toBeLessThan(0.01);
	});
	it("uses the wider digital-zoom entry for a different f35 and when f35 is omitted", () => {
		const zoom = lensEntry(MAIN, 48);
		expect(zoom.f35).toBeUndefined();
		expect(zoom.sigma).toBeGreaterThan(lensEntry(MAIN, 26).sigma);
		expect(lensEntry(MAIN)).toBe(zoom);
	});
	it("matches the ultra-wide", () => {
		expect(lensEntry(ULTRA, 13).fScale).toBeCloseTo(1.063, 6);
	});
	it("has positive sigma and scale in every table entry", () => {
		for (const e of [...LENS_TABLE, DEFAULT_LENS]) {
			expect(e.sigma).toBeGreaterThan(0);
			expect(e.fScale).toBeGreaterThan(0.5);
		}
	});
});

describe("focalPrior", () => {
	const px = { width: 4032, height: 3024 };
	it("is the EXIF focal times fScale with sigma = mean x entry sigma", () => {
		const fp = focalPrior(MAIN, 26, px);
		const exif = focalPxFromF35(26, px);
		expect(fp.fPx).toBeCloseTo(exif * 1.0173, 6);
		expect(fp.sigmaPx).toBeCloseTo(fp.fPx * 0.0064, 9);
		expect(fp.fScale).toBe(1.0173);
	});
	it("uses the unscaled EXIF focal and 2 % sigma by default", () => {
		const fp = focalPrior(undefined, 26, px);
		expect(fp.fPx).toBeCloseTo(focalPxFromF35(26, px), 9);
		expect(fp.sigmaPx / fp.fPx).toBeCloseTo(0.02, 12);
	});
	it("scales linearly with image size at fixed field of view", () => {
		const a = focalPrior(MAIN, 26, { width: 4032, height: 3024 }).fPx;
		const b = focalPrior(MAIN, 26, { width: 2016, height: 1512 }).fPx;
		expect(a / b).toBeCloseTo(2, 9);
	});
});

describe("lensModelFromCamera", () => {
	it("maps the iPhone 11 Pro by 35 mm focal", () => {
		expect(lensModelFromCamera("iPhone 11 Pro", 13)).toContain("1.54mm");
		expect(lensModelFromCamera("iPhone 11 Pro", 26)).toContain("4.25mm");
		expect(lensModelFromCamera("iPhone 11 Pro", 48)).toContain("4.25mm");
	});
	it("returns undefined for telephoto, other cameras and missing focal", () => {
		expect(lensModelFromCamera("iPhone 11 Pro", 52)).toBeUndefined();
		expect(lensModelFromCamera("iPhone 12", 26)).toBeUndefined();
		expect(lensModelFromCamera("iPhone 11 Pro", undefined)).toBeUndefined();
		expect(lensModelFromCamera(undefined, 26)).toBeUndefined();
	});
	it("round-trips to the table entries", () => {
		expect(lensEntry(lensModelFromCamera("iPhone 11 Pro", 26), 26).f35).toBe(
			26,
		);
		expect(
			lensEntry(lensModelFromCamera("iPhone 11 Pro", 13), 13).fScale,
		).toBeCloseTo(1.063, 6);
	});
});
