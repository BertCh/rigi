// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { seededRandom, uniform } from "#/test/helpers";
import {
	candidatesFrom,
	canvasMeasure,
	eleSuffix,
	formatEle,
	type LabelCandidate,
	type LayoutKind,
	labelFontEpoch,
	labelsOverlap,
	layoutLabels,
	type PlacedLabel,
	prevIsCurrent,
	SLOT_ROW,
	skylineAt,
	stampFontEpoch,
	subscribeLabelFonts,
	tierFonts,
} from "../labels/layout";

const W = 1200;
const H = 800;

function scene(seed: number, n = 30): LabelCandidate[] {
	const rand = seededRandom(seed);
	return Array.from({ length: n }, (_, i) => ({
		id: `p${i}`,
		name: `Peak ${String.fromCharCode(65 + (i % 26))}orn`,
		ele: Math.round(uniform(rand, 1500, 4200)),
		prominence: rand() < 0.5 ? Math.round(rand() * 900) : null,
		distKm: uniform(rand, 2, 90),
		x: uniform(rand, 30, W - 30),
		y: uniform(rand, 250, 500),
		visible: rand() < 0.9,
	}));
}

describe("typography helpers", () => {
	it("tierFonts: major tier is biggest and boldest, elevation text 80 percent", () => {
		const t0 = tierFonts(0, 14);
		const t1 = tierFonts(1, 14);
		const t2 = tierFonts(2, 14);
		expect(t0.size).toBeGreaterThan(t1.size);
		expect(t1.size).toBeGreaterThan(t2.size);
		expect(t0.weight).toBe(700);
		expect(t1.eleSize).toBeCloseTo(t1.size * 0.8, 9);
		expect(t1.name).toBe(
			"600 14.00px Fira Sans, ui-sans-serif, system-ui, sans-serif",
		);
		expect(tierFonts(1, 10, "Serif").ele).toBe("400 8.00px Serif");
	});
	it("formatEle / eleSuffix hide unknown elevations and a name that is the number", () => {
		expect(formatEle(null)).toBe("");
		expect(formatEle(1234.6)).toBe("1235");
		expect(eleSuffix({ name: "Eiger", ele: 3967 })).toBe("3967");
		expect(eleSuffix({ name: "3967", ele: 3967 })).toBe("");
		expect(eleSuffix({ name: "Eiger", ele: null })).toBe("");
	});
});

describe("skylineAt / candidatesFrom", () => {
	it("skylineAt finds the first terrain row from the top for both buffer layouts", () => {
		const w = 2;
		const h = 4;
		// deck layout: row 0 = top, one float, infinity = sky
		const deck = Float32Array.from([
			Number.POSITIVE_INFINITY,
			Number.POSITIVE_INFINITY,
			Number.POSITIVE_INFINITY,
			300,
			100,
			100,
			100,
			100,
		]);
		const s = skylineAt(deck, w, h, {
			rowsTopDown: true,
			stride: 1,
			channel: 0,
		});
		expect(Array.from(s)).toEqual([0.5, 0.25]);
		// three layout: RGBA, row 0 = bottom, range in alpha
		const three = new Float32Array(w * h * 4);
		three[(0 * w + 0) * 4 + 3] = 50; // bottom row, column 0
		expect(Array.from(skylineAt(three, w, h))).toEqual([0.75, 1]);
	});
	it("candidatesFrom scales u, v to px and samples the skyline per column", () => {
		const peaks = [
			{
				name: "A",
				ele: 3000,
				distKm: 5,
				u: 0.25,
				v: 0.5,
				world: [10, 0, 0] as [number, number, number],
			},
			{
				name: "B",
				ele: null,
				prominence: 100,
				distKm: 9,
				u: 1,
				v: 0.1,
				world: [20, 0, 0] as [number, number, number],
			},
		];
		const sky = Float32Array.from([0.2, 0.4, 0.6, 0.8]);
		const c = candidatesFrom(peaks, W, H, sky);
		expect(c[0].x).toBe(300);
		expect(c[0].y).toBe(400);
		expect(c[0].id).toBe("A|10");
		expect(c[0].prominence).toBeNull();
		expect(c[0].skylineY).toBeCloseTo(0.4 * H, 4);
		expect(c[1].skylineY).toBeCloseTo(0.8 * H, 4); // clamped to the last column
		expect(candidatesFrom(peaks, W, H)[0].skylineY).toBeUndefined();
	});
});

