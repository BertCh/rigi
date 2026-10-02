// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import type { PhotoMeta } from "#/lib/photos";
import { withFlags } from "#/test/helpers";
import { photoUnknowns, positionSource } from "../unknown-pose";

const photo = (over: Record<string, unknown> = {}) =>
	({
		id: "p",
		src: "",
		width: 4000,
		height: 3000,
		takenAt: "2025-08-01T12:00:00Z",
		takenAtUtc: "2025-08-01T12:00:00Z",
		lat: 46.7,
		lon: 7.8,
		alt: 1500,
		hAccuracy: 5,
		heading: 120,
		f35: 26,
		vfov: 40,
		gravity: [0, 0, -1],
		pitch: 0,
		roll: 0,
		holding: null,
		region: "x",
		...over,
	}) as unknown as PhotoMeta;

describe("photoUnknowns", () => {
	it("reports nothing unknown for a fully tagged photo", () => {
		expect(photoUnknowns(photo())).toEqual({
			yaw: false,
			gravity: false,
			focal: false,
			any: false,
		});
	});
	it("flags yaw when the heading is missing or marked unknown", () => {
		expect(photoUnknowns(photo({ heading: null })).yaw).toBe(true);
		expect(photoUnknowns(photo({ local: { yawUnknown: true } })).yaw).toBe(
			true,
		);
	});
	it("flags gravity when absent or marked unknown", () => {
		expect(photoUnknowns(photo({ gravity: null })).gravity).toBe(true);
		expect(
			photoUnknowns(photo({ local: { pitchRollUnknown: true } })).gravity,
		).toBe(true);
	});
	it("flags focal only from the local flag", () => {
		expect(
			photoUnknowns(photo({ local: { focalUnknown: true } })),
		).toMatchObject({ focal: true, any: true });
	});
	it("`any` is the OR of the three", () => {
		const u = photoUnknowns(photo({ gravity: null }));
		expect(u.any).toBe(u.yaw || u.gravity || u.focal);
		expect(u.any).toBe(true);
	});
	it("a heading that only exists as a magnetic ref still counts as known", () => {
		withFlags({ geoDecl: "on" });
		expect(photoUnknowns(photo({ local: { headingRef: "M" } })).yaw).toBe(
			false,
		);
	});
});

describe("positionSource", () => {
	it("is manual only for a user pin", () => {
		expect(positionSource(photo({ local: { positionSource: "pin" } }))).toBe(
			"manual",
		);
		expect(positionSource(photo({ local: { positionSource: "exif" } }))).toBe(
			"exif-gps",
		);
		expect(positionSource(photo())).toBe("exif-gps");
	});
});
