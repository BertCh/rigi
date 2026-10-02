// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { buildCameraModel, fixedAzimuth } from "../camera";
import { buildKmz, buildPhotoOverlayKml, kmzBlob, xmlEscape } from "../kml";
import { crc32 } from "../zip";
import { FIXTURE, parseXml, readZip, SOUTH, tagText } from "./fixtures";

describe("xmlEscape", () => {
	it("escapes the five XML specials, & first", () => {
		expect(xmlEscape(`a&b<c>"d"'e'`)).toBe(
			"a&amp;b&lt;c&gt;&quot;d&quot;&apos;e&apos;",
		);
		expect(xmlEscape("&lt;")).toBe("&amp;lt;");
	});
});

describe("buildPhotoOverlayKml", () => {
	const kml = buildPhotoOverlayKml(FIXTURE);
	const m = buildCameraModel(FIXTURE);
	it("is well-formed KML 2.2 with a PhotoOverlay", () => {
		const { root, attrs } = parseXml(kml);
		expect(root).toBe("kml");
		expect(attrs[0].xmlns).toBe("http://www.opengis.net/kml/2.2");
		expect(attrs.some((a) => a._tag === "PhotoOverlay")).toBe(true);
	});
	it("encodes camera position and angles with the KML conventions", () => {
		expect(Number(tagText(kml, "longitude"))).toBeCloseTo(m.lon, 8);
		expect(Number(tagText(kml, "latitude"))).toBeCloseTo(m.lat, 8);
		expect(Number(tagText(kml, "altitude"))).toBeCloseTo(m.altMsl, 5);
		expect(tagText(kml, "heading")).toBe(fixedAzimuth(FIXTURE.pose.yaw, 6));
		expect(Number(tagText(kml, "tilt"))).toBeCloseTo(90 - 3.41, 6);
		expect(Number(tagText(kml, "roll"))).toBeCloseTo(0.73, 6);
		expect(tagText(kml, "altitudeMode")).toBe("absolute");
	});
	it("has a symmetric view volume matching hfov/vfov", () => {
		expect(Number(tagText(kml, "rightFov"))).toBeCloseTo(m.hfov / 2, 5);
		expect(Number(tagText(kml, "leftFov"))).toBeCloseTo(-m.hfov / 2, 5);
		expect(Number(tagText(kml, "topFov"))).toBeCloseTo(m.vfov / 2, 5);
		expect(Number(tagText(kml, "bottomFov"))).toBeCloseTo(-m.vfov / 2, 5);
		expect(tagText(kml, "near")).toBe("50");
	});
	it("puts lon,lat,alt in the Point", () => {
		const c = tagText(kml, "coordinates")?.split(",").map(Number) ?? [];
		expect(c).toHaveLength(3);
		expect(c[0]).toBeCloseTo(m.lon, 8);
		expect(c[2]).toBeCloseTo(m.altMsl, 5);
	});
	it("defaults href to files/<image> and name to the photo id", () => {
		expect(tagText(kml, "href")).toBe("files/IMG_7131.jpg");
		expect(kml).toContain("<name>IMG_7131</name>");
	});
	it("stamps the capture time only when known", () => {
		expect(kml).toContain("<when>2023-07-01T10:20:30Z</when>");
		expect(buildPhotoOverlayKml(SOUTH)).not.toContain("TimeStamp");
	});
	it("escapes user-supplied text and honours options", () => {
		const k = buildPhotoOverlayKml(FIXTURE, {
			name: "Mt <A> & B",
			description: "5 < 6",
			href: "a b&c.jpg",
			near: 12.5,
		});
		parseXml(k);
		expect(k).toContain("<name>Mt &lt;A&gt; &amp; B</name>");
		expect(tagText(k, "href")).toBe("a b&amp;c.jpg");
		expect(tagText(k, "near")).toBe("12.5");
		expect(tagText(k, "description")).toBe("5 &lt; 6");
	});
	it("wraps a yaw past north into [0, 360)", () => {
		const k = buildPhotoOverlayKml({
			...FIXTURE,
			pose: { ...FIXTURE.pose, yaw: -0.0000001 },
		});
		expect(tagText(k, "heading")).toBe("0");
	});
	it("accepts a prebuilt model", () => {
		expect(buildPhotoOverlayKml(m)).toBe(kml);
	});
});

describe("buildKmz", () => {
	const jpeg = Uint8Array.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
	const files = readZip(buildKmz(FIXTURE, jpeg));
	it("holds doc.kml first, then the image", () => {
		expect(files.map((f) => f.name)).toEqual(["doc.kml", "files/IMG_7131.jpg"]);
	});
	it("doc.kml references the packaged image path", () => {
		const kml = new TextDecoder().decode(files[0].data);
		parseXml(kml);
		expect(tagText(kml, "href")).toBe(files[1].name);
	});
	it("carries the JPEG bytes unchanged", () => {
		expect(Array.from(files[1].data)).toEqual(Array.from(jpeg));
		expect(files[1].crc).toBe(crc32(jpeg));
	});
	it("ignores a caller href (the layout is fixed)", () => {
		const f = readZip(buildKmz(FIXTURE, jpeg, { name: "x" }));
		expect(new TextDecoder().decode(f[0].data)).toContain(
			"<href>files/IMG_7131.jpg</href>",
		);
	});
});

describe("kmzBlob", () => {
	it("has the KMZ mime type and the same length", () => {
		const b = kmzBlob(new Uint8Array(10));
		expect(b.type).toBe("application/vnd.google-earth.kmz");
		expect(b.size).toBe(10);
	});
});
