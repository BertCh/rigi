// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import {
	buildPhotoMeta,
	captureTime,
	DEFAULT_F35,
	exifDiagnostics,
	MAX_PX,
	offsetFromLongitude,
	orientationFromGravity,
	outputSize,
	parseAppleMakerNote,
	readExif,
	vfovFromF35,
} from "../exif";

/** Build an "Apple iOS" MakerNote with one (S)RATIONAL tag, big- or little-endian. */
function makerNote(
	tag: number,
	values: number[],
	opts: { le?: boolean; signed?: boolean } = {},
) {
	const le = opts.le ?? false;
	const signed = opts.signed ?? true;
	const valOff = 16 + 12;
	const buf = new Uint8Array(valOff + values.length * 8);
	const dv = new DataView(buf.buffer);
	buf.set(new TextEncoder().encode("Apple iOS\0"), 0);
	buf.set(new TextEncoder().encode(le ? "II" : "MM"), 12);
	dv.setUint16(14, 1, le);
	dv.setUint16(16, tag, le);
	dv.setUint16(18, signed ? 10 : 5, le);
	dv.setUint32(20, values.length, le);
	dv.setUint32(24, valOff, le);
	values.forEach((v, i) => {
		const o = valOff + i * 8;
		if (signed) dv.setInt32(o, Math.round(v * 1000), le);
		else dv.setUint32(o, Math.round(v * 1000), le);
		dv.setUint32(o + 4, 1000, le);
		if (signed) dv.setInt32(o + 4, 1000, le);
	});
	return buf;
}

describe("parseAppleMakerNote", () => {
	it("reads signed rationals in both byte orders", () => {
		for (const le of [false, true]) {
			const r = parseAppleMakerNote(
				makerNote(0x0008, [0.1, -0.5, -0.85], { le }),
			);
			expect(r[0x0008]).toEqual([0.1, -0.5, -0.85]);
		}
	});
	it("reads unsigned rationals", () => {
		expect(
			parseAppleMakerNote(makerNote(0x0003, [2.5], { signed: false }))[3],
		).toEqual([2.5]);
	});
	it("returns {} for a non-Apple or short buffer", () => {
		expect(parseAppleMakerNote(new Uint8Array(40))).toEqual({});
		expect(parseAppleMakerNote(new TextEncoder().encode("Apple iOS"))).toEqual(
			{},
		);
	});
	it("skips a tag whose value offset runs past the buffer, and guards zero denominators", () => {
		const m = makerNote(0x0008, [0, 0, 0]);
		new DataView(m.buffer).setUint32(24, 9999, false);
		expect(parseAppleMakerNote(m)).toEqual({});
		const z = makerNote(0x0008, [1]);
		new DataView(z.buffer).setInt32(28 + 4, 0, false);
		expect(parseAppleMakerNote(z)[8]).toEqual([0]);
	});
	it("stops at a truncated entry table", () => {
		const m = makerNote(0x0008, [1, 2, 3]).slice(0, 20);
		expect(parseAppleMakerNote(m)).toEqual({});
	});
});

describe("orientationFromGravity", () => {
	it("is null without a gravity vector", () => {
		expect(orientationFromGravity(null, 400, 300)).toBeNull();
	});
	it("portrait, phone upright, camera level: pitch 0 roll 0", () => {
		const r = orientationFromGravity([0, -1, 0], 300, 400);
		expect(r?.holding).toBe("portrait");
		expect(r?.pitch).toBeCloseTo(0, 9);
		expect(r?.roll).toBeCloseTo(0, 9);
	});
	it("tilting the top back (camera up) gives positive pitch", () => {
		// camera looks along -z; gravity +z component = camera pointing up
		const r = orientationFromGravity(
			[0, -Math.cos(0.3), -Math.sin(0.3)],
			300,
			400,
		);
		expect(r?.pitch).toBeCloseTo(-17.19, 1);
		const up = orientationFromGravity(
			[0, -Math.cos(0.3), Math.sin(0.3)],
			300,
			400,
		);
		expect(up?.pitch).toBeCloseTo(17.19, 1);
	});
	it("picks a landscape holding for a landscape image and matches gravity", () => {
		expect(orientationFromGravity([-1, 0, 0], 400, 300)?.holding).toBe(
			"landscape-right",
		);
		expect(orientationFromGravity([1, 0, 0], 400, 300)?.holding).toBe(
			"landscape-left",
		);
		expect(orientationFromGravity([0, 1, 0], 300, 400)?.holding).toBe(
			"portrait-upside",
		);
	});
	it("only considers holdings matching the displayed aspect", () => {
		expect(orientationFromGravity([-1, 0, 0], 300, 400)?.holding).toMatch(
			/^portrait/,
		);
	});
	it("is scale invariant and handles a zero vector without NaN", () => {
		const a = orientationFromGravity([0, -1, -0.2], 300, 400);
		const b = orientationFromGravity([0, -5, -1], 300, 400);
		expect(a?.pitch).toBeCloseTo(b?.pitch ?? Number.NaN, 9);
		const z = orientationFromGravity([0, 0, 0], 300, 400);
		expect(Number.isFinite(z?.pitch)).toBe(true);
	});
	it("roll sign follows the right-hand side dropping", () => {
		const r = orientationFromGravity(
			[-Math.sin(0.1), -Math.cos(0.1), 0],
			300,
			400,
		);
		expect(Math.abs(r?.roll ?? 0)).toBeCloseTo(5.73, 1);
	});
});

