// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import type { PhotoMeta } from "../../../photos";
import type { RollPhoto } from "../../types";
import {
	aspectOf,
	compassPoint,
	dayKey,
	fmtDateSpan,
	fmtDistance,
	localWallClock,
	POSE_SOURCE_CLASS,
	POSE_SOURCE_COLOR,
	POSE_SOURCE_HINT,
	POSE_SOURCE_LABEL,
	POSE_SOURCES,
	VIEWPOINT_COLORS,
	vpColor,
} from "../style";

const meta = (takenAt: string, tzOffset: string | null, o = {}): PhotoMeta =>
	({
		id: "a",
		src: "a.jpg",
		width: 4000,
		height: 3000,
		takenAt,
		tzOffset,
		...o,
	}) as PhotoMeta;
const rp = (m: PhotoMeta): RollPhoto =>
	({ meta: m, pose: {}, poseSource: "prior" }) as unknown as RollPhoto;

describe("vpColor", () => {
	it("cycles through the palette, including negative indices", () => {
		expect(vpColor(0)).toBe(VIEWPOINT_COLORS[0]);
		expect(vpColor(VIEWPOINT_COLORS.length)).toBe(VIEWPOINT_COLORS[0]);
		expect(vpColor(-1)).toBe(VIEWPOINT_COLORS[VIEWPOINT_COLORS.length - 1]);
		expect(new Set(VIEWPOINT_COLORS).size).toBe(VIEWPOINT_COLORS.length);
	});
});

describe("pose source tables", () => {
	it("cover the same four sources with labels, hints, classes and colours", () => {
		expect([...POSE_SOURCES].sort()).toEqual(
			["saved", "ground-truth", "solved", "prior"].sort(),
		);
		for (const s of POSE_SOURCES) {
			expect(POSE_SOURCE_LABEL[s]).toBeTruthy();
			expect(POSE_SOURCE_HINT[s]).toBeTruthy();
			expect(POSE_SOURCE_CLASS[s]).toBeTruthy();
			expect(POSE_SOURCE_COLOR[s]).toMatch(/^#[0-9a-f]{6}$/);
		}
	});
});

describe("compassPoint", () => {
	it.each([
		[0, "N"],
		[90, "E"],
		[180, "S"],
		[270, "W"],
		[45, "NE"],
		[359, "N"],
		[-90, "W"],
		[450, "E"],
		[11.2, "N"],
		[11.3, "NNE"],
	])("%f deg is %s", (deg, name) => {
		expect(compassPoint(deg)).toBe(name);
	});
});

describe("local wall-clock time", () => {
	it("shifts UTC by the photo's offset, either sign", () => {
		expect(
			localWallClock(meta("2026-09-07T10:00:00Z", "+02:00")).toISOString(),
		).toBe("2026-09-07T12:00:00.000Z");
		expect(
			localWallClock(meta("2026-09-07T10:00:00Z", "-05:30")).toISOString(),
		).toBe("2026-09-07T04:30:00.000Z");
	});
	it("treats a missing or malformed offset as UTC", () => {
		expect(
			localWallClock(meta("2026-09-07T10:00:00Z", null)).toISOString(),
		).toBe("2026-09-07T10:00:00.000Z");
		expect(
			localWallClock(meta("2026-09-07T10:00:00Z", "CEST")).toISOString(),
		).toBe("2026-09-07T10:00:00.000Z");
	});
	it("dayKey rolls over on the local date, not the UTC date", () => {
		expect(dayKey(meta("2026-09-07T23:30:00Z", "+02:00"))).toBe("2026-09-08");
		expect(dayKey(meta("2026-09-07T01:30:00Z", "-05:00"))).toBe("2026-09-06");
	});
});

describe("fmtDateSpan", () => {
	it("is empty for no photos", () => {
		expect(fmtDateSpan([])).toBe("");
	});
	it("gives one date for a one-day roll and a range across days", () => {
		const one = fmtDateSpan([
			rp(meta("2026-09-07T08:00:00Z", "+02:00")),
			rp(meta("2026-09-07T12:00:00Z", "+02:00")),
		]);
		expect(one).toContain("2026");
		expect(one).not.toContain("–");
		const two = fmtDateSpan([
			rp(meta("2026-09-06T08:00:00Z", "+02:00")),
			rp(meta("2026-09-07T12:00:00Z", "+02:00")),
		]);
		expect(two).toContain("–");
		expect(two.match(/2026/g)).toHaveLength(1);
	});
});

describe("fmtDistance and aspectOf", () => {
	it.each([
		[0, "0 m"],
		[349.6, "350 m"],
		[999, "999 m"],
		[1000, "1.0 km"],
		[9949, "9.9 km"],
		[10_400, "10 km"],
		[123_456, "123 km"],
	])("%f m reads %s", (m, s) => {
		expect(fmtDistance(m)).toBe(s);
	});
	it("aspectOf is width over height", () => {
		expect(aspectOf(rp(meta("2026-09-07T08:00:00Z", null)))).toBeCloseTo(4 / 3);
	});
});
