// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import {
	type ExifPhotoMeta,
	parseAppleGravity,
	withDisplayPixels,
} from "../photo-meta";

/** Builds a minimal Apple MakerNote with one AccelerationVector entry. */
function makeNote(
	g: [number, number, number],
	tag = 0x0008,
	type = 10,
	count = 3,
) {
	const buf = new Uint8Array(200);
	const dv = new DataView(buf.buffer);
	buf.set(new TextEncoder().encode("Apple iOS"), 0);
	dv.setUint16(14, 1);
	dv.setUint16(16, tag);
	dv.setUint16(18, type);
	dv.setUint32(20, count);
	dv.setUint32(24, 100);
	g.forEach((v, k) => {
		dv.setInt32(100 + 8 * k, Math.round(v * 1_000_000));
		dv.setInt32(100 + 8 * k + 4, 1_000_000);
	});
	return buf;
}

describe("parseAppleGravity", () => {
	it("reads three signed rationals", () => {
		const g = parseAppleGravity(makeNote([-0.98, 0.01, -0.2]));
		expect(g).toBeDefined();
		expect(g?.[0]).toBeCloseTo(-0.98, 6);
		expect(g?.[1]).toBeCloseTo(0.01, 6);
		expect(g?.[2]).toBeCloseTo(-0.2, 6);
	});
	it("honours a subarray's byteOffset", () => {
		const inner = makeNote([0.5, 0.25, -0.75]);
		const outer = new Uint8Array(inner.length + 13);
		outer.set(inner, 13);
		expect(parseAppleGravity(outer.subarray(13))?.[0]).toBeCloseTo(0.5, 6);
	});
	it("returns undefined for a non-Apple header", () => {
		const n = makeNote([1, 0, 0]);
		n[0] = 0x58;
		expect(parseAppleGravity(n)).toBeUndefined();
	});
	it("returns undefined when the tag is absent or malformed", () => {
		expect(parseAppleGravity(makeNote([1, 0, 0], 0x0009))).toBeUndefined();
		expect(parseAppleGravity(makeNote([1, 0, 0], 0x0008, 5))).toBeUndefined();
		expect(
			parseAppleGravity(makeNote([1, 0, 0], 0x0008, 10, 2)),
		).toBeUndefined();
	});
	it("does not read past a truncated entry table", () => {
		const n = makeNote([1, 0, 0], 0x0009);
		new DataView(n.buffer).setUint16(14, 5000);
		expect(parseAppleGravity(n)).toBeUndefined();
	});
});

describe("withDisplayPixels", () => {
	const meta: ExifPhotoMeta = { width: 4032, height: 3024, orientation: 1 };
	it("keeps width/height for upright photos", () => {
		const m = withDisplayPixels(meta, 4000, 3000);
		expect([m.width, m.height]).toEqual([4000, 3000]);
	});
	it("converts a displayed size back to stored (swapped) for rotated photos", () => {
		const m = withDisplayPixels({ ...meta, orientation: 6 }, 3000, 4000);
		expect([m.width, m.height]).toEqual([4000, 3000]);
	});
	it("does not mutate the input and preserves other fields", () => {
		const input = { ...meta, model: "iPhone", focal35: 26 };
		const m = withDisplayPixels(input, 10, 20);
		expect(input.width).toBe(4032);
		expect(m.model).toBe("iPhone");
		expect(m.focal35).toBe(26);
	});
});
