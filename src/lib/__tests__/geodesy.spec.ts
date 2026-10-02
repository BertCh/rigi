// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { angleDiffDeg, seededRandom, uniform } from "#/test/helpers";
import {
	bearingDeg,
	DEG,
	destination,
	distanceBearing,
	distanceM,
	EARTH_R,
	EnuFrame,
	toEcef,
	WGS84,
	wrap180,
	wrap360,
} from "../geodesy";

const NIEDERHORN = { lat: 46.7107, lon: 7.7724 };

describe("wrap180 / wrap360", () => {
	it("wraps into [-180, 180) and [0, 360)", () => {
		expect(wrap180(190)).toBe(-170);
		expect(wrap180(-190)).toBe(170);
		expect(wrap180(180)).toBe(-180);
		expect(wrap360(-10)).toBe(350);
		expect(wrap360(720)).toBe(0);
	});
});

describe("toEcef", () => {
	it("puts the equator / prime meridian on +x at the semi-major axis", () => {
		const p = toEcef(0, 0, 0);
		const [x, y, z] = p;
		expect(x).toBeCloseTo(WGS84.A, 3);
		expect(y).toBeCloseTo(0, 6);
		expect(z).toBeCloseTo(0, 6);
	});
});

describe("EnuFrame", () => {
	it("round-trips geodetic → ENU → geodetic", () => {
		const frame = new EnuFrame(NIEDERHORN.lat, NIEDERHORN.lon, 1900);
		const rand = seededRandom(7);
		for (let i = 0; i < 20; i++) {
			const lat = NIEDERHORN.lat + uniform(rand, -0.5, 0.5);
			const lon = NIEDERHORN.lon + uniform(rand, -0.5, 0.5);
			const h = uniform(rand, 400, 4000);
			const enu = frame.fromGeo(lat, lon, h);
			const back = frame.toGeo(enu[0], enu[1], enu[2]);
			expect(back.lat).toBeCloseTo(lat, 7);
			expect(back.lon).toBeCloseTo(lon, 7);
			expect(back.h).toBeCloseTo(h, 1);
		}
	});
	it("maps the origin to (0, 0, 0)", () => {
		const frame = new EnuFrame(NIEDERHORN.lat, NIEDERHORN.lon, 1900);
		const enu = frame.fromGeo(NIEDERHORN.lat, NIEDERHORN.lon, 1900);
		for (const c of [enu[0], enu[1], enu[2]])
			expect(Math.abs(c)).toBeLessThan(1e-6);
	});
});

describe("distance and bearing", () => {
	it("one degree of latitude is about 111 km due north", () => {
		const a = { lat: 46, lon: 7 };
		const b = { lat: 47, lon: 7 };
		expect(distanceM(a, b)).toBeCloseTo(EARTH_R * DEG, 3);
		expect(bearingDeg(a, b)).toBeCloseTo(0, 9);
		const hb = distanceBearing(a.lat, a.lon, b.lat, b.lon);
		expect(hb.distance).toBeCloseTo(EARTH_R * DEG, 3);
		expect(hb.bearing).toBeCloseTo(0, 9);
	});
	it("destination inverts distanceBearing", () => {
		const rand = seededRandom(11);
		for (let i = 0; i < 25; i++) {
			const azimuth = uniform(rand, 0, 360);
			const distance = uniform(rand, 10, 200_000);
			const d = destination(NIEDERHORN.lat, NIEDERHORN.lon, azimuth, distance);
			const back = distanceBearing(
				NIEDERHORN.lat,
				NIEDERHORN.lon,
				d.lat,
				d.lon,
			);
			expect(back.distance).toBeCloseTo(distance, 3);
			expect(angleDiffDeg(back.bearing, azimuth)).toBeLessThan(1e-7);
		}
	});
	it("the equirectangular and haversine distances agree within 0.1% under 100 km", () => {
		const rand = seededRandom(3);
		for (let i = 0; i < 25; i++) {
			const d = destination(
				NIEDERHORN.lat,
				NIEDERHORN.lon,
				uniform(rand, 0, 360),
				uniform(rand, 1000, 100_000),
			);
			const flat = distanceM(NIEDERHORN, d);
			const sphere = distanceBearing(
				NIEDERHORN.lat,
				NIEDERHORN.lon,
				d.lat,
				d.lon,
			).distance;
			expect(Math.abs(flat - sphere) / sphere).toBeLessThan(1e-3);
		}
	});
});
