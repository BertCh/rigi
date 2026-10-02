// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { buildCameraModel } from "../camera";
import { buildXmp, RIGI_NS, xmpGpsCoord } from "../xmp";
import { FIXTURE, parseXml, SOUTH } from "./fixtures";

/** Parse an EXIF-XMP "DDD,MM.mmmmmmR" coordinate back to signed degrees. */
function parseGps(s: string) {
	const m = /^(\d+),(\d+\.\d{6})([NSEW])$/.exec(s);
	if (!m) throw new Error(`bad coord ${s}`);
	const v = Number(m[1]) + Number(m[2]) / 60;
	return m[3] === "S" || m[3] === "W" ? -v : v;
}

describe("xmpGpsCoord", () => {
	it("formats degrees and decimal minutes with hemisphere letters", () => {
		expect(xmpGpsCoord(46.5, "N", "S")).toBe("46,30.000000N");
		expect(xmpGpsCoord(-33.9, "N", "S")).toBe("33,54.000000S");
		expect(xmpGpsCoord(-0.25, "E", "W")).toBe("0,15.000000W");
		expect(xmpGpsCoord(0, "E", "W")).toBe("0,0.000000E");
	});
	it("carries 59.9999995 minutes into the degree", () => {
		expect(xmpGpsCoord(10 + 59.9999999 / 60, "N", "S")).toBe("11,0.000000N");
	});
	it("round-trips to within a micro-minute", () => {
		for (const d of [46.97596111, -121.3333, 8.668494, 179.99999, -0.000001]) {
			expect(Math.abs(parseGps(xmpGpsCoord(d, "E", "W")) - d)).toBeLessThan(
				1e-7,
			);
		}
	});
});

describe("buildXmp", () => {
	const xmp = buildXmp(FIXTURE);
	const { root, attrs } = parseXml(xmp);
	const d = attrs.find((a) => a._tag === "rdf:Description") ?? {};
	const m = buildCameraModel(FIXTURE);
	it("is well-formed with an xmpmeta root and the three namespaces", () => {
		expect(root).toBe("x:xmpmeta");
		expect(d["xmlns:exif"]).toBe("http://ns.adobe.com/exif/1.0/");
		expect(d["xmlns:GPano"]).toBe("http://ns.google.com/photos/1.0/panorama/");
		expect(d["xmlns:rigi"]).toBe(RIGI_NS);
	});
	it("round-trips GPS lat/lon", () => {
		expect(parseGps(d["exif:GPSLatitude"])).toBeCloseTo(m.lat, 6);
		expect(parseGps(d["exif:GPSLongitude"])).toBeCloseTo(m.lon, 6);
		expect(d["exif:GPSLatitude"].endsWith("N")).toBe(true);
		expect(d["exif:GPSLongitude"].endsWith("E")).toBe(true);
	});
	it("writes altitude as an EXIF rational above sea level", () => {
		expect(d["exif:GPSAltitudeRef"]).toBe("0");
		expect(d["exif:GPSAltitude"]).toBe("1361300/1000");
	});
	it("writes heading in hundredths and the GPano pose", () => {
		expect(d["exif:GPSImgDirection"]).toBe("2084/100");
		expect(d["exif:GPSImgDirectionRef"]).toBe("T");
		expect(d["GPano:PoseHeadingDegrees"]).toBe("20.84");
		expect(d["GPano:PosePitchDegrees"]).toBe("-3.41");
		expect(d["GPano:PoseRollDegrees"]).toBe("-0.73");
		expect(d["GPano:UsePanoramaViewer"]).toBe("False");
	});
	it("serialises the full model numerically", () => {
		expect(Number(d["rigi:VerticalFOV"])).toBeCloseTo(53.06, 5);
		expect(Number(d["rigi:FocalLengthPixels"])).toBeCloseTo(m.f, 3);
		expect(d["rigi:ImageWidth"]).toBe("4032");
		expect(d["rigi:CameraCenterECEF"].split(" ").map(Number)).toEqual(
			m.C_ecef.map((v) => Number(v.toFixed(4))),
		);
		const R = d["rigi:RotationCameraToECEF"].split(" ").map(Number);
		expect(R).toHaveLength(9);
		for (let i = 0; i < 9; i++) expect(R[i]).toBeCloseTo(m.R_cam2ecef[i], 11);
	});
	it("includes the capture time only when known", () => {
		expect(d["exif:GPSTimeStamp"]).toBe("2023-07-01T10:20:30Z");
		expect(buildXmp(SOUTH)).not.toContain("GPSTimeStamp");
	});
	it("uses S/W hemispheres in the southern/western case", () => {
		const s = parseXml(
			buildXmp({ ...SOUTH, frame: { lat: -33.9, lon: -70.6, h: 0 } }),
		).attrs.find((a) => a._tag === "rdf:Description");
		expect(s?.["exif:GPSLatitude"].endsWith("S")).toBe(true);
		expect(s?.["exif:GPSLongitude"].endsWith("W")).toBe(true);
	});
	it("flags negative altitude with AltitudeRef 1", () => {
		const s = parseXml(buildXmp({ ...FIXTURE, eye: [0, 0, -50] })).attrs.find(
			(a) => a._tag === "rdf:Description",
		);
		expect(s?.["exif:GPSAltitudeRef"]).toBe("1");
		expect(s?.["exif:GPSAltitude"]).toBe("50000/1000");
	});
	it("never prints a heading of 360.00", () => {
		const s = parseXml(
			buildXmp({ ...FIXTURE, pose: { ...FIXTURE.pose, yaw: 359.999999 } }),
		).attrs.find((a) => a._tag === "rdf:Description");
		expect(s?.["exif:GPSImgDirection"]).toBe("0/100");
	});
	it("escapes a hostile timestamp", () => {
		const x = buildXmp({ ...FIXTURE, takenAt: 'a"b<c&' });
		parseXml(x);
		expect(x).toContain("a&quot;b&lt;c&amp;");
	});
});
