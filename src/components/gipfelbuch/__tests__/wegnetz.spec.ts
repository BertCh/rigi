// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { GIPFELBUCH_NODES } from "#/lib/gipfelbuch/graph";
import { CHAPTERS } from "../tafel/chapters";
import {
	photoRoute,
	trailEnds,
	trailKey,
	trailLineage,
	WEGNETZ_HEIGHT,
	WEGNETZ_SHEET_IDS,
	WEGNETZ_STATIONS,
	WEGNETZ_TRAILS,
	WEGNETZ_VALLEYS,
	WEGNETZ_WIDTH,
} from "../tafel/wegnetz-layout";

const keys = new Set(WEGNETZ_TRAILS.map(trailKey));

describe("wegnetz layout", () => {
	it("shows every sheet exactly once", () => {
		expect([...WEGNETZ_SHEET_IDS].sort()).toEqual(
			GIPFELBUCH_NODES.map((n) => n.id).sort(),
		);
	});
	it("puts each station in its chapter's valley", () => {
		for (const station of WEGNETZ_STATIONS) {
			const chapter = CHAPTERS.find((c) => c.ids.includes(station.id));
			const valley = WEGNETZ_VALLEYS.find(
				(v) => v.numeral === chapter?.numeral,
			);
			expect(valley, station.id).toBeDefined();
			expect(station.at[1]).toBeGreaterThan(valley?.y0 ?? 0);
			expect(station.at[1]).toBeLessThan(valley?.y1 ?? 0);
			expect(station.at[0]).toBeGreaterThan(0);
			expect(station.at[0]).toBeLessThan(WEGNETZ_WIDTH);
			expect(station.at[1]).toBeLessThan(WEGNETZ_HEIGHT);
		}
	});
	it("hangs each valley on its chapter's hub", () => {
		for (const valley of WEGNETZ_VALLEYS) {
			const chapter = CHAPTERS.find((c) => c.numeral === valley.numeral);
			expect(chapter?.ids).toContain(valley.hub);
		}
	});
	it("only runs trails between stations, once each", () => {
		const stations = new Set(WEGNETZ_STATIONS.map((s) => s.id));
		for (const t of WEGNETZ_TRAILS) {
			expect(stations.has(t.from), t.from).toBe(true);
			expect(stations.has(t.to), t.to).toBe(true);
		}
		expect(keys.size).toBe(WEGNETZ_TRAILS.length);
	});
	it("leaves no station without a trail", () => {
		for (const station of WEGNETZ_STATIONS)
			expect(trailLineage(station.id).size, station.id).toBeGreaterThan(0);
	});
});

describe("wegnetz routes", () => {
	it("draws only existing trails for both gate outcomes", () => {
		for (const accepted of [true, false])
			for (const key of photoRoute(accepted))
				expect(keys.has(key), key).toBe(true);
	});
	it("detours by Tap a peak only when refused", () => {
		expect(photoRoute(true).has("tap-a-peak>pose-estimate")).toBe(false);
		expect(photoRoute(false).has("tap-a-peak>pose-estimate")).toBe(true);
		expect(photoRoute(false).has("accept-rule>pose-estimate")).toBe(false);
	});
	it("walks lineage both ways", () => {
		const lineage = trailLineage("accept-rule");
		expect(lineage.has("photo>skyline")).toBe(true);
		expect(lineage.has("pose-estimate>photo-workspace")).toBe(true);
		expect(lineage.has("dem-source>eye-rule")).toBe(true);
		expect(trailLineage("dem-source").has("photo>skyline")).toBe(false);
	});
	it("stops trails short of both stations", () => {
		const [a, b] = trailEnds([0, 0], [100, 0], 14);
		expect(a).toEqual([14, 0]);
		expect(b).toEqual([86, 0]);
	});
});
