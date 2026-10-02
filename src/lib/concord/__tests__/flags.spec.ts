// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { withFlags } from "#/test/helpers";
import {
	CONCORD_FLAGS,
	concordFlags,
	concordOn,
	parseConcordFlags,
} from "../flags";

describe("concord flags", () => {
	it("are all off by default", () => {
		expect(concordFlags()).toEqual({ eye: false, occl: false });
		expect(concordOn("eye")).toBe(false);
	});

	it("parseConcordFlags reads a csv from a query string and ignores unknown names", () => {
		expect(parseConcordFlags("?concord=eye,occl")).toEqual({
			eye: true,
			occl: true,
		});
		expect(parseConcordFlags("?x=1&concord=occl,bogus")).toEqual({
			eye: false,
			occl: true,
		});
		expect(parseConcordFlags("")).toEqual({ eye: false, occl: false });
	});

	it("returns frozen records keyed by every CONCORD_FLAGS entry", () => {
		const f = parseConcordFlags("?concord=eye");
		expect(Object.keys(f).sort()).toEqual([...CONCORD_FLAGS].sort());
		expect(Object.isFrozen(f)).toBe(true);
	});

	it("follows the per-realm override", () => {
		withFlags({ concord: "eye" });
		expect(concordOn("eye")).toBe(true);
		expect(concordOn("occl")).toBe(false);
		expect(concordFlags().eye).toBe(true);
	});
});