describe("vfovFromF35", () => {
	it("matches the full-frame diagonal formula without crop info", () => {
		// 4:3, f35 = 26 mm: diagonal 43.27 mm, f_px = 26 * 5000 / 43.27
		const v = vfovFromF35(26, 4000, 3000);
		const fPx = (26 * 5000) / 43.2666;
		expect(v).toBeCloseTo((2 * Math.atan(1500 / fPx) * 180) / Math.PI, 2);
		expect(v).toBeGreaterThan(40);
		expect(v).toBeLessThan(60);
	});
	it("a longer lens gives a narrower field of view", () => {
		expect(vfovFromF35(52, 4000, 3000)).toBeLessThan(
			vfovFromF35(26, 4000, 3000),
		);
	});
	it("takes the cropped sensor into account", () => {
		// a 16:9 crop of a 4:3 sensor, kept at native pitch then downscaled to 2048 px
		const naive = vfovFromF35(26, 2048, 1152);
		const cropped = vfovFromF35(
			26,
			2048,
			1152,
			{ width: 4032, height: 3024 },
			{ width: 3840, height: 2160 },
		);
		expect(cropped).toBeLessThan(naive);
		// a same-aspect resample is not a crop
		expect(
			vfovFromF35(
				26,
				2048,
				1536,
				{ width: 4032, height: 3024 },
				{ width: 4032, height: 3024 },
			),
		).toBeCloseTo(vfovFromF35(26, 2048, 1536), 9);
	});
});

describe("outputSize", () => {
	it("keeps small images and caps the long side at MAX_PX", () => {
		expect(outputSize(1000, 500)).toEqual({ width: 1000, height: 500 });
		expect(outputSize(4000, 3000)).toEqual({ width: MAX_PX, height: 1536 });
		expect(outputSize(3000, 4000)).toEqual({ width: 1536, height: MAX_PX });
	});
	it("swaps for EXIF orientations 5-8", () => {
		expect(outputSize(4000, 3000, 6)).toEqual({ width: 1536, height: MAX_PX });
		for (const o of [1, 2, 3, 4])
			expect(outputSize(4000, 3000, o).width).toBe(MAX_PX);
		for (const o of [5, 6, 7, 8])
			expect(outputSize(4000, 3000, o).height).toBe(MAX_PX);
	});
	it("honours a custom cap", () => {
		expect(outputSize(1000, 500, 1, 100)).toEqual({ width: 100, height: 50 });
	});
});

describe("captureTime", () => {
	it("prefers GPS date + time (UTC) with fractional seconds", () => {
		const r = captureTime({
			GPSDateStamp: "2023:07:01",
			GPSTimeStamp: [10, 20, 30.5],
			OffsetTimeOriginal: "+02:00",
		});
		expect(r).toEqual({
			utc: "2023-07-01T10:20:30.500Z",
			offset: "+02:00",
			source: "gps",
		});
	});
	it("uses DateTimeOriginal with its offset", () => {
		const r = captureTime({
			DateTimeOriginal: "2023:07:01 12:20:30",
			OffsetTimeOriginal: "+02:00",
		});
		expect(r).toEqual({
			utc: "2023-07-01T10:20:30.000Z",
			offset: "+02:00",
			source: "exif",
		});
	});
	it("falls back to OffsetTime", () => {
		expect(
			captureTime({
				DateTimeOriginal: "2023:07:01 12:20:30",
				OffsetTime: "-07:00",
			}).utc,
		).toBe("2023-07-01T19:20:30.000Z");
	});
	it("flags a zone-less time as exif-local read as UTC", () => {
		const r = captureTime({ DateTimeOriginal: "2023:07:01 12:20:30" });
		expect(r).toEqual({
			utc: "2023-07-01T12:20:30.000Z",
			offset: null,
			source: "exif-local",
		});
	});
	it("is all null when there is nothing usable", () => {
		expect(captureTime({})).toEqual({ utc: null, offset: null, source: null });
		expect(captureTime({ DateTimeOriginal: "garbage here" }).utc).toBeNull();
	});
	it("a GPS stamp with a bad date falls through to DateTimeOriginal", () => {
		const r = captureTime({
			GPSDateStamp: "xx:yy:zz",
			GPSTimeStamp: [1, 2, 3],
			DateTimeOriginal: "2023:07:01 12:20:30",
		});
		expect(r.source).toBe("exif-local");
	});
});

