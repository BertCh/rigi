// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { AxisFilter, wrapDelta } from "../filter";

const config = {
	offsetNoise: 0.3,
	acceleration: 20,
	wrap: false,
	initialSigma: 5,
};

describe("AxisFilter", () => {
	it("wraps angle differences", () => {
		expect(wrapDelta(350)).toBeCloseTo(-10);
		expect(wrapDelta(-190)).toBeCloseTo(170);
		expect(Math.abs(wrapDelta(180))).toBeCloseTo(180);
	});

	it("sensor mode converges to a constant sensor bias and passes sensor motion through", () => {
		const f = new AxisFilter(config);
		f.init(10, 0, 0, 5);
		const truthAt = (t: number) => 20 * Math.sin(t);
		for (let k = 1; k <= 120; k++) {
			const t = k / 15;
			f.update(truthAt(t) + (k % 2 ? 0.2 : -0.2), truthAt(t) - 8, 0.25, t);
		}
		const t = 8.05;
		expect(f.valueAt(t, truthAt(t) - 8)).toBeCloseTo(truthAt(t), 0);
		expect(f.usesSensor).toBe(true);
		expect(f.sigma).toBeLessThan(0.5);
	});

	it("velocity mode tracks a ramp without a sensor", () => {
		const f = new AxisFilter(config);
		f.init(0, null, 0, 1);
		for (let k = 1; k <= 90; k++) {
			const t = k / 15;
			f.update(30 * t + (k % 2 ? 0.3 : -0.3), null, 0.09, t);
		}
		// extrapolates half a frame ahead within a degree
		expect(f.valueAt(6 + 1 / 30, null)).toBeCloseTo(30 * (6 + 1 / 30), 0);
	});

	it("yaw wraps through 360 in both modes", () => {
		const f = new AxisFilter({ ...config, wrap: true });
		f.init(359, null, 0, 1);
		f.update(1, null, 0.1, 0.1);
		const v = f.valueAt(0.1, null);
		expect(v >= 0 && v < 360).toBe(true);
		expect(Math.min(v, 360 - v)).toBeLessThan(5);
		const s = new AxisFilter({ ...config, wrap: true });
		s.init(2, 355, 0, 1);
		expect(s.valueAt(0, 355)).toBeCloseTo(2, 6);
	});

	it("a late measurement does not move the filter time backwards", () => {
		const f = new AxisFilter(config);
		f.init(0, null, 1, 1);
		f.update(0.1, null, 0.1, 0.9);
		expect(Number.isFinite(f.valueAt(1, null))).toBe(true);
	});

	it("switches mode when the sensor disappears or appears", () => {
		const f = new AxisFilter(config);
		f.init(5, 0, 0, 1);
		f.update(5.2, null, 0.1, 0.1);
		expect(f.usesSensor).toBe(false);
		f.update(5.2, 1, 0.1, 0.2);
		expect(f.usesSensor).toBe(true);
	});
});
