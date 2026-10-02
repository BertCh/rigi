// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import {
	CVD_KINDS,
	deltaE2000,
	deltaEUnder,
	hexToRgb255,
	minPairwiseDeltaE,
	rgbToLab,
	simulateCvd,
} from "../cvd";

describe("cvd colour helpers", () => {
	it("parses hex to 0..255 channels", () => {
		expect(hexToRgb255("#ff8000")).toEqual([255, 128, 0]);
		expect(hexToRgb255("#000000")).toEqual([0, 0, 0]);
	});

	it("maps white to L=100 and black to L=0 with no chroma", () => {
		const [L, a, b] = rgbToLab([255, 255, 255]);
		expect(L).toBeCloseTo(100, 1);
		expect(Math.abs(a)).toBeLessThan(0.1);
		expect(Math.abs(b)).toBeLessThan(0.1);
		expect(rgbToLab([0, 0, 0])[0]).toBeCloseTo(0, 5);
	});

	it("leaves colours alone for 'none' and keeps greys grey under every deficiency", () => {
		expect(simulateCvd([10, 200, 30], "none")).toEqual([10, 200, 30]);
		for (const kind of CVD_KINDS) {
			const [r, g, b] = simulateCvd([128, 128, 128], kind);
			expect(Math.abs(r - 128)).toBeLessThan(3);
			expect(Math.abs(g - 128)).toBeLessThan(3);
			expect(Math.abs(b - 128)).toBeLessThan(3);
		}
	});

	it("clamps simulated channels into 0..255", () => {
		for (const kind of CVD_KINDS)
			for (const rgb of [
				[255, 0, 0],
				[0, 255, 0],
				[0, 0, 255],
			] as const)
				for (const c of simulateCvd(rgb, kind)) {
					expect(c).toBeGreaterThanOrEqual(0);
					expect(c).toBeLessThanOrEqual(255);
				}
	});

	it("makes red and green close under deuteranopia but far for normal vision", () => {
		const normal = deltaEUnder("#d03020", "#30a030", "none");
		const deut = deltaEUnder("#d03020", "#30a030", "deuteranopia");
		expect(deut).toBeLessThan(normal);
	});
});

describe("deltaE2000", () => {
	it("is zero for identical colours and symmetric", () => {
		const a = rgbToLab([200, 90, 40]);
		const b = rgbToLab([20, 140, 220]);
		expect(deltaE2000(a, a)).toBe(0);
		expect(deltaE2000(a, b)).toBeCloseTo(deltaE2000(b, a), 8);
		expect(deltaE2000(a, b)).toBeGreaterThan(20);
	});

	// Sharma, Wu & Dalal 2005 test data, pairs 1, 2 and 8
	it.each([
		[[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
		[[50, 3.1571, -77.2803], [50, 0, -82.7485], 2.8615],
		[[50, 2.5, 0], [73, 25, -18], 27.1492],
	] as [
		[number, number, number],
		[number, number, number],
		number,
	][])("reproduces the published pair %#", (a, b, expected) => {
		expect(deltaE2000(a, b)).toBeCloseTo(expected, 3);
	});
});

describe("minPairwiseDeltaE", () => {
	it("finds the closest pair", () => {
		const r = minPairwiseDeltaE(["#ff0000", "#00ff00", "#fe0000"], "none");
		expect(r.pair).toEqual([0, 2]);
		expect(r.min).toBeLessThan(2);
	});
	it("is infinite for fewer than two colours", () => {
		expect(minPairwiseDeltaE(["#123456"], "none").min).toBe(
			Number.POSITIVE_INFINITY,
		);
	});
});