describe("offsetFromLongitude", () => {
	it("rounds to whole hours and formats as ±HH:00", () => {
		expect(offsetFromLongitude(8.6)).toBe("+01:00");
		expect(offsetFromLongitude(-111.6)).toBe("-07:00");
		expect(offsetFromLongitude(0)).toBe("+00:00");
		expect(offsetFromLongitude(7.4)).toBe("+00:00");
		expect(offsetFromLongitude(7.6)).toBe("+01:00");
	});
	it("clamps to -12..+14", () => {
		expect(offsetFromLongitude(-179)).toBe("-12:00");
		expect(offsetFromLongitude(179)).toBe("+12:00");
		expect(offsetFromLongitude(1000)).toBe("+14:00");
	});
});

describe("buildPhotoMeta", () => {
	const gravityNote = makerNote(0x0008, [0, -1, -0.1]);
	const full = {
		latitude: 46.9,
		longitude: 8.2,
		GPSAltitude: 1200.5,
		GPSAltitudeRef: 0,
		GPSHPositioningError: 4.2,
		GPSImgDirection: 123.4,
		GPSImgDirectionRef: "T",
		FocalLengthIn35mmFormat: 26,
		makerNote: gravityNote,
	};
	const raw = {
		GPSDateStamp: "2023:07:01",
		GPSTimeStamp: [10, 0, 0],
		OffsetTimeOriginal: "+02:00",
	};
	const o = { id: "local-abc", width: 1536, height: 2048 };

	it("assembles a fully-tagged photo", () => {
		const m = buildPhotoMeta(full, raw, o);
		expect(m).toMatchObject({
			id: "local-abc",
			lat: 46.9,
			lon: 8.2,
			alt: 1200.5,
			hAccuracy: 4.2,
			heading: 123.4,
			f35: 26,
			takenAt: "2023-07-01T10:00:00.000Z",
			takenAtUtc: "2023-07-01T10:00:00.000Z",
			tzOffset: "+02:00",
			holding: "portrait",
			src: "",
			region: "",
		});
		expect(m.local).toMatchObject({
			yawUnknown: false,
			pitchRollUnknown: false,
			focalUnknown: false,
			positionSource: "exif",
			timeSource: "gps",
			headingRef: "T",
		});
		expect(m.gravity).toEqual([0, -1, -0.1]);
		expect(m.pitch).toBeCloseTo(-5.74, 1);
		expect(m.vfov).toBeGreaterThan(40);
	});
	it("flags every missing field and falls back to defaults", () => {
		const m = buildPhotoMeta(
			{},
			{},
			{ ...o, fallbackTime: Date.UTC(2020, 0, 2) },
		);
		expect(Number.isNaN(m.lat)).toBe(true);
		expect(m.f35).toBe(DEFAULT_F35);
		expect(m.heading).toBeNull();
		expect(m.gravity).toBeNull();
		expect([m.pitch, m.roll, m.holding]).toEqual([0, 0, null]);
		expect(m.takenAt).toBe("2020-01-02T00:00:00.000Z");
		expect(m.local).toMatchObject({
			yawUnknown: true,
			pitchRollUnknown: true,
			focalUnknown: true,
			positionSource: "pin",
			timeSource: "file",
			headingRef: null,
		});
	});
	it("a non-positive or non-finite focal counts as unknown", () => {
		for (const f of [0, -5, Number.NaN]) {
			const m = buildPhotoMeta({ ...full, FocalLengthIn35mmFormat: f }, raw, o);
			expect(m.f35).toBe(DEFAULT_F35);
			expect(m.local.focalUnknown).toBe(true);
		}
	});
	it("a pinned position replaces EXIF GPS and drops altitude and accuracy", () => {
		const m = buildPhotoMeta(full, raw, { ...o, position: { lat: 1, lon: 2 } });
		expect([m.lat, m.lon, m.alt, m.hAccuracy]).toEqual([1, 2, null, null]);
		expect(m.local.positionSource).toBe("pin");
	});
	it("a pin on a photo with no GPS also has no altitude", () => {
		const m = buildPhotoMeta({ GPSAltitude: 500 }, raw, {
			...o,
			position: { lat: 1, lon: 2 },
		});
		expect(m.alt).toBeNull();
	});
	it("applies GPSAltitudeRef 1 (below sea level), as number or byte array", () => {
		expect(
			buildPhotoMeta({ ...full, GPSAltitude: 30, GPSAltitudeRef: 1 }, raw, o)
				.alt,
		).toBe(-30);
		expect(
			buildPhotoMeta(
				{ ...full, GPSAltitude: 30, GPSAltitudeRef: Uint8Array.of(1) },
				raw,
				o,
			).alt,
		).toBe(-30);
		expect(
			buildPhotoMeta(
				{ ...full, GPSAltitude: 30, GPSAltitudeRef: Uint8Array.of(0) },
				raw,
				o,
			).alt,
		).toBe(30);
	});
	it("ignores a non-finite altitude", () => {
		expect(
			buildPhotoMeta({ ...full, GPSAltitude: Number.NaN }, raw, o).alt,
		).toBeNull();
	});
	it("a zone-less capture time is shifted by a longitude-based zone and flagged", () => {
		const m = buildPhotoMeta(
			full,
			{ DateTimeOriginal: "2023:07:01 12:00:00" },
			o,
		);
		expect(m.tzOffset).toBe("+01:00");
		expect(m.takenAt).toBe("2023-07-01T11:00:00.000Z");
		expect(m.local).toMatchObject({
			timeSource: "exif-local",
			tzEstimated: true,
		});
	});
	it("does not flag tzEstimated for gps or offset-carrying times", () => {
		expect("tzEstimated" in buildPhotoMeta(full, raw, o).local).toBe(false);
	});
	it("records file info and src/region options", () => {
		const m = buildPhotoMeta(full, raw, {
			...o,
			src: "blob:x",
			region: "local-region-1",
			file: { name: "a.heic", type: "image/heic", bytes: 99 },
		});
		expect([m.src, m.region]).toEqual(["blob:x", "local-region-1"]);
		expect(m.local).toMatchObject({
			fileName: "a.heic",
			fileType: "image/heic",
			fileBytes: 99,
		});
		expect(m.local.addedAt).toBeGreaterThan(0);
	});
	it("a cropped source narrows the vfov estimate versus ignoring the crop", () => {
		const tags = { ...full, ExifImageWidth: 4032, ExifImageHeight: 3024 };
		const cropped = buildPhotoMeta(tags, raw, {
			...o,
			width: 2048,
			height: 1152,
			sourceWidth: 3840,
			sourceHeight: 2160,
		});
		const uncropped = buildPhotoMeta(full, raw, {
			...o,
			width: 2048,
			height: 1152,
		}); // no sensor size: plain diagonal formula
		expect(cropped.vfov).toBeLessThan(uncropped.vfov);
	});
});

