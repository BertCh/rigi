// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { crc32, zipStore } from "../zip";
import { readZip } from "./fixtures";

describe("crc32", () => {
	it("matches the standard check value", () => {
		expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
	});
	it("is 0 for empty input", () => {
		expect(crc32(new Uint8Array(0))).toBe(0);
	});
	it("can be continued across chunks", () => {
		const a = new TextEncoder().encode("12345");
		const b = new TextEncoder().encode("6789");
		expect(crc32(b, crc32(a))).toBe(0xcbf43926);
	});
});

describe("zipStore", () => {
	it("round-trips names, bytes and CRCs in order", () => {
		const bin = Uint8Array.from({ length: 300 }, (_, i) => (i * 7) & 255);
		const zip = zipStore([
			{ name: "doc.kml", data: "<kml/>" },
			{ name: "files/ü.jpg", data: bin },
		]);
		const r = readZip(zip);
		expect(r.map((e) => e.name)).toEqual(["doc.kml", "files/ü.jpg"]);
		expect(new TextDecoder().decode(r[0].data)).toBe("<kml/>");
		expect(Array.from(r[1].data)).toEqual(Array.from(bin));
		for (const e of r) expect(e.crc).toBe(crc32(e.data));
	});
	it("writes an empty archive as just the end record", () => {
		const zip = zipStore([]);
		expect(zip.length).toBe(22);
		expect(new DataView(zip.buffer).getUint32(0, true)).toBe(0x06054b50);
	});
	it("sets the UTF-8 flag and stores (method 0)", () => {
		const zip = zipStore([{ name: "a", data: "x" }]);
		const dv = new DataView(zip.buffer);
		expect(dv.getUint16(6, true)).toBe(0x0800);
		expect(dv.getUint16(8, true)).toBe(0);
	});
	it("encodes the entry date as DOS date/time", () => {
		const zip = zipStore([
			{ name: "a", data: "x", date: new Date(2024, 4, 17, 13, 45, 30) },
		]);
		const dv = new DataView(zip.buffer);
		const time = dv.getUint16(10, true);
		const date = dv.getUint16(12, true);
		expect(time).toBe((13 << 11) | (45 << 5) | 15);
		expect(date).toBe(((2024 - 1980) << 9) | (5 << 5) | 17);
	});
	it("clamps years before 1980", () => {
		const zip = zipStore([
			{ name: "a", data: "x", date: new Date(1970, 0, 1) },
		]);
		expect(new DataView(zip.buffer).getUint16(12, true) >> 9).toBe(0);
	});
});
