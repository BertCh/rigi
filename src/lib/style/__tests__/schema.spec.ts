// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { CLASSIC } from "../defaults";
import { isPresetId, presetStyle } from "../presets";
import { RAMPS } from "../ramps";
import {
	diffStyle,
	mergeStyle,
	pruneOverrides,
	validateStyle,
} from "../schema";
import type { DeepPartial, ViewStyle } from "../types";

const deepFreeze = <T>(o: T): T => {
	if (o && typeof o === "object") {
		Object.freeze(o);
		for (const v of Object.values(o)) deepFreeze(v);
	}
	return o;
};

describe("CLASSIC", () => {
	it("is a fixed point of validateStyle", () => {
		expect(validateStyle(CLASSIC)).toEqual(CLASSIC);
	});
	it("validateStyle of garbage returns the fallback", () => {
		for (const junk of [null, 42, "x", [], undefined, { terrain: 5 }])
			expect(validateStyle(junk)).toEqual(CLASSIC);
	});
});

describe("mergeStyle", () => {
	it("applies valid leaves and leaves the base untouched", () => {
		const base = deepFreeze(structuredClone(CLASSIC));
		const out = mergeStyle(base, { terrain: { ambient: 0.5 } });
		expect(out.terrain.ambient).toBe(0.5);
		expect(base.terrain.ambient).toBe(CLASSIC.terrain.ambient);
		expect(out.terrain.direct).toBe(CLASSIC.terrain.direct);
	});
	it("clamps numbers to the schema range and rounds integer fields", () => {
		const out = mergeStyle(CLASSIC, {
			terrain: { ambient: 99 },
			overlay: { contours: { majorEvery: 3.6 } },
		} as DeepPartial<ViewStyle>);
		expect(out.terrain.ambient).toBe(2);
		expect(out.overlay.contours.majorEvery).toBe(4);
		const lo = mergeStyle(CLASSIC, { terrain: { ambient: -4 } });
		expect(lo.terrain.ambient).toBe(0);
	});
	it("ignores wrong types, NaN, bad hex and unknown keys", () => {
		const out = mergeStyle(CLASSIC, {
			terrain: {
				ambient: Number.NaN,
				direct: "loud",
				hazeColor: "blue",
				bogus: 1,
			},
			nonsense: { a: 1 },
		} as unknown as DeepPartial<ViewStyle>);
		expect(out).toEqual(CLASSIC);
		expect("nonsense" in out).toBe(false);
	});
	it("lowercases hex colours", () => {
		const out = mergeStyle(CLASSIC, { terrain: { hazeColor: "#ABCDEF" } });
		expect(out.terrain.hazeColor).toBe("#abcdef");
	});
	it("replaces tuples wholesale and rejects wrong-length ones", () => {
		const ok = mergeStyle(CLASSIC, {
			overlay: { ridges: { inner: [0, 0, 0] } },
		});
		expect(ok.overlay.ridges.inner).toEqual([0, 0, 0]);
		const bad = mergeStyle(CLASSIC, {
			overlay: { ridges: { inner: [0, 0] } },
		} as unknown as DeepPartial<ViewStyle>);
		expect(bad.overlay.ridges.inner).toEqual(CLASSIC.overlay.ridges.inner);
	});
	it("accepts ramp names and valid literal ramps, rejects malformed ones", () => {
		const named = mergeStyle(CLASSIC, { terrain: { reliefRamp: "viridis" } });
		expect(named.terrain.reliefRamp).toBe("viridis");
		const lit = {
			kind: "stops",
			stops: [
				{ t: 0, c: "#000000" },
				{ t: 1, c: "#FFFFFF", ease: "smooth" },
			],
		} as const;
		const withLit = mergeStyle(CLASSIC, {
			terrain: { reliefRamp: lit },
		} as unknown as DeepPartial<ViewStyle>);
		expect(withLit.terrain.reliefRamp).toEqual({
			kind: "stops",
			stops: [
				{ t: 0, c: "#000000" },
				{ t: 1, c: "#ffffff", ease: "smooth" },
			],
		});
		const badRamps: unknown[] = [
			"not-a-ramp",
			{ kind: "stops", stops: [{ t: 0, c: "#000000" }] },
			{
				kind: "stops",
				stops: [
					{ t: 0.5, c: "#000000" },
					{ t: 0.2, c: "#ffffff" },
				],
			},
			{
				kind: "stops",
				stops: [
					{ t: 0, c: "red" },
					{ t: 1, c: "#ffffff" },
				],
			},
			{
				kind: "stops",
				stops: Array.from({ length: 9 }, (_, i) => ({
					t: i / 8,
					c: "#000000",
				})),
			},
		];
		for (const r of badRamps) {
			const out = mergeStyle(CLASSIC, {
				terrain: { reliefRamp: r },
			} as unknown as DeepPartial<ViewStyle>);
			expect(out.terrain.reliefRamp).toBe(CLASSIC.terrain.reliefRamp);
		}
		expect(RAMPS.cool.kind).toBe("stops");
	});
	it("switches discriminated unions cleanly and keeps variant fields", () => {
		const out = mergeStyle(CLASSIC, {
			terrain: { sun: { mode: "azel", azimuthDeg: 90, elevationDeg: 30 } },
		});
		expect(out.terrain.sun).toEqual({
			mode: "azel",
			azimuthDeg: 90,
			elevationDeg: 30,
		});
		// no stale `dir` from the previous variant
		expect("dir" in out.terrain.sun).toBe(false);
	});
	it("an invalid union tag keeps the base variant", () => {
		const out = mergeStyle(CLASSIC, {
			terrain: { sun: { mode: "moon" } },
		} as unknown as DeepPartial<ViewStyle>);
		expect(out.terrain.sun).toEqual(CLASSIC.terrain.sun);
	});
	// BUG: union tags are looked up with `in`, so "constructor" / "toString" pass as variants.
	it.fails("inherited object keys are not accepted as a union tag", () => {
		const out = mergeStyle(CLASSIC, {
			terrain: { sun: { mode: "constructor" } },
		} as unknown as DeepPartial<ViewStyle>);
		expect(out.terrain.sun).toEqual(CLASSIC.terrain.sun);
	});
	it("nullable and litOr nodes accept their literal", () => {
		const out = mergeStyle(CLASSIC, {
			overlay: { bands: { lines: "contours" } },
		} as DeepPartial<ViewStyle>);
		expect(out.overlay.bands.lines).toBe("contours");
	});
	it("applies several partials left to right", () => {
		const out = mergeStyle(CLASSIC, { terrain: { ambient: 0.1 } }, undefined, {
			terrain: { ambient: 0.2, direct: 0.3 },
		});
		expect(out.terrain.ambient).toBe(0.2);
		expect(out.terrain.direct).toBe(0.3);
	});
});

