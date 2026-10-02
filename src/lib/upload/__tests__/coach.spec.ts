// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import {
	COACH_HEADLINE,
	coachLocation,
	isIosUserAgent,
	PLACE_ON_MAP,
} from "../coach";

const diag = (
	gps: boolean,
	heading: boolean,
	gravity: boolean,
	exif = true,
) => ({
	hasExif: exif,
	hasGps: gps,
	hasHeading: heading,
	hasGravity: gravity,
});

const combos = [false, true].flatMap((g) =>
	[false, true].flatMap((h) => [false, true].map((t) => [g, h, t] as const)),
);

describe("coachLocation", () => {
	it.each(combos)("gps=%s heading=%s tilt=%s", (g, h, t) => {
		for (const ios of [true, false]) {
			const c = coachLocation(diag(g, h, t), { ios });
			const n = [g, h, t].filter(Boolean).length;
			expect(c.status).toBe(n === 3 ? "complete" : n ? "partial" : "none");
			expect(c.headline).toBe(COACH_HEADLINE[c.status]);
			expect(c.sensors.map((s) => s.present)).toEqual([g, h, t]);
			expect(c.sensors.map((s) => s.label)).toEqual([
				"Position",
				"Heading",
				"Tilt",
			]);
			// steps only for what is missing, position first, the map fallback last
			const ids = c.steps.map((s) => s.id);
			if (n === 3) expect(ids).toEqual([]);
			expect(ids.includes(PLACE_ON_MAP.id)).toBe(!g);
			if (!g) expect(ids.at(-1)).toBe(PLACE_ON_MAP.id);
			expect(ids.some((i) => /compass/.test(i))).toBe(!h);
			expect(c.note === null).toBe(g);
		}
	});

	it("gives iOS the settings path and others the generic copy", () => {
		const ios = coachLocation(diag(false, false, false), { ios: true });
		const other = coachLocation(diag(false, false, false), { ios: false });
		expect(ios.steps[0].text).toMatch(/Settings, Privacy & Security/);
		expect(ios.steps.some((s) => /tap Options/.test(s.text))).toBe(true);
		expect(other.steps.some((s) => /Settings/.test(s.text))).toBe(false);
		expect(ios.steps.map((s) => s.id)).toEqual([
			"ios-camera-location",
			"ios-picker-options",
			"ios-compass",
			"ios-camera-app",
			"place-on-map",
		]);
	});

	it("says why the position is missing", () => {
		expect(
			coachLocation(diag(false, true, true, true), { ios: true }).note,
		).toMatch(/location was removed/);
		expect(
			coachLocation(diag(false, true, true, false), { ios: true }).note,
		).toMatch(/no EXIF/);
	});

	it("keeps the voice plain: no exclamation marks", () => {
		const c = coachLocation(diag(false, false, false), { ios: true });
		for (const t of [c.headline, c.note, ...c.steps.map((s) => s.text)])
			expect(t).not.toContain("!");
	});
});

describe("isIosUserAgent", () => {
	it.each([
		[
			"Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15",
			5,
			true,
		],
		["Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)", 5, true],
		[
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
			5,
			true,
		],
		[
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
			0,
			false,
		],
		["Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36", 5, false],
		["Mozilla/5.0 (Windows NT 10.0; Win64; x64)", 0, false],
	])("%s (%i touch points) → %s", (ua, touch, want) => {
		expect(isIosUserAgent(ua, touch)).toBe(want);
	});
});
