// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { seededRandom, uniform } from "#/test/helpers";
import {
	bounds,
	CAPS_MAX,
	type DeclutterItem,
	declutterNames,
	displayText,
	dupOfPeak,
	fontString,
	nameScore,
	nameType,
	PEAK_CLASSES,
	padRect,
	type Rect,
	rangeOpacity,
	reachOk,
	rectsHit,
	textPath,
	textWidth,
	uncertainOpacity,
	uncertainPrefix,
} from "../labels/names";
import {
	buildTierIndex,
	classicTier,
	decorateCandidates,
	resolvePeakClass,
	tierHint,
} from "../labels/peakTiers";
import type { TerroirName, TerroirPack } from "../types";

const rect = (x0: number, y0: number, x1: number, y1: number): Rect => ({
	x0,
	y0,
	x1,
	y1,
});

describe("rects", () => {
	it("rectsHit is symmetric, strict at touching edges and padded", () => {
		const a = rect(0, 0, 10, 10);
		expect(rectsHit(a, rect(5, 5, 15, 15))).toBe(true);
		expect(rectsHit(a, rect(10, 0, 20, 10))).toBe(false);
		expect(rectsHit(a, rect(10, 0, 20, 10), 1)).toBe(true);
		expect(rectsHit(rect(5, 5, 15, 15), a)).toBe(true);
	});
	it("bounds and padRect", () => {
		expect(
			bounds([
				{ x: 1, y: 5 },
				{ x: -2, y: 3 },
				{ x: 4, y: 9 },
			]),
		).toEqual(rect(-2, 3, 4, 9));
		expect(padRect(rect(0, 0, 2, 2), 1)).toEqual(rect(-1, -1, 3, 3));
	});
});

describe("reach and opacity", () => {
	it("reach 'all' always passes, 'near' caps a ridge at 8 km and a peak never", () => {
		expect(reachOk("ridge", 50000, "all")).toBe(true);
		expect(reachOk("ridge", 9000, "near")).toBe(false);
		expect(reachOk("ridge", 7000, "near")).toBe(true);
		expect(reachOk("peak", 90000, "near")).toBe(true);
		expect(reachOk("village", 16000, "near")).toBe(false);
	});
	it("rangeOpacity is 1 up close, falls monotonically, floor 0.6", () => {
		expect(rangeOpacity(5)).toBe(1);
		let prev = 1;
		for (let d = 0; d <= 200; d += 5) {
			const o = rangeOpacity(d);
			expect(o).toBeLessThanOrEqual(prev);
			prev = o;
		}
		expect(rangeOpacity(500)).toBe(0.6);
	});
	it("uncertainOpacity runs 0.75 to 0.40 between 5 and 45 km; far peaks get a ≈", () => {
		expect(uncertainOpacity(0)).toBe(0.75);
		expect(uncertainOpacity(100)).toBe(0.4);
		expect(uncertainPrefix(10)).toBe("");
		expect(uncertainPrefix(25)).toBe("≈ ");
	});
});

describe("dupOfPeak", () => {
	const peaks = [
		{
			name: "Niederhorn",
			world: [1000, 2000, 1500] as [number, number, number],
		},
	];
	it("catches any peak within the near radius and the same name within 2 km", () => {
		expect(dupOfPeak("Foo", [1100, 2000, 0], peaks)).toBe(true);
		expect(dupOfPeak("Foo", [1500, 2000, 0], peaks)).toBe(false);
		expect(dupOfPeak("NIEDERHORN", [2500, 2000, 0], peaks)).toBe(true);
		expect(dupOfPeak("Niederhörn", [2500, 2000, 0], peaks)).toBe(true); // accents fold
		expect(dupOfPeak("Niederhorn", [9000, 2000, 0], peaks)).toBe(false);
		expect(dupOfPeak("Foo", [1100, 2000, 0], peaks, 0)).toBe(false);
	});
});