describe("pruneOverrides", () => {
	it("returns {} for junk and for nothing valid", () => {
		for (const v of [
			null,
			undefined,
			3,
			"x",
			[],
			{},
			{ terrain: { bogus: 1 } },
		])
			expect(pruneOverrides(v)).toEqual({});
	});
	it("keeps only valid, clamped parts", () => {
		const out = pruneOverrides({
			terrain: { ambient: 7, direct: "no", hazeColor: "#ABCDEF" },
			zzz: 1,
		});
		expect(out.terrain?.hazeColor).toBe("#abcdef");
		expect(out.terrain?.ambient).toBe(2);
		expect(out.terrain && "direct" in out.terrain).toBe(false);
		expect("zzz" in out).toBe(false);
	});
	it("drops the version field", () => {
		expect(pruneOverrides({ v: 1 })).toEqual({});
	});
	it("is idempotent", () => {
		const once = pruneOverrides({
			terrain: { ambient: 7, sun: { mode: "azel", azimuthDeg: 400 } },
			labels: { maxLabels: 3.4 },
		});
		expect(pruneOverrides(once)).toEqual(once);
	});
});

describe("diffStyle", () => {
	it("is {} for equal styles", () => {
		expect(diffStyle(CLASSIC, structuredClone(CLASSIC))).toEqual({});
	});
	it("is the minimal partial and round-trips through mergeStyle", () => {
		const target = mergeStyle(CLASSIC, {
			terrain: {
				ambient: 0.4,
				sun: { mode: "azel", azimuthDeg: 10, elevationDeg: 20 },
			},
			labels: { maxLabels: 9 },
		});
		const d = diffStyle(CLASSIC, target);
		expect(Object.keys(d).sort()).toEqual(["labels", "terrain"]);
		expect(Object.keys(d.terrain ?? {}).sort()).toEqual(["ambient", "sun"]);
		expect(mergeStyle(CLASSIC, d)).toEqual(target);
	});
	it("round-trips for every preset against classic", () => {
		for (const id of [
			"minimal",
			"night",
			"swiss",
			"terroir",
			"field-sketch",
		] as const) {
			const p = presetStyle(id);
			expect(mergeStyle(CLASSIC, diffStyle(CLASSIC, p)), id).toEqual(p);
		}
	});
});

describe("isPresetId (smoke)", () => {
	it("is false for junk", () => {
		expect(isPresetId("nope")).toBe(false);
	});
});
