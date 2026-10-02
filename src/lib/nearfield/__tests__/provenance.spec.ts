// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import {
	filterForExport,
	isMeasurable,
	PROVENANCE_COLORS,
	PROVENANCE_COLORS_BY_CODE,
	provenanceOf,
	SPLAT_PROVENANCE_COLORS,
	selectSplats,
} from "../provenance";
import { type GaussianCloud, PROVENANCE_CODE } from "../types";

function cloud(codes: number[], withSource = false): GaussianCloud {
	const n = codes.length;
	const c: GaussianCloud = {
		count: n,
		frame: "enu",
		positions: Float32Array.from({ length: 3 * n }, (_, i) => i),
		scales: Float32Array.from({ length: 3 * n }, (_, i) => 100 + i),
		rotations: Float32Array.from({ length: 4 * n }, (_, i) => 200 + i),
		colors: Uint8Array.from({ length: 4 * n }, (_, i) => i % 256),
		provenance: Uint8Array.from(codes),
	};
	if (withSource) c.source = Uint16Array.from(codes.map((_, i) => 10 + i));
	return c;
}

describe("provenance codes", () => {
	it("round-trips every code and rejects unknown ones", () => {
		for (const [name, code] of Object.entries(PROVENANCE_CODE))
			expect(provenanceOf(code)).toBe(name);
		expect(provenanceOf(99)).toBeNull();
	});
	it("only generated and unknown codes are non-measurable", () => {
		expect(isMeasurable(PROVENANCE_CODE.observed)).toBe(true);
		expect(isMeasurable(PROVENANCE_CODE.reconstructed)).toBe(true);
		expect(isMeasurable(PROVENANCE_CODE.dem)).toBe(true);
		expect(isMeasurable(PROVENANCE_CODE.generated)).toBe(false);
		expect(isMeasurable(200)).toBe(false);
	});
	it("colour tables are indexed by code and normalised to 0..1", () => {
		for (const [name, code] of Object.entries(PROVENANCE_CODE)) {
			expect(PROVENANCE_COLORS_BY_CODE[code]).toEqual(
				PROVENANCE_COLORS[name as keyof typeof PROVENANCE_COLORS],
			);
			for (const [k, v] of PROVENANCE_COLORS_BY_CODE[code].entries())
				expect(SPLAT_PROVENANCE_COLORS[code][k]).toBeCloseTo(v / 255, 12);
		}
	});
});

describe("filterForExport / selectSplats", () => {
	it("removes generated and unknown splats and keeps every per-splat attribute aligned", () => {
		const src = cloud([0, 3, 1, 9, 2], true);
		const out = filterForExport(src);
		expect(out.count).toBe(3);
		expect([...out.provenance]).toEqual([0, 1, 2]);
		expect([...(out.source ?? [])]).toEqual([10, 12, 14]);
		expect([...out.positions.subarray(3, 6)]).toEqual([6, 7, 8]); // source splat 2
		expect([...out.rotations.subarray(0, 4)]).toEqual([200, 201, 202, 203]);
		expect([...out.colors.subarray(8, 12)]).toEqual([16, 17, 18, 19]);
		expect(out.frame).toBe("enu");
	});
	it("returns fresh arrays even when nothing is removed", () => {
		const src = cloud([0, 1]);
		const out = filterForExport(src);
		expect(out.positions).not.toBe(src.positions);
		expect(out.positions).toEqual(src.positions);
		expect(out.source).toBeUndefined();
	});
	it("an all-generated cloud filters to empty", () => {
		expect(filterForExport(cloud([3, 3])).count).toBe(0);
	});
	it("selectSplats follows the index order (reorders and repeats)", () => {
		const out = selectSplats(cloud([0, 1, 2]), [2, 0, 2]);
		expect([...out.provenance]).toEqual([2, 0, 2]);
		expect([...out.positions]).toEqual([6, 7, 8, 0, 1, 2, 6, 7, 8]);
	});
});