describe("nameType / text metrics", () => {
	it("scales size by the class and falls back to 'other'", () => {
		expect(nameType("peak-major", 12).px).toBeCloseTo(15, 9);
		expect(nameType("peak", 12).px).toBe(12);
		expect(nameType("nonsense" as never, 12).px).toBeGreaterThan(0);
		expect(nameType("massif", 10).upper).toBe(true);
		expect(nameType("massif", 10).trackPx).toBeGreaterThan(0);
	});
	it("displayText uppercases only spaced-caps classes; fontString includes italics", () => {
		const caps = nameType("massif", 10);
		const plain = nameType("peak", 10);
		expect(displayText("Alpstein", caps)).toBe("ALPSTEIN");
		expect(displayText("Alpstein", plain)).toBe("Alpstein");
		expect(fontString({ ...plain, italic: true }, "X", 2)).toMatch(
			/^italic 600 20\.00px X$/,
		);
	});
	it("textWidth adds letter spacing after every glyph", () => {
		const t = nameType("massif", 10);
		const w = textWidth("ab", t, "X", () => 20);
		expect(w).toBeCloseTo(20 + 2 * t.trackPx, 9);
	});
	it("nameScore: higher priority, bigger area, nearer, centred and kept all score higher", () => {
		const base = nameScore({ cls: "lake", areaKm2: 1 }, 10, 0.5, false);
		expect(
			nameScore({ cls: "peak-major", areaKm2: 1 }, 10, 0.5, false),
		).toBeGreaterThan(base);
		expect(
			nameScore({ cls: "lake", areaKm2: 50 }, 10, 0.5, false),
		).toBeGreaterThan(base);
		expect(nameScore({ cls: "lake", areaKm2: 1 }, 40, 0.5, false)).toBeLessThan(
			base,
		);
		expect(
			nameScore({ cls: "lake", areaKm2: 1 }, 10, 1, false),
		).toBeGreaterThan(base);
		expect(nameScore({ cls: "lake", areaKm2: 1 }, 10, 0.5, true)).toBeCloseTo(
			base + 40,
			9,
		);
	});
});

describe("declutterNames", () => {
	const item = (
		id: string,
		score: number,
		rects: Rect[],
		tags?: string[],
	): DeclutterItem<string> => ({
		id,
		score,
		rects,
		data: id,
		tags,
	});
	const o = { width: 200, height: 100, max: 10 };
	it("takes the higher score and falls to the alternative when the first is taken", () => {
		const out = declutterNames(
			[
				item("lo", 1, [rect(10, 10, 50, 30), rect(10, 50, 50, 70)]),
				item("hi", 9, [rect(10, 10, 50, 30)]),
			],
			[],
			o,
		);
		expect(out.map((x) => [x.item.id, x.alt])).toEqual([
			["hi", 0],
			["lo", 1],
		]);
	});
	it("drops items outside the stage or on an obstacle, and honours max", () => {
		const out = declutterNames(
			[
				item("edge", 5, [rect(-5, 10, 20, 30)]),
				item("blocked", 4, [rect(60, 10, 90, 30)]),
				item("a", 3, [rect(100, 10, 120, 20)], ["caps"]),
				item("b", 2, [rect(130, 10, 150, 20)], ["caps"]),
				item("c", 1, [rect(160, 10, 180, 20)]),
			],
			[rect(55, 5, 95, 35)],
			o,
		);
		expect(out.map((x) => x.item.id)).toEqual(["a", "b", "c"]);
		expect(
			declutterNames(
				[
					item("a", 1, [rect(0 + 5, 5, 20, 20)]),
					item("b", 0, [rect(100, 5, 120, 20)]),
				],
				[],
				{ ...o, max: 1 },
			),
		).toHaveLength(1);
		expect(CAPS_MAX).toBeGreaterThan(0);
	});
	// BUG: declutterNames reads `used[tag]` against `limits` but never increments it, so the per-tag
	// caps (CAPS_MAX / MASSIF_MAX under reach "near") are never enforced.
	it.fails("enforces per-tag limits", () => {
		const out = declutterNames(
			[
				item("a", 3, [rect(100, 10, 120, 20)], ["caps"]),
				item("b", 2, [rect(130, 10, 150, 20)], ["caps"]),
				item("c", 1, [rect(160, 10, 180, 20)]),
			],
			[],
			{ ...o, limits: { caps: 1 } },
		);
		expect(out.map((x) => x.item.id)).toEqual(["a", "c"]);
	});
	it("never places overlapping rects on random input", () => {
		const rand = seededRandom(21);
		const items = Array.from({ length: 60 }, (_, i) => {
			const x = uniform(rand, 0, 180);
			const y = uniform(rand, 0, 80);
			return item(`i${i}`, rand(), [
				rect(x, y, x + 25, y + 10),
				rect(x, y + 12, x + 25, y + 22),
			]);
		});
		const out = declutterNames(items, [], o);
		for (let i = 0; i < out.length; i++)
			for (let j = i + 1; j < out.length; j++)
				expect(rectsHit(out[i].rect, out[j].rect, 3)).toBe(false);
	});
});