describe("layoutLabels invariants", () => {
	const skyline = new Float32Array(256).fill(0.45);
	for (const style of ["panorama", "inline"] as LayoutKind[])
		describe(style, () => {
			const opts = {
				width: W,
				height: H,
				fontPx: 14,
				style,
				skyline,
				maxLabels: 20,
			};
			for (const seed of [1, 2, 3]) {
				const cands = scene(seed);
				const placed = layoutLabels(cands, opts);
				it(`seed ${seed}: bounded, visible-only, in frame, no overlapping text boxes`, () => {
					expect(placed.length).toBeLessThanOrEqual(20);
					expect(placed.length).toBeGreaterThan(0);
					const visible = new Set(
						cands.filter((c) => c.visible).map((c) => c.id),
					);
					for (const p of placed) {
						expect(visible.has(p.id)).toBe(true);
						expect(p.opacity).toBeGreaterThan(0);
						expect(p.opacity).toBeLessThanOrEqual(1);
						expect([0, 1, 2]).toContain(p.tier);
						expect(p.textW).toBeGreaterThan(0);
						expect(p.quad).toHaveLength(4);
					}
					for (let i = 0; i < placed.length; i++)
						for (let j = i + 1; j < placed.length; j++)
							expect(labelsOverlap(placed[i], placed[j])).toBe(false);
					expect(new Set(placed.map((p) => p.id)).size).toBe(placed.length);
				});
			}
			it("is deterministic and keeps labels stable under a 2 px nudge with prev", () => {
				const cands = scene(7);
				const a = layoutLabels(cands, opts);
				expect(layoutLabels(cands, opts).map((p) => p.id)).toEqual(
					a.map((p) => p.id),
				);
				const nudged = cands.map((c) => ({ ...c, x: c.x + 2 }));
				const b = layoutLabels(nudged, opts, a);
				const keep = a.filter((p) =>
					b.some((q) => q.id === p.id && q.row === p.row),
				);
				expect(keep.length).toBeGreaterThanOrEqual(Math.floor(a.length * 0.8));
			});
			it("places nothing for no candidates or only hidden ones", () => {
				expect(layoutLabels([], opts)).toEqual([]);
				expect(
					layoutLabels(
						scene(1).map((c) => ({ ...c, visible: false })),
						opts,
					),
				).toEqual([]);
			});
		});

	it("inline slots use rows from SLOT_ROW and panorama rotates text up to the angle", () => {
		const cands = scene(4, 12);
		const inline = layoutLabels(cands, {
			width: W,
			height: H,
			fontPx: 14,
			style: "inline",
		});
		for (const p of inline) expect(p.row).toBeGreaterThanOrEqual(SLOT_ROW);
		const pano = layoutLabels(cands, {
			width: W,
			height: H,
			fontPx: 14,
			style: "panorama",
			angle: 50,
			skyline,
		});
		for (const p of pano) expect(p.rotation).toBeLessThanOrEqual(0);
		const flat = layoutLabels(cands, {
			width: W,
			height: H,
			fontPx: 14,
			style: "panorama",
			angle: 0,
			skyline,
		});
		for (const p of flat) expect(p.rotation).toBeCloseTo(0, 9);
	});
	it("a tierHint overrides the rank tier and sizeMul grows the box", () => {
		const base: LabelCandidate = {
			id: "x",
			name: "Alpha",
			ele: 2000,
			prominence: 100,
			distKm: 10,
			x: 600,
			y: 500,
			visible: true,
		};
		const opts = { width: W, height: H, fontPx: 14, style: "inline" as const };
		const hinted = layoutLabels([{ ...base, tierHint: 2 }], opts)[0];
		expect(hinted.tier).toBe(2);
		const normal = layoutLabels([base], opts)[0];
		const bigger = layoutLabels([{ ...base, sizeMul: 1.5 }], opts)[0];
		expect(bigger.textW).toBeGreaterThan(normal.textW);
	});
	it("a custom measure drives the box width", () => {
		const base: LabelCandidate = {
			id: "x",
			name: "Alpha",
			ele: null,
			prominence: null,
			distKm: 10,
			x: 600,
			y: 500,
			visible: true,
		};
		const narrow = layoutLabels([base], {
			width: W,
			height: H,
			fontPx: 14,
			style: "inline",
			measure: () => 10,
		})[0];
		const wide = layoutLabels([base], {
			width: W,
			height: H,
			fontPx: 14,
			style: "inline",
			measure: () => 200,
		})[0];
		expect(wide.textW).toBeGreaterThan(narrow.textW);
	});
});

describe("font epoch plumbing", () => {
	it("prevIsCurrent accepts unknown or same-epoch layouts, and stampFontEpoch records the epoch", () => {
		expect(prevIsCurrent(undefined)).toBe(true);
		expect(prevIsCurrent([])).toBe(true);
		const p: PlacedLabel[] = [];
		expect(stampFontEpoch(p)).toBe(p);
		expect(prevIsCurrent(p)).toBe(true);
		expect(labelFontEpoch()).toBeGreaterThanOrEqual(0);
	});
	it("subscribeLabelFonts returns an unsubscribe", () => {
		const off = subscribeLabelFonts(() => {});
		expect(typeof off).toBe("function");
		off();
	});
	it("canvasMeasure falls back to the approximation without a document, bold wider, longer wider", () => {
		const a = canvasMeasure("Eiger", "400 14px X");
		expect(a).toBeGreaterThan(0);
		expect(canvasMeasure("Eigerhorn", "400 14px X")).toBeGreaterThan(a);
		expect(canvasMeasure("Eiger", "700 14px X")).toBeGreaterThan(a);
		expect(canvasMeasure("Eiger", "400 28px X")).toBeCloseTo(a * 2, 9);
		expect(canvasMeasure("", "400 14px X")).toBe(0);
	});
});