describe("exifDiagnostics", () => {
	it("reports what the file provided", () => {
		const d = exifDiagnostics(
			{
				latitude: 1,
				longitude: 2,
				GPSImgDirection: 10,
				GPSImgDirectionRef: "M",
				FocalLengthIn35mmFormat: 26,
				Make: "Apple",
				Model: "iPhone 15",
				GPSHPositioningError: 3,
				makerNote: makerNote(8, [0, -1, 0]),
			},
			{ DateTimeOriginal: "2023:07:01 12:00:00" },
		);
		expect(d).toEqual({
			hasExif: true,
			hasGps: true,
			hasHeading: true,
			hasGravity: true,
			hasF35: true,
			isApple: true,
			model: "iPhone 15",
			headingMagnetic: true,
			zonelessTime: true,
			gpsAccuracy: 3,
		});
	});
	it("reports an empty file", () => {
		const d = exifDiagnostics({});
		expect(d).toMatchObject({
			hasExif: false,
			hasGps: false,
			hasHeading: false,
			hasGravity: false,
			hasF35: false,
			isApple: false,
			model: null,
			zonelessTime: false,
			gpsAccuracy: null,
		});
	});
	it("is not zoneless when an offset is present", () => {
		expect(
			exifDiagnostics(
				{},
				{ DateTimeOriginal: "2023:07:01 12:00:00", OffsetTime: "+01:00" },
			).zonelessTime,
		).toBe(false);
	});
});

describe("readExif", () => {
	it("returns empty tags for bytes that are not an image", async () => {
		const r = await readExif(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]));
		expect(r).toEqual({ tags: {}, raw: {} });
	});
});