describe("textPath", () => {
	const line = [
		{ x: 0, y: 0 },
		{ x: 100, y: 0 },
		{ x: 200, y: 10 },
	];
	it("is null for short, single-point or sharply turning paths", () => {
		expect(textPath([{ x: 0, y: 0 }], 50)).toBeNull();
		expect(
			textPath(
				[
					{ x: 0, y: 0 },
					{ x: 20, y: 0 },
				],
				10,
			),
		).toBeNull();
		expect(
			textPath(
				[
					{ x: 0, y: 0 },
					{ x: 50, y: 0 },
					{ x: 50, y: 50 },
					{ x: 0, y: 50 },
				],
				100,
			),
		).toBeNull();
	});
	it("returns a centred sub-polyline of the requested arc length, left to right", () => {
		const p = textPath(line, 100);
		expect(p).not.toBeNull();
		if (!p) return;
		let len = 0;
		for (let i = 1; i < p.length; i++)
			len += Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y);
		expect(len).toBeCloseTo(100, 6);
		expect(p[0].x).toBeLessThan(p[p.length - 1].x);
		expect((p[0].x + p[p.length - 1].x) / 2).toBeCloseTo(100, 0);
	});
	it("reverses a right-to-left path", () => {
		const p = textPath([...line].reverse(), 100);
		expect(p?.[0].x).toBeLessThan(p?.[p.length - 1].x ?? 0);
	});
});

describe("peak tiers", () => {
	const mk = (
		name: string,
		cls: TerroirName["cls"],
		lat: number,
		lon: number,
	): TerroirName => ({
		name,
		cls,
		lat,
		lon,
		ele: 2000,
		lang: null,
		status: null,
		src: "swissnames3d",
	});
	const pack = {
		names: [
			mk("Niederhorn", "peak-major", 46.7, 7.8),
			mk("Niederhorn", "peak-minor", 46.9, 7.9),
			mk("Bödeli", "peak", 46.6, 7.7),
			mk("Thunersee", "lake", 46.7, 7.7),
		],
	} as unknown as TerroirPack;
	const idx = buildTierIndex(pack);
	it("indexes only peak classes by accent-folded name; null pack gives null", () => {
		expect(buildTierIndex(null)).toBeNull();
		expect(idx?.get("niederhorn")).toHaveLength(2);
		expect(idx?.get("bodeli")).toHaveLength(1);
		expect(idx?.has("thunersee")).toBe(false);
	});
	it("resolvePeakClass prefers prominence, then the nearest same-name entry within range, then elevation", () => {
		expect(
			resolvePeakClass(idx, { name: "X", ele: 2000, prominence: 700 }, null),
		).toBe("peak-major");
		expect(
			resolvePeakClass(
				idx,
				{ name: "Niederhorn", ele: 1000 },
				{ lat: 46.9005, lon: 7.9 },
			),
		).toBe("peak-minor");
		expect(
			resolvePeakClass(
				idx,
				{ name: "Niederhorn", ele: 1000 },
				{ lat: 46.7, lon: 7.8 },
			),
		).toBe("peak-major");
		// far from every entry: elevation fallback
		expect(
			resolvePeakClass(
				idx,
				{ name: "Niederhorn", ele: 400 },
				{ lat: 10, lon: 10 },
			),
		).toBe(resolvePeakClass(null, { name: "Niederhorn", ele: 400 }, null));
		// no geo: a unique name matches, an ambiguous one does not
		expect(resolvePeakClass(idx, { name: "Bödeli", ele: 100 }, null)).toBe(
			"peak",
		);
		expect(resolvePeakClass(idx, { name: "Niederhorn", ele: 100 }, null)).toBe(
			resolvePeakClass(null, { name: "Niederhorn", ele: 100 }, null),
		);
	});
	it("tierHint maps classes to layout tiers with a size ratio, classicTier to scale and weight", () => {
		expect(tierHint("peak-major").tier).toBe(0);
		expect(tierHint("peak").tier).toBe(1);
		expect(tierHint("peak-minor").tier).toBe(2);
		expect(tierHint("peak-major").sizeMul).toBeCloseTo(1.25 / 1.14, 9);
		expect(tierHint("peak").sizeMul).toBe(1);
		expect(classicTier("peak-major")).toEqual({ scale: 1.25, weight: 700 });
		expect(PEAK_CLASSES.has("peak")).toBe(true);
	});
	it("decorateCandidates adds tier hints and the ≈ prefix without touching ids", () => {
		const cands = [
			{ id: "a", name: "Eiger", distKm: 30 },
			{ id: "b", name: "Mönch", distKm: 5 },
		];
		const out = decorateCandidates(
			cands,
			["peak-major", "peak-minor"],
			(l) => l as never,
			true,
		);
		expect(out.map((c) => c.name)).toEqual(["≈ Eiger", "Mönch"]);
		expect(out.map((c) => c.id)).toEqual(["a", "b"]);
		expect(out[0].tierHint).toBe(0);
		expect(out[1].tierHint).toBe(2);
		const plain = decorateCandidates(cands, [1, 2], null, false);
		expect(plain[0]).toEqual(cands[0]);
	});
});
