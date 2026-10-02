// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { LIBHEIF_URL } from "../decode";
import { LGPL_TEXT, LIBHEIF_FILE_URL, THIRD_PARTY } from "../licenses";

describe("third-party notices", () => {
	it("lists libheif and libde265 under the LGPL with a source link", () => {
		expect(THIRD_PARTY.map((n) => n.name.split(" ")[0])).toEqual([
			"libheif",
			"libde265",
		]);
		for (const n of THIRD_PARTY) {
			expect(n.license).toBe("LGPL-3.0");
			expect(n.source).toMatch(/^https:\/\/github\.com\/strukturag\//);
			expect(n.version).toBeTruthy();
			expect(n.note).toBeTruthy();
		}
	});
	it("ships the licence text itself", () => {
		expect(LGPL_TEXT).toMatch(/GNU LESSER GENERAL PUBLIC LICENSE/i);
		expect(LGPL_TEXT.length).toBeGreaterThan(10_000);
	});
	it("points at the same replaceable libheif file the decoder loads", () => {
		expect(LIBHEIF_FILE_URL).toBe(LIBHEIF_URL);
		expect(LIBHEIF_FILE_URL).toMatch(/libheif/);
	});
});
