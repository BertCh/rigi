// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { withFlags } from "#/test/helpers";
import {
	headingControlWindow,
	headingDeclination,
	isMagneticRef,
	priorHeading,
} from "../heading";
import { declination } from "../wmm";

const base = {
	lat: 46.71,
	lon: 7.77,
	alt: 1900,
	takenAt: "2025-08-01T12:00:00Z",
	takenAtUtc: "2025-08-01T12:00:00Z",
};

describe("isMagneticRef", () => {
	it("accepts M / m / magnetic... and rejects everything else", () => {
		for (const r of ["M", "m", " M ", "Magnetic North"])
			expect(isMagneticRef(r)).toBe(true);
		for (const r of ["T", "True North", "", null, undefined])
			expect(isMagneticRef(r)).toBe(false);
	});
});

describe("headingDeclination", () => {
	it("agrees with the WMM at the photo's place and time", () => {
		const d = headingDeclination(base);
		expect(d).toBeCloseTo(
			declination(46.71, 7.77, 1900, new Date("2025-08-01T12:00:00Z")),
			12,
		);
		expect(d).toBeGreaterThan(2);
		expect(d).toBeLessThan(5);
	});
	it("is null without a finite position", () => {
		expect(headingDeclination({ ...base, lat: Number.NaN })).toBeNull();
		expect(headingDeclination({ ...base, lon: Number.NaN })).toBeNull();
	});
	it("treats a missing altitude as sea level", () => {
		const a = headingDeclination({ ...base, alt: null });
		expect(a).not.toBeNull();
		expect(
			Math.abs(
				(a as number) - (headingDeclination({ ...base, alt: 0 }) as number),
			),
		).toBeLessThan(1e-12);
	});
});

describe("priorHeading", () => {
	const d = headingDeclination(base) as number;
	it("leaves the heading unchanged when disabled or true-north", () => {
		expect(
			priorHeading(
				{ ...base, heading: 100, local: { headingRef: "M" } },
				false,
			),
		).toBe(100);
		expect(
			priorHeading({ ...base, heading: 100, local: { headingRef: "T" } }, true),
		).toBe(100);
		expect(priorHeading({ ...base, heading: 100 }, true)).toBe(100);
	});
	it("adds the declination to a magnetic heading", () => {
		const h = priorHeading(
			{ ...base, heading: 100, local: { headingRef: "M" } },
			true,
		);
		expect(h).toBeCloseTo(100 + d, 10);
	});
	it("wraps into [0, 360)", () => {
		const h = priorHeading(
			{ ...base, heading: 359, local: { headingRef: "M" } },
			true,
		) as number;
		expect(h).toBeGreaterThanOrEqual(0);
		expect(h).toBeLessThan(360);
		expect(h).toBeCloseTo((359 + d) % 360, 10);
	});
	it("passes null through and falls back to the raw heading without a position", () => {
		expect(
			priorHeading(
				{ ...base, heading: null, local: { headingRef: "M" } },
				true,
			),
		).toBeNull();
		expect(
			priorHeading(
				{ ...base, lat: Number.NaN, heading: 50, local: { headingRef: "M" } },
				true,
			),
		).toBe(50);
	});
	it("defaults to the geoDecl flag (off => unchanged)", () => {
		const photo = { ...base, heading: 100, local: { headingRef: "M" } };
		expect(priorHeading(photo)).toBe(100);
		withFlags({ geoDecl: "on" });
		expect(priorHeading(photo)).toBeCloseTo(100 + d, 10);
	});
});

describe("headingControlWindow", () => {
	it("spans prior ± halfWidth and unwraps the yaw next to the prior", () => {
		expect(headingControlWindow(358, 2)).toEqual({
			min: 318,
			max: 398,
			value: 362,
		});
		expect(headingControlWindow(3, 355)).toEqual({
			min: -37,
			max: 43,
			value: -5,
		});
		expect(headingControlWindow(120, 125.5, 10)).toEqual({
			min: 110,
			max: 130,
			value: 125.5,
		});
	});
	it("keeps the value inside the range whenever the yaw is within halfWidth of the prior", () => {
		for (const prior of [0, 1, 179, 180, 359.5])
			for (const off of [-40, -12.5, 0, 7, 40]) {
				const w = headingControlWindow(
					prior,
					(((prior + off) % 360) + 360) % 360,
				);
				expect(w.value).toBeGreaterThanOrEqual(w.min - 1e-9);
				expect(w.value).toBeLessThanOrEqual(w.max + 1e-9);
				expect(w.value - prior).toBeCloseTo(off, 9);
			}
	});
	it("widens the range to a yaw beyond halfWidth instead of clamping it", () => {
		// a solve 80° off the compass: the range reaches the value, so the first touch does not jump the pose
		expect(headingControlWindow(120, 200)).toEqual({
			min: 80,
			max: 200,
			value: 200,
		});
		expect(headingControlWindow(120, 10)).toEqual({
			min: 10,
			max: 160,
			value: 10,
		});
		// across north: 2° under a 300° compass unwraps to 362°, past the 340° edge
		expect(headingControlWindow(300, 2)).toEqual({
			min: 260,
			max: 362,
			value: 362,
		});
	});
	it("uses the full circle when the heading is unknown", () => {
		expect(headingControlWindow(null, -10)).toEqual({
			min: 0,
			max: 360,
			value: 350,
		});
		expect(headingControlWindow(null, 725)).toEqual({
			min: 0,
			max: 360,
			value: 5,
		});
	});
});
