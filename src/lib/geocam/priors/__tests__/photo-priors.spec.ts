// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { IDX, NP } from "../../core";
import {
	mapPriorsFromPhoto,
	type PriorPhoto,
	sigmaHFromHAcc,
} from "../photo-priors";

const photo: PriorPhoto = {
	lat: 46.7,
	lon: 7.8,
	alt: 1500,
	hAccuracy: 8,
	heading: 120,
	pitch: 2,
	roll: -1,
	gravity: [0, 0, -1],
	takenAt: "2025-08-01T12:00:00Z",
	takenAtUtc: "2025-08-01T12:00:00Z",
};
const eye0: [number, number, number] = [5, -7, 1500];
const fams = (fs: { family: string }[]) => fs.map((f) => f.family);

describe("sigmaHFromHAcc", () => {
	it("clamps to [5, 100] and defaults to 20", () => {
		expect(sigmaHFromHAcc(null)).toBe(20);
		expect(sigmaHFromHAcc(undefined)).toBe(20);
		expect(sigmaHFromHAcc(0)).toBe(20);
		expect(sigmaHFromHAcc(-3)).toBe(20);
		expect(sigmaHFromHAcc(Number.NaN)).toBe(20);
		expect(sigmaHFromHAcc(1)).toBe(5);
		expect(sigmaHFromHAcc(8)).toBe(8);
		expect(sigmaHFromHAcc(900)).toBe(100);
	});
});

describe("mapPriorsFromPhoto", () => {
	it("builds gps, alt, gravity and compass priors for a full photo", () => {
		const fs = mapPriorsFromPhoto(photo, eye0);
		expect(fams(fs)).toEqual(["gps", "alt", "gravity", "compass"]);
		expect(fs.every((f) => f.prior)).toBe(true);
	});
	it("the gps prior is centred on the starting eye with the hAcc sigma", () => {
		const gps = mapPriorsFromPhoto(photo, eye0)[0];
		const x = new Float64Array(NP);
		x[IDX.E] = 5 + 8;
		x[IDX.N] = -7;
		const r = gps.residual(x);
		expect(r[0]).toBeCloseTo(1, 12);
		expect(r[1]).toBeCloseTo(0, 12);
	});
	it("a pinned position drops the gps and alt priors", () => {
		const fs = mapPriorsFromPhoto(
			{ ...photo, local: { positionSource: "pin" } },
			eye0,
		);
		expect(fams(fs)).toEqual(["gravity", "compass"]);
	});
	it("unknown yaw / pitch-roll drop their priors; skip list removes families", () => {
		expect(
			fams(mapPriorsFromPhoto({ ...photo, local: { yawUnknown: true } }, eye0)),
		).not.toContain("compass");
		expect(
			fams(
				mapPriorsFromPhoto(
					{ ...photo, local: { pitchRollUnknown: true } },
					eye0,
				),
			),
		).not.toContain("gravity");
		expect(
			fams(mapPriorsFromPhoto({ ...photo, gravity: null }, eye0)),
		).not.toContain("gravity");
		expect(
			fams(mapPriorsFromPhoto(photo, eye0, null, { skip: ["gps", "alt"] })),
		).toEqual(["gravity", "compass"]);
		expect(
			fams(mapPriorsFromPhoto({ ...photo, heading: null }, eye0)),
		).not.toContain("compass");
	});
	it("a null altitude drops the alt prior", () => {
		expect(
			fams(mapPriorsFromPhoto({ ...photo, alt: null }, eye0)),
		).not.toContain("alt");
	});
	it("adds ground, focal and lake-floor priors when supplied", () => {
		const fs = mapPriorsFromPhoto(photo, eye0, () => 1400, {
			focal: { f0Px1600: 1500, fPx1600: 1520, sigmaPx1600: 20 },
			lakeFloorM: 1495,
		});
		expect(fams(fs)).toEqual([
			"gps",
			"alt",
			"ground",
			"gravity",
			"compass",
			"focal",
			"lakeFloor",
		]);
	});
	it("shifts absolute altitudes by zDatum", () => {
		const alt = (zDatum: number) =>
			mapPriorsFromPhoto(photo, eye0, null, { zDatum }).find(
				(f) => f.family === "alt",
			);
		const x = new Float64Array(NP);
		const r0 = (alt(0)?.residual(x) as Float64Array)[0];
		const r1 = (alt(1000)?.residual(x) as Float64Array)[0];
		// residual = (U - mu) / sigmaA and mu drops by zDatum, so the residual rises by zDatum / sigmaA
		expect(r1 - r0).toBeCloseTo(-(-1000) / 3, 9);
	});
	it("ignores the lake floor when not finite", () => {
		expect(
			fams(mapPriorsFromPhoto(photo, eye0, null, { lakeFloorM: Number.NaN })),
		).not.toContain("lakeFloor");
	});
});
