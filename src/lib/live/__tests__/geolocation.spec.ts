// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import type { EyeFix } from "../contract";
import { createMoveDetector, eyeFixFromPosition } from "../geolocation";

const at = (lat: number, lon: number, accuracy = 10): EyeFix => ({
	lat,
	lon,
	accuracy,
	time: 0,
});
// 0.001 degrees of latitude is about 111 m
const NORTH_111_M = 0.001;

describe("createMoveDetector", () => {
	it("the first fix only sets the anchor", () => {
		const d = createMoveDetector();
		expect(d.update(at(46.7, 7.8))).toBe(false);
		expect(d.anchor?.lat).toBe(46.7);
	});

	it("reports a move past 100 m once, then re-anchors", () => {
		const d = createMoveDetector();
		d.update(at(46.7, 7.8));
		expect(d.update(at(46.7 + NORTH_111_M * 0.5, 7.8))).toBe(false);
		expect(d.update(at(46.7 + NORTH_111_M, 7.8))).toBe(true);
		expect(d.update(at(46.7 + NORTH_111_M, 7.8))).toBe(false);
	});

	it("does not trust a fix whose accuracy is worse than the threshold", () => {
		const d = createMoveDetector();
		d.update(at(46.7, 7.8));
		expect(d.update(at(46.7 + NORTH_111_M * 3, 7.8, 500))).toBe(false);
		expect(d.anchor?.lat).toBe(46.7);
	});

	it("rebase moves the anchor without a report", () => {
		const d = createMoveDetector();
		d.update(at(46.7, 7.8));
		d.rebase(at(46.8, 7.8));
		expect(d.update(at(46.8, 7.8))).toBe(false);
	});

	it("honours a custom threshold", () => {
		const d = createMoveDetector(10);
		d.update(at(46.7, 7.8, 3));
		expect(d.update(at(46.7 + 0.0002, 7.8, 3))).toBe(true);
	});
});

describe("eyeFixFromPosition", () => {
	it("maps coordinates and keeps altitude only when present", () => {
		const make = (altitude: number | null) =>
			({
				coords: { latitude: 1, longitude: 2, accuracy: 7, altitude },
			}) as unknown as GeolocationPosition;
		expect(eyeFixFromPosition(make(1234), 9)).toEqual({
			lat: 1,
			lon: 2,
			accuracy: 7,
			time: 9,
			alt: 1234,
		});
		expect(eyeFixFromPosition(make(null), 9).alt).toBeUndefined();
	});
});
