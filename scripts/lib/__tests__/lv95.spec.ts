// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { lonLatToLv95, lv95ToLonLat } from "../lv95";

// Same rigorous EPSG:2056 references as src/lib/concord/occl/__tests__/swiss-cog.spec.ts
// (name, lat, lon, E, N), from proj4 2.22.
const REFERENCES: [string, number, number, number, number][] = [
	["Bern", 46.9511, 7.4386, 2599997.533, 1200001.916],
	["Niederhorn", 46.7106, 7.7749, 2625712.958, 1173320.666],
	["Saentis", 47.2494, 9.3433, 2744175.278, 1234914.69],
	["Matterhorn", 45.9763, 7.6586, 2617047.961, 1091660.424],
	["Geneva", 46.2044, 6.1432, 2500016.016, 1117821.07],
	["Basel", 47.5596, 7.5886, 2611287.837, 1267664.847],
	["Chur", 46.8508, 9.532, 2759638.187, 1190980.851],
	["Lugano", 46.0037, 8.9511, 2717161.192, 1095811.548],
	["Muestair", 46.6297, 10.4467, 2830305.626, 1168687.859],
	["Schaffhausen", 47.6959, 8.6339, 2689726.006, 1283492.51],
];

describe("scripts/lib/lv95 (@math.gl/proj4)", () => {
	it.each(
		REFERENCES,
	)("%s: forward matches rigorous EPSG:2056 to 1 cm", (_name, lat, lon, E, N) => {
		const [easting, northing] = lonLatToLv95(lon, lat);
		expect(Math.abs(easting - E)).toBeLessThan(0.01);
		expect(Math.abs(northing - N)).toBeLessThan(0.01);
	});

	it.each(
		REFERENCES,
	)("%s: inverse returns [lon, lat] and closes the loop to 1 cm", (_name, lat, lon, E, N) => {
		const [lonBack, latBack] = lv95ToLonLat(E, N);
		expect(
			Math.abs(lonBack - lon) * 111_200 * Math.cos((lat * Math.PI) / 180),
		).toBeLessThan(0.01);
		expect(Math.abs(latBack - lat) * 111_200).toBeLessThan(0.01);
	});

	it("maps the LV95 origin to the Bern observatory, longitude first", () => {
		const [lon, lat] = lv95ToLonLat(2600000, 1200000);
		expect(lon).toBeCloseTo(7.438632, 5);
		expect(lat).toBeCloseTo(46.951083, 5);
	});
});
