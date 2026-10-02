// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { expectArrayClose } from "#/test/helpers";
import { hexToRgb01 } from "../color";
import {
	ABSOLUTE_RAMP_RANGE,
	ABSOLUTE_RAMPS,
	isRampName,
	MAX_RAMP_STOPS,
	RAMPS,
	rampCss,
	resolveRamp,
	sampleRamp,
	turbo,
} from "../ramps";
import type { RampName } from "../types";

const names = Object.keys(RAMPS) as RampName[];

describe("RAMPS table", () => {
	it("every stop ramp is ordered, within MAX_RAMP_STOPS and has valid colours", () => {
		for (const name of names) {
			const r = RAMPS[name];
			if (r.kind === "turbo") continue;
			expect(r.stops.length, name).toBeGreaterThanOrEqual(2);
			expect(r.stops.length, name).toBeLessThanOrEqual(MAX_RAMP_STOPS);
			for (let i = 1; i < r.stops.length; i++)
				expect(r.stops[i].t, name).toBeGreaterThan(r.stops[i - 1].t);
			expect(r.stops[0].t, name).toBe(0);
			for (const s of r.stops)
				for (const x of hexToRgb01(s.c)) {
					expect(x).toBeGreaterThanOrEqual(0);
					expect(x).toBeLessThanOrEqual(1);
				}
		}
	});
	it("absolute ramps exist and the absolute range spans the documented 400..3500 m", () => {
		for (const n of ABSOLUTE_RAMPS) expect(isRampName(n)).toBe(true);
		expect(ABSOLUTE_RAMP_RANGE).toEqual({
			mode: "absolute",
			lo: 400,
			hi: 3500,
		});
		// t = (h - 400) / 3100 puts 1000 m at 0.1935 (berann's second stop)
		const berann = RAMPS.berann;
		if (berann.kind !== "stops") throw new Error("berann is a stop ramp");
		expect(berann.stops[1].t).toBeCloseTo((1000 - 400) / 3100, 3);
	});
});

describe("isRampName / resolveRamp", () => {
	it("recognises names only", () => {
		expect(isRampName("cool")).toBe(true);
		expect(isRampName("nope")).toBe(false);
		expect(isRampName(3)).toBe(false);
	});
	// BUG: isRampName uses `v in RAMPS`, so inherited keys count as ramp names.
	it.fails("does not accept inherited object keys", () => {
		expect(isRampName("toString")).toBe(false);
		expect(isRampName("constructor")).toBe(false);
	});
	it("resolves a name to the table entry and passes a literal ramp through", () => {
		expect(resolveRamp("cool")).toBe(RAMPS.cool);
		const lit = RAMPS.grey;
		expect(resolveRamp(lit)).toBe(lit);
	});
});

describe("sampleRamp", () => {
	it("hits stop colours exactly and clamps outside the range", () => {
		expectArrayClose(sampleRamp("cool", 0), [0.1, 0.85, 0.8]);
		expectArrayClose(sampleRamp("cool", -5), [0.1, 0.85, 0.8]);
		expectArrayClose(sampleRamp("cool", 1), [1, 0.95, 0.85]);
		expectArrayClose(sampleRamp("cool", 9), [1, 0.95, 0.85]);
		expectArrayClose(sampleRamp("cool", 0.5), [0.75, 0.35, 1.0]);
	});
	it("interpolates linearly between plain stops", () => {
		expectArrayClose(sampleRamp("grey", 0.5), [0.625, 0.625, 0.625]);
	});
	it("uses smoothstep for an ease: smooth segment (hypso-classic top)", () => {
		// segment 0.72..0.85 is smooth; its midpoint is the plain midpoint (smoothstep(.5) = .5)
		const mid = 0.785;
		expectArrayClose(sampleRamp("hypso-classic", mid), [
			(0.62 + 0.97) / 2,
			(0.6 + 0.98) / 2,
			(0.6 + 1.0) / 2,
		]);
		// a quarter of the way the eased value is below linear
		const q = 0.72 + 0.25 * 0.13;
		expect(sampleRamp("hypso-classic", q)[0]).toBeLessThan(0.62 + 0.25 * 0.35);
	});
	it("is constant above the last stop of hypso-classic", () => {
		expectArrayClose(sampleRamp("hypso-classic", 0.9), [0.97, 0.98, 1.0]);
	});
	it("decodes hex stops (viridis ends)", () => {
		expectArrayClose(sampleRamp("viridis", 0), hexToRgb01("#440154"));
		expectArrayClose(sampleRamp("viridis", 1), hexToRgb01("#fde725"));
	});
	it("is continuous at every stop boundary for every ramp", () => {
		for (const name of names) {
			const r = RAMPS[name];
			if (r.kind === "turbo") continue;
			for (const s of r.stops) {
				const a = sampleRamp(name, s.t - 1e-6);
				const b = sampleRamp(name, s.t + 1e-6);
				for (let c = 0; c < 3; c++)
					expect(Math.abs(a[c] - b[c]), `${name}@${s.t}`).toBeLessThan(1e-3);
			}
		}
	});
});

describe("turbo", () => {
	it("matches the known polynomial endpoints", () => {
		expectArrayClose(turbo(0), [0.13572138, 0.09140261, 0.1066733]);
		const hi = turbo(1);
		// the published turbo ends in a dark red
		expect(hi[0]).toBeGreaterThan(0.4);
		expect(hi[1]).toBeLessThan(0.1);
	});
	it("clamps its input and sampleRamp delegates to it", () => {
		expect(turbo(-3)).toEqual(turbo(0));
		expect(turbo(4)).toEqual(turbo(1));
		expect(sampleRamp("turbo", 0.3)).toEqual(turbo(0.3));
	});
});

describe("rampCss", () => {
	it("emits steps + 1 stops from 0% to 100%", () => {
		const css = rampCss("grey", 4);
		expect(css.startsWith("linear-gradient(90deg, ")).toBe(true);
		expect(css.match(/rgb\(/g)).toHaveLength(5);
		expect(css).toContain("rgb(77,77,77) 0.0%");
		expect(css).toContain("rgb(242,242,242) 100.0%");
	});
});
