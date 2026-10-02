// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { angleDiffDeg } from "#/test/helpers";
import { sunColor, sunDirFromStyle, sunPosition } from "../sun";

describe("sunPosition", () => {
	it("Zurich at solar noon on the June solstice: ~66° up, due south", () => {
		// solar noon at 8.54°E is ≈ 11:26 UTC (longitude) minus the +1.8 min equation of time
		const p = sunPosition("2024-06-21T11:28:00Z", 47.38, 8.54);
		expect(p.elevation).toBeGreaterThan(65.8);
		expect(p.elevation).toBeLessThan(66.3);
		expect(angleDiffDeg(p.azimuth, 180)).toBeLessThan(2);
	});
	it("equator, equinox, noon at Greenwich: nearly overhead", () => {
		const p = sunPosition("2024-03-20T12:00:00Z", 0, 0);
		expect(p.elevation).toBeGreaterThan(85);
	});
	it("midnight is well below the horizon; local morning is in the east, evening in the west", () => {
		expect(
			sunPosition("2024-06-21T23:30:00Z", 47.38, 8.54).elevation,
		).toBeLessThan(-10);
		const morning = sunPosition("2024-06-21T05:00:00Z", 47.38, 8.54);
		const evening = sunPosition("2024-06-21T17:00:00Z", 47.38, 8.54);
		expect(morning.azimuth).toBeGreaterThan(40);
		expect(morning.azimuth).toBeLessThan(120);
		expect(evening.azimuth).toBeGreaterThan(240);
		expect(evening.azimuth).toBeLessThan(320);
	});
	it("winter noon is lower than summer noon by about twice the obliquity", () => {
		const s = sunPosition("2024-06-21T11:28:00Z", 47.38, 8.54).elevation;
		const w = sunPosition("2024-12-21T11:20:00Z", 47.38, 8.54).elevation;
		expect(s - w).toBeGreaterThan(45);
		expect(s - w).toBeLessThan(47.5);
		expect(w).toBeGreaterThan(18.5);
		expect(w).toBeLessThan(19.5);
	});
	it("the ENU direction is a unit vector consistent with azimuth/elevation", () => {
		for (const iso of [
			"2024-06-21T06:00:00Z",
			"2024-11-02T13:15:00Z",
			"2023-01-10T08:00:00Z",
		]) {
			const p = sunPosition(iso, 46.5, 7.9);
			expect(Math.hypot(...p.dir)).toBeCloseTo(1, 12);
			expect(p.dir[2]).toBeCloseTo(Math.sin((p.elevation * Math.PI) / 180), 12);
			const az = (Math.atan2(p.dir[0], p.dir[1]) * 180) / Math.PI;
			expect(angleDiffDeg(az, p.azimuth)).toBeLessThan(1e-9);
		}
	});
	it("accepts Date and ISO string alike and is longitude-periodic", () => {
		const a = sunPosition(new Date("2024-06-21T10:00:00Z"), 47, 8);
		const b = sunPosition("2024-06-21T10:00:00Z", 47, 8);
		expect(a).toEqual(b);
		const c = sunPosition("2024-06-21T10:00:00Z", 47, 8 + 360);
		expect(c.elevation).toBeCloseTo(a.elevation, 9);
	});
	it("an invalid date yields NaN rather than throwing", () => {
		const p = sunPosition("not a date", 47, 8);
		expect(Number.isNaN(p.elevation)).toBe(true);
	});
});

describe("sunColor", () => {
	it("is white at the reference high sun and warms towards the horizon", () => {
		const noon = sunColor(90);
		for (const c of noon) expect(c).toBeLessThanOrEqual(1.5);
		const low = sunColor(3);
		expect(low[0]).toBeGreaterThan(low[1]);
		expect(low[1]).toBeGreaterThan(low[2]);
		// red / blue ratio grows as the sun drops
		expect(low[0] / low[2]).toBeGreaterThan(noon[0] / noon[2]);
	});
	it("fades to black below the horizon and never goes negative", () => {
		const below = sunColor(-5);
		for (const c of below) expect(c).toBe(0);
		for (const e of [-1, 0, 2, 10, 45, 90])
			for (const c of sunColor(e)) expect(c).toBeGreaterThanOrEqual(0);
	});
	it("takes an ENU direction (elevation = asin of z) and normalises it", () => {
		const a = sunColor(30);
		const b = sunColor([
			0,
			Math.cos(Math.PI / 6) * 5,
			Math.sin(Math.PI / 6) * 5,
		]);
		for (let i = 0; i < 3; i++) expect(b[i]).toBeCloseTo(a[i], 9);
		expect(sunColor([0, 0, 0]).every(Number.isFinite)).toBe(true);
	});
	it("blue is always attenuated at least as much as red", () => {
		for (let e = 1; e <= 90; e += 7) {
			const c = sunColor(e);
			expect(c[2]).toBeLessThanOrEqual(c[0] + 1e-12);
		}
	});
});

describe("sunDirFromStyle", () => {
	const len = (v: number[]) => Math.hypot(v[0], v[1], v[2]);
	it("azel: azimuth clockwise from north, elevation up", () => {
		const n = sunDirFromStyle({ mode: "azel", azimuthDeg: 0, elevationDeg: 0 });
		expect(n[0]).toBeCloseTo(0, 12);
		expect(n[1]).toBeCloseTo(1, 12);
		const e = sunDirFromStyle({
			mode: "azel",
			azimuthDeg: 90,
			elevationDeg: 0,
		});
		expect(e[0]).toBeCloseTo(1, 12);
		const up = sunDirFromStyle({
			mode: "azel",
			azimuthDeg: 123,
			elevationDeg: 90,
		});
		expect(up[2]).toBeCloseTo(1, 12);
	});
	it("fixed is normalised; a zero vector does not produce NaN", () => {
		const d = sunDirFromStyle({ mode: "fixed", dir: [3, 4, 0] });
		expect(d[0]).toBeCloseTo(0.6, 12);
		expect(d[1]).toBeCloseTo(0.8, 12);
		expect(
			sunDirFromStyle({ mode: "fixed", dir: [0, 0, 0] }).every(Number.isFinite),
		).toBe(true);
	});
	it("photo-time with a context follows the sun, floored at 8° elevation", () => {
		const ctx = { takenAt: "2024-06-21T11:28:00Z", lat: 47.38, lon: 8.54 };
		const d = sunDirFromStyle({ mode: "photo-time" }, ctx);
		const p = sunPosition(ctx.takenAt, ctx.lat, ctx.lon);
		expect((Math.asin(d[2]) * 180) / Math.PI).toBeCloseTo(p.elevation, 6);
		const night = sunDirFromStyle(
			{ mode: "photo-time" },
			{ takenAt: "2024-06-21T23:30:00Z", lat: 47.38, lon: 8.54 },
		);
		expect((Math.asin(night[2]) * 180) / Math.PI).toBeCloseTo(8, 6);
		expect(len(night)).toBeCloseTo(1, 12);
	});
	it("photo-time without (or with a bad) context falls back to the classic direction", () => {
		const classic = sunDirFromStyle({ mode: "fixed", dir: [-0.5, -0.4, 0.75] });
		expect(sunDirFromStyle({ mode: "photo-time" })).toEqual(classic);
		expect(
			sunDirFromStyle(
				{ mode: "photo-time" },
				{ takenAt: "garbage", lat: 1, lon: 2 },
			),
		).toEqual(classic);
		expect(
			sunDirFromStyle(
				{ mode: "photo-time" },
				{ takenAt: "2024-06-21T11:28:00Z" },
			),
		).toEqual(classic);
	});
});
