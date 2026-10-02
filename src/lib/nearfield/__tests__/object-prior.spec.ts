// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import {
	googleTilesPublicUseAllowed,
	isMeasurableSource,
	TILES3D_SOURCES,
} from "../../tiles3d/config";
import {
	applyObjectPrior,
	assertMeasurableSources,
	type ObjectPriorInput,
} from "../object-prior";
import { type NearFieldDepth, PixelClass } from "../types";

const K = { fx: 1, fy: 1, cx: 0.5, cy: 0.5 };
// a row of cells; model z-depth 100 m everywhere (anchor scale 1, ray factor ~1 near the centre)
function make(
	cls: PixelClass[],
	over: Partial<ObjectPriorInput> = {},
): ObjectPriorInput {
	const n = cls.length;
	const counts = [0, 0, 0, 0, 0];
	for (const c of cls) counts[c]++;
	const depth: NearFieldDepth = {
		width: n,
		height: 1,
		depth: new Float32Array(n).fill(100),
		valid: new Uint8Array(n).fill(1),
		model: "test",
		seconds: 0,
	};
	return {
		split: { width: n, height: 1, cls: Uint8Array.from(cls), counts },
		depth,
		anchor: { scale: 1, shift: 0 },
		K,
		demGrid: new Float32Array(n).fill(100),
		objectHeight: new Float32Array(n).fill(8),
		sources: ["ndsm", "swisstopo-buildings"],
		...over,
	};
}

describe("object prior (T2)", () => {
	it("promotes Far and Terrain cells explained by a measured object", () => {
		const r = applyObjectPrior(make([PixelClass.Far, PixelClass.Terrain]));
		expect([...r.split.cls]).toEqual([PixelClass.Object, PixelClass.Object]);
		expect(r.promotedFromFar).toBe(1);
		expect(r.promotedFromTerrain).toBe(1);
		expect(r.split.counts[PixelClass.Object]).toBe(2);
		expect(r.split.counts[PixelClass.Far]).toBe(0);
	});
	it("never touches Sky, Unknown, Object", () => {
		const cls = [
			PixelClass.Sky,
			PixelClass.Unknown,
			PixelClass.Object,
			PixelClass.Object,
		];
		const r = applyObjectPrior(make(cls));
		expect([...r.split.cls]).toEqual(cls);
	});
	it("needs height >= threshold, a DEM within the cap, and range agreement", () => {
		const input = make(
			[PixelClass.Far, PixelClass.Far, PixelClass.Far, PixelClass.Far],
			{
				objectHeight: Float32Array.from([1, 8, 8, 8]),
				demGrid: Float32Array.from([100, 500, 100, Number.NaN]),
			},
		);
		input.depth.depth[2] = 300;
		const r = applyObjectPrior(input);
		expect([...r.split.cls]).toEqual([
			PixelClass.Far,
			PixelClass.Far,
			PixelClass.Far,
			PixelClass.Far,
		]);
		expect(r.rejectedDisagree).toBe(1);
	});
	it("nDSM height alone does not promote; a tile range can stand in for the model", () => {
		const base = make([PixelClass.Far]);
		base.depth.valid[0] = 0;
		expect(applyObjectPrior(base).split.cls[0]).toBe(PixelClass.Far);
		const withTile = { ...base, tileRange: Float32Array.from([102]) };
		expect(applyObjectPrior(withTile).split.cls[0]).toBe(PixelClass.Object);
		const badTile = { ...base, tileRange: Float32Array.from([160]) };
		expect(applyObjectPrior(badTile).split.cls[0]).toBe(PixelClass.Far);
	});
	it("does not mutate its input", () => {
		const input = make([PixelClass.Far]);
		applyObjectPrior(input);
		expect(input.split.cls[0]).toBe(PixelClass.Far);
	});
});

describe("licence gate", () => {
	it("Google is display-only and can never feed the split", () => {
		expect(TILES3D_SOURCES.google.displayOnly).toBe(true);
		expect(isMeasurableSource("google")).toBe(false);
		expect(() => assertMeasurableSources(["ndsm", "google"])).toThrow(
			/display-only/,
		);
		const input = make([PixelClass.Far], { sources: ["google"] });
		expect(() => applyObjectPrior(input)).toThrow();
		expect(input.split.cls[0]).toBe(PixelClass.Far);
	});
	it("every non-display-only registry source is measurable; unknown ids are not", () => {
		for (const s of Object.values(TILES3D_SOURCES))
			expect(isMeasurableSource(s.id)).toBe(!s.displayOnly);
		expect(isMeasurableSource("ndsm")).toBe(true);
		expect(isMeasurableSource("osm")).toBe(false);
	});
	it("Google public use is gated on the logo; dev is allowed", () => {
		expect(
			googleTilesPublicUseAllowed({ dev: false, logoPresent: false }),
		).toBe(false);
		expect(googleTilesPublicUseAllowed({ dev: false, logoPresent: true })).toBe(
			true,
		);
		expect(googleTilesPublicUseAllowed({ dev: true, logoPresent: false })).toBe(
			true,
		);
	});
});
