// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { seededRandom } from "#/test/helpers";
import {
	decodeFieldRGBA8,
	encodeFieldRGBA8,
	invertField,
	sampleField,
	ZERO_FIELD,
} from "../field";
import type { ResidualField } from "../types";

/** A smooth field on a w x h grid: W(u, v) = (a sin(2 pi v), b cos(2 pi u)). */
function smooth(w: number, h: number, a: number, b: number): ResidualField {
	const f = ZERO_FIELD(w, h);
	for (let j = 0; j < h; j++)
		for (let i = 0; i < w; i++) {
			f.du[j * w + i] = a * Math.sin(2 * Math.PI * ((j + 0.5) / h));
			f.dv[j * w + i] = b * Math.cos(2 * Math.PI * ((i + 0.5) / w));
		}
	return f;
}

describe("ZERO_FIELD", () => {
	it("is all zero with an empty provenance", () => {
		const f = ZERO_FIELD(4, 3);
		expect(f.du).toHaveLength(12);
		expect(Array.from(f.du).every((x) => x === 0)).toBe(true);
		expect(f.provenance.sources).toEqual([]);
	});
});

describe("sampleField", () => {
	const f = ZERO_FIELD(2, 2);
	f.du.set([0, 1, 2, 3]);
	f.dv.set([10, 10, 10, 10]);
	it("returns the cell value at cell centres and interpolates between them", () => {
		expect(sampleField(f, 0.25, 0.25)[0]).toBe(0);
		expect(sampleField(f, 0.75, 0.25)[0]).toBe(1);
		expect(sampleField(f, 0.5, 0.25)[0]).toBeCloseTo(0.5, 12);
		expect(sampleField(f, 0.5, 0.5)[0]).toBeCloseTo(1.5, 12);
		expect(sampleField(f, 0.5, 0.5)[1]).toBe(10);
	});
	it("clamps outside the outermost cell centres", () => {
		expect(sampleField(f, -5, -5)[0]).toBe(0);
		expect(sampleField(f, 9, 9)[0]).toBe(3);
	});
	it("reproduces a linear field exactly in the interior", () => {
		const g = ZERO_FIELD(8, 8);
		for (let j = 0; j < 8; j++)
			for (let i = 0; i < 8; i++)
				g.du[j * 8 + i] = 2 * ((i + 0.5) / 8) - (j + 0.5) / 8;
		const [du] = sampleField(g, 0.43, 0.61);
		expect(du).toBeCloseTo(2 * 0.43 - 0.61, 6);
	});
});

describe("invertField", () => {
	it("composes with the forward field to ~identity", () => {
		const f = smooth(24, 24, 0.01, 0.008);
		const inv = invertField(f);
		let worst = 0;
		for (const [u, v] of [
			[0.3, 0.3],
			[0.5, 0.7],
			[0.62, 0.41],
			[0.2, 0.8],
		]) {
			// render = photo + W(photo); photo = render + Winv(render)
			const [wu, wv] = sampleField(f, u, v);
			const [iu, iv] = sampleField(inv, u + wu, v + wv);
			worst = Math.max(worst, Math.abs(wu + iu), Math.abs(wv + iv));
		}
		expect(worst).toBeLessThan(5e-4);
	});
	it("inverts a constant shift to its negative and records provenance", () => {
		const f = ZERO_FIELD(6, 6);
		f.du.fill(0.02);
		f.dv.fill(-0.01);
		const inv = invertField(f);
		// interior cells (edge cells see clamped samples but a constant field is the same everywhere)
		expect(inv.du[14]).toBeCloseTo(-0.02, 6);
		expect(inv.dv[14]).toBeCloseTo(0.01, 6);
		expect(inv.provenance.sources).toContain("inverse");
	});
	it("does not mutate the source field's provenance", () => {
		const f = smooth(8, 8, 0.01, 0.01);
		invertField(f);
		expect(f.provenance.sources).toEqual([]);
	});
});

describe("RGBA8 field codec", () => {
	it("round-trips within the 16-bit quantisation step", () => {
		const rand = seededRandom(7);
		const f = ZERO_FIELD(10, 6);
		for (let k = 0; k < 60; k++) {
			f.du[k] = (rand() - 0.5) * 0.04;
			f.dv[k] = (rand() - 0.5) * 0.04;
		}
		const { data, scale } = encodeFieldRGBA8(f);
		expect(data).toHaveLength(60 * 4);
		const { du, dv } = decodeFieldRGBA8(data, scale, 10, 6);
		const tol = (2 * scale) / 65535;
		for (let k = 0; k < 60; k++) {
			expect(Math.abs(du[k] - f.du[k])).toBeLessThanOrEqual(tol);
			expect(Math.abs(dv[k] - f.dv[k])).toBeLessThanOrEqual(tol);
		}
	});
	it("uses the max absolute component as scale", () => {
		const f = ZERO_FIELD(2, 1);
		f.du.set([0.01, -0.03]);
		expect(encodeFieldRGBA8(f).scale).toBeCloseTo(0.03, 7);
	});
	it("encodes an all-zero field to ~zero with a positive scale", () => {
		const { data, scale } = encodeFieldRGBA8(ZERO_FIELD(3, 3));
		expect(scale).toBeGreaterThan(0);
		const { du, dv } = decodeFieldRGBA8(data, scale, 3, 3);
		for (const x of [...du, ...dv]) expect(Math.abs(x)).toBeLessThan(1e-9);
	});
	it("saturates extremes to the byte range", () => {
		const f = ZERO_FIELD(2, 1);
		f.du.set([1, -1]);
		const { data } = encodeFieldRGBA8(f);
		expect([data[0], data[1]]).toEqual([255, 255]);
		expect([data[4], data[5]]).toEqual([0, 0]);
	});
});
