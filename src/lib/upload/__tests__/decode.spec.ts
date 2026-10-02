// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it, vi } from "vitest";
import { contentHash, isHeif, isJpeg } from "../decode";

const ftyp = (brand: string, size = 24, extra: string[] = []) => {
	const b = new Uint8Array(32);
	new DataView(b.buffer).setUint32(0, size);
	b.set(new TextEncoder().encode("ftyp"), 4);
	for (const [i, s] of [brand, "\0\0\0\0", ...extra].entries())
		b.set(new TextEncoder().encode(s), 8 + i * 4);
	return b;
};

describe("isHeif", () => {
	it("recognises HEIC/HEIF/AVIF brands", () => {
		for (const brand of ["heic", "heix", "mif1", "avif", "hevc"])
			expect(isHeif(ftyp(brand))).toBe(true);
	});
	it("finds a compatible brand after an unknown major brand", () => {
		expect(isHeif(ftyp("isom", 24, ["mif1"]))).toBe(true);
	});
	it("rejects other ISO-BMFF files, short buffers and non-ftyp data", () => {
		expect(isHeif(ftyp("isom", 16))).toBe(false);
		expect(isHeif(ftyp("mp42", 16))).toBe(false);
		expect(isHeif(new Uint8Array(8))).toBe(false);
		expect(
			isHeif(
				Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...new Array(20).fill(0)]),
			),
		).toBe(false);
	});
	it("only scans inside the declared box size", () => {
		expect(isHeif(ftyp("isom", 12, ["mif1"]))).toBe(false);
	});
	it("works on a subarray with a byte offset", () => {
		const inner = ftyp("heic");
		const padded = new Uint8Array(40);
		padded.set(inner, 8);
		expect(isHeif(padded.subarray(8))).toBe(true);
	});
});

describe("isJpeg", () => {
	it("checks the SOI + marker prefix", () => {
		expect(isJpeg(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(true);
		expect(isJpeg(Uint8Array.from([0xff, 0xd8, 0xfe, 0xe0]))).toBe(false);
		expect(isJpeg(Uint8Array.from([0xff, 0xd8, 0xff]))).toBe(false);
		expect(isJpeg(new Uint8Array(0))).toBe(false);
	});
});

describe("contentHash", () => {
	it("is a 10 hex char SHA-256 prefix where crypto.subtle exists", async () => {
		const h = await contentHash(new TextEncoder().encode("abc"));
		expect(h).toBe("ba7816bf8f"); // sha256("abc") = ba7816bf 8f01cfea ...
	});
	it("is deterministic and content-sensitive", async () => {
		const a = await contentHash(Uint8Array.from([1, 2, 3]));
		expect(await contentHash(Uint8Array.from([1, 2, 3]))).toBe(a);
		expect(await contentHash(Uint8Array.from([1, 2, 4]))).not.toBe(a);
	});
	it("falls back to a prefixed FNV hash without crypto.subtle", async () => {
		vi.stubGlobal("crypto", {});
		const a = await contentHash(Uint8Array.from([1, 2, 3]));
		expect(a).toMatch(/^f[0-9a-f]{9}$/);
		expect(await contentHash(Uint8Array.from([1, 2, 3]))).toBe(a);
		expect(await contentHash(Uint8Array.from([1, 2, 4]))).not.toBe(a);
		expect(await contentHash(new Uint8Array(0))).toMatch(/^f[0-9a-f]{9}$/);
	});
	it("the fallback keeps ids distinct from SHA ids (prefix f + 9 hex vs 10 hex)", async () => {
		vi.stubGlobal("crypto", {});
		const fb = await contentHash(Uint8Array.from([9]));
		expect(fb).toHaveLength(10);
		expect(fb.startsWith("f")).toBe(true);
	});
});
